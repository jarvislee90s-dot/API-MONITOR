/**
 * ChatGPT 凭据一次性导入脚本（需用户真实环境执行）
 *
 * 1. 读取 ~/.codex/auth.json（Codex CLI 登录产物），提取 accessToken / refreshToken / accountId；
 * 2. 复用项目专用浏览器 Profile（output/chatgpt-browser-profile，已 gitignore）打开 chatgpt.com，
 *    已登录则提取 __Secure-next-auth.session-token 并调 /api/auth/session 验证服务端仍认可，
 *    未登录（含 Profile 残留已被服务端失效的死 cookie）时等待人工 Google 登录（不自动化登录）；
 * 3. 用 accessToken 试调一次 codex rate_limits，成功才继续；
 * 4. AES-GCM 加密凭据，按 provider_key=chatgpt + account_label=默认账号 upsert 到 Supabase；
 * 5. --check 干跑：只读取与校验，不写库。
 *
 * 使用：
 *   node --experimental-strip-types scripts/import-chatgpt-credentials.ts --check
 *   node --experimental-strip-types scripts/import-chatgpt-credentials.ts [--skip-browser] [--auth-json <路径>]
 *
 *   --relogin：进入浏览器后先清除 Profile 中的旧 cookie，再走登录检测/等待（换账号或 cookie 污染时使用）。
 *
 * 网络与凭据说明：
 *   - 检测到 Windows 系统代理（或 HTTPS_PROXY）时自动以 NODE_USE_ENV_PROXY=1 重启自身，使 Node fetch 走代理；
 *   - NextAuth 的 session token 超过单 cookie 上限会分片存储（.0/.1），脚本收集分片、
 *     按浏览器原样形态（name.0=v0; name.1=v1）存入 Supabase，Worker 侧原样回发；
 *   - 登录与否的唯一判定信号是服务端 /api/auth/session 验证，不做任何页面 DOM 选择器假设。
 *
 * 安全：auth.json 与 cookie 仅在内存中转，不复制进项目目录、不进 git；输出只打印脱敏 hint。
 * --check 干跑只读取与校验，不写库，也不依赖 .env（Supabase 配置仅在真正写入前加载）。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright";

const PROFILE_DIR = resolve(process.cwd(), "output/chatgpt-browser-profile");
const CHATGPT_HOME = "https://chatgpt.com";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const AUTH_SESSION_URL = "https://chatgpt.com/api/auth/session";
const LOGIN_WAIT_MS = 300_000;
// 与真实浏览器一致的 UA，避免服务端接口按自动化 UA 拒绝
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function loadEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    throw new Error("未找到 .env（需要 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CREDENTIAL_ENCRYPTION_KEY / SUPABASE_USER_ID）");
  }
  const vars: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

type CodexAuthJson = {
  tokens?: { access_token?: string; refresh_token?: string; account_id?: string };
  account_id?: string;
};

function readCodexAuthJson(path: string): {
  accessToken: string;
  refreshToken: string | null;
  accountId: string | null;
} | null {
  if (!existsSync(path)) return null;
  let raw: CodexAuthJson;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as CodexAuthJson;
  } catch {
    return null;
  }
  const accessToken = raw.tokens?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  return {
    accessToken,
    refreshToken: typeof raw.tokens?.refresh_token === "string" ? raw.tokens.refresh_token : null,
    accountId:
      typeof raw.tokens?.account_id === "string"
        ? raw.tokens.account_id
        : typeof raw.account_id === "string"
          ? raw.account_id
          : null,
  };
}

function maskHint(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

// Node 的 fetch 默认不走 Windows 系统代理（国内直连 chatgpt.com 会失败）；
// 检测到可达的系统代理时以 NODE_USE_ENV_PROXY=1 重启自身，让内置 fetch 显式走代理。
// 注意：读注册表必须用 spawnSync 参数数组——execSync 经 cmd.exe 传参会吃掉路径里的反斜杠。
let cachedProxy: string | null | undefined;

function detectProxy(): string | null {
  if (cachedProxy !== undefined) return cachedProxy;
  const fromEnv = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null;
  if (fromEnv) {
    cachedProxy = fromEnv;
    return cachedProxy;
  }
  if (process.platform !== "win32") {
    cachedProxy = null;
    return null;
  }
  try {
    const settingsKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const run = (value: string) =>
      spawnSync("reg", ["query", settingsKey, "/v", value], { encoding: "utf8" });
    const enabled = run("ProxyEnable");
    if (enabled.status !== 0 || !/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enabled.stdout ?? "")) {
      cachedProxy = null;
      return null;
    }
    const server = run("ProxyServer");
    const matched =
      server.status === 0 ? /ProxyServer\s+REG_SZ\s+(\S+)/.exec(server.stdout ?? "") : null;
    cachedProxy = matched
      ? matched[1].startsWith("http")
        ? matched[1]
        : `http://${matched[1]}`
      : null;
    return cachedProxy;
  } catch {
    cachedProxy = null;
    return null;
  }
}

function proxyReachable(proxyUrl: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const url = new URL(proxyUrl);
      const socket = connect(
        { host: url.hostname, port: Number(url.port) || 80, timeout: timeoutMs },
        () => {
          socket.destroy();
          resolve(true);
        },
      );
      socket.on("error", () => resolve(false));
      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

// 返回 true 表示已重启子进程接管执行，当前进程应停在原地等待子进程退出
async function ensureProxyOrRespawn(): Promise<boolean> {
  if (process.env.NODE_USE_ENV_PROXY === "1") return false;
  const proxy = detectProxy();
  if (!proxy) return false;
  if (!(await proxyReachable(proxy))) {
    console.warn(`[WARN] 系统代理 ${proxy} 当前不可达，将直连（请先启动代理软件，或用 HTTPS_PROXY 指定其他地址）`);
    return false;
  }
  console.log(`[INFO] 检测到可达代理 ${proxy}，以 NODE_USE_ENV_PROXY=1 重启自身使 fetch 走代理 ...`);
  const child = spawn(
    process.execPath,
    // argv[1] 是脚本路径，必须保留；respawn 参数 = [node, --experimental-strip-types, 脚本, ...用户参数]
    ["--experimental-strip-types", process.argv[1]!, ...process.argv.slice(2)],
    {
      env: { ...process.env, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: proxy, HTTP_PROXY: proxy },
      stdio: "inherit",
    },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
  return true;
}

// NextAuth 的 session token 超过单 cookie 上限（约 4KB）时会分片存储为 name.0 / name.1 ...，
// 必须收集全部分片按序拼接；向服务端发送与入库均按浏览器原样形态（name.0=v0; name.1=v1）。
function chunkIndex(name: string): number {
  const matched = /\.(\d+)$/.exec(name);
  return matched ? Number(matched[1]) : -1;
}

function buildSessionCookieHeader(cookies: Array<{ name: string; value: string }>): string | null {
  const parts = cookies
    .filter((cookie) => /^__Secure-next-auth\.session-token(\.\d+)?$/.test(cookie.name))
    .sort((a, b) => chunkIndex(a.name) - chunkIndex(b.name));
  if (parts.length === 0) return null;
  return parts.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

// 从专用 Profile 提取 chatgpt.com 的 session cookie；未登录则打开页面等待人工登录。
// 登录判定在浏览器页面内同源请求 /api/auth/session（完整浏览器指纹 + 自动携带 cookie），
// 不做任何页面 DOM 选择器假设；返回页面句柄供后续 codex 校验复用（调用方负责关闭 context）。
type BrowserSession = {
  cookieHeader: string | null;
  page: import("playwright").Page;
  context: import("playwright").BrowserContext;
};

async function extractSessionToken(forceRelogin: boolean): Promise<BrowserSession | null> {
  // 检测到可达代理时显式传给 Chromium，避免依赖（可能残留失效的）系统代理设置
  const proxy = detectProxy();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
    ...(proxy ? { proxy: { server: proxy } } : {}),
  });

  try {
    // --relogin：先清空旧 cookie，避免残留死 session-token 干扰（换账号 / cookie 污染场景）
    if (forceRelogin) {
      await context.clearCookies();
      console.log("[INFO] 已清除 Profile 中的旧 cookie（--relogin）");
    }

    const page = context.pages()[0] ?? (await context.newPage());
    console.log(`[INFO] 打开 ${CHATGPT_HOME} ...`);
    await page.goto(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const readCookieHeader = async (): Promise<string | null> =>
      buildSessionCookieHeader(await context.cookies("https://chatgpt.com"));

    // 登录判定：页面内同源 fetch session 端点，返回非空 accessToken 即服务端认可当前登录态
    const loggedIn = async (): Promise<boolean> => {
      const result = await fetchInPage(page, AUTH_SESSION_URL);
      const body = result?.body as { accessToken?: unknown } | null | undefined;
      return (
        result !== null &&
        result.status === 200 &&
        typeof body?.accessToken === "string" &&
        body.accessToken.length > 0
      );
    };

    console.log("[INFO] 检查登录态 ...");
    await page.waitForTimeout(3_000);
    if (await loggedIn()) {
      const cookieHeader = await readCookieHeader();
      if (cookieHeader) return { cookieHeader, page, context };
    }

    console.log("");
    console.log("═════════════════════════════════════════════════");
    console.log("  请在打开的浏览器窗口中完成 Google 登录（脚本不自动化登录）");
    console.log(`  登录成功后自动继续，最长等待 ${LOGIN_WAIT_MS / 1000} 秒`);
    console.log("═════════════════════════════════════════════════");
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      if (await loggedIn()) {
        const cookieHeader = await readCookieHeader();
        if (cookieHeader) return { cookieHeader, page, context };
      }
      await page.waitForTimeout(2_000);
    }
    console.error(`[FAIL] 登录超时（${LOGIN_WAIT_MS / 1000} 秒）`);
    // 超时仍返回页面句柄：允许仅用 Codex 凭据继续（cookieHeader 为 null）
    return { cookieHeader: null, page, context };
  } catch (error) {
    await context.close();
    throw error;
  }
}

// 页面内同源 fetch：借浏览器完整指纹与 Profile 中的 cf_clearance 绕开 CF 对纯 fetch 的质询
// （实测：代理出口 IP 为数据中心 IP 时，Node fetch 访问 chatgpt.com API 端点会被 403 + cf-mitigated: challenge）
async function fetchInPage(
  page: import("playwright").Page,
  url: string,
  headers?: Record<string, string>,
): Promise<{ status: number; cfMitigated: string | null; body: unknown } | null> {
  return page.evaluate(
    async ({ url, headers }) => {
      try {
        const resp = await fetch(url, { headers, credentials: "include" });
        let body: unknown = null;
        try {
          body = await resp.json();
        } catch {
          body = null;
        }
        return { status: resp.status, cfMitigated: resp.headers.get("cf-mitigated"), body };
      } catch {
        return null;
      }
    },
    { url, headers: headers ?? {} },
  );
}

// 校验 codex token：优先在浏览器页面内同源请求（绕 CF 质询）；--skip-browser 时退回纯 fetch
async function validateCodexToken(
  codex: { accessToken: string; accountId: string | null },
  page?: import("playwright").Page,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${codex.accessToken}`,
    ...(codex.accountId ? { "chatgpt-account-id": codex.accountId } : {}),
  };
  let status: number | null = null;
  let cfMitigated: string | null = null;
  if (page) {
    const result = await fetchInPage(page, CODEX_USAGE_URL, headers);
    if (result) {
      status = result.status;
      cfMitigated = result.cfMitigated;
    }
  } else {
    try {
      const response = await fetch(CODEX_USAGE_URL, { method: "GET", headers });
      status = response.status;
      cfMitigated = response.headers.get("cf-mitigated");
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (status === null) return { ok: false, status: 0, error: "请求失败（页面内与直连 fetch 均未完成）" };
  if (status === 403 && cfMitigated === "challenge") {
    return { ok: false, status, error: `HTTP 403（Cloudflare 质询，请更换代理出口节点后重试）` };
  }
  if (status === 401 || status === 403) {
    return { ok: false, status, error: `HTTP ${status}，token 已失效（请在 Codex CLI 重新登录后再导入）` };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, status, error: `HTTP ${status}` };
  }
  return { ok: true, status };
}

// AES-GCM 加密，与 worker/security/credentials.ts 保持一致
async function encryptPayload(
  payload: Record<string, string>,
  rawKey: string,
): Promise<{ encryptedPayload: string; nonce: string; keyVersion: string }> {
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(rawKey);
  if (keyBytes.byteLength !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be 32 UTF-8 bytes");
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext);
  const bytesToB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
  return {
    encryptedPayload: bytesToB64(new Uint8Array(encrypted)),
    nonce: bytesToB64(nonce),
    keyVersion: "v1",
  };
}

// 按 provider_key=chatgpt + account_label=默认账号 写入加密凭据与脱敏 hint
async function upsertChatgptAccountCredentials(
  env: Record<string, string>,
  credentials: Record<string, string>,
): Promise<void> {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
  const userId = env.SUPABASE_USER_ID;

  if (!supabaseUrl || !serviceRoleKey || !encryptionKey || !userId) {
    console.warn("[WARN] 缺少 Supabase 配置（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CREDENTIAL_ENCRYPTION_KEY / SUPABASE_USER_ID），跳过凭据写入");
    return;
  }

  const accountLabel = "默认账号";
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // 1. 查找账号
  const findUrl = new URL("/rest/v1/provider_accounts", supabaseUrl);
  findUrl.searchParams.set("select", "id");
  findUrl.searchParams.set("user_id", `eq.${userId}`);
  findUrl.searchParams.set("provider_key", "eq.chatgpt");
  findUrl.searchParams.set("account_label", `eq.${accountLabel}`);
  findUrl.searchParams.set("limit", "1");

  const findResp = await fetch(findUrl, { headers });
  if (!findResp.ok) {
    console.warn(`[WARN] 查询 Supabase 账号失败: HTTP ${findResp.status}`);
    return;
  }
  const rows = (await findResp.json()) as Array<{ id: string }>;
  let accountId = rows[0]?.id ?? null;

  // 2. 未找到则创建
  if (!accountId) {
    const createResp = await fetch(new URL("/rest/v1/provider_accounts", supabaseUrl), {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: userId,
        provider_key: "chatgpt",
        display_name: accountLabel,
        account_label: accountLabel,
        source_url: CHATGPT_HOME,
        auth_mode: "configured",
        status: "ready",
      }),
    });
    if (!createResp.ok) {
      console.warn(`[WARN] 创建 Supabase 账号失败: HTTP ${createResp.status}`);
      return;
    }
    const created = (await createResp.json()) as Array<{ id: string }>;
    accountId = created[0]?.id ?? null;
    if (accountId) console.log(`[OK] 已创建 chatgpt 账号（label=${accountLabel}）`);
  }
  if (!accountId) {
    console.warn("[WARN] 无法确定账号 ID，跳过凭据写入");
    return;
  }

  // 3. 加密凭据写入 provider_account_credentials（on_conflict=provider_account_id 覆盖）
  const encrypted = await encryptPayload(credentials, encryptionKey);
  const credUrl = new URL("/rest/v1/provider_account_credentials", supabaseUrl);
  credUrl.searchParams.set("on_conflict", "provider_account_id");
  const credResp = await fetch(credUrl, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      user_id: userId,
      provider_account_id: accountId,
      encrypted_payload: encrypted.encryptedPayload,
      nonce: encrypted.nonce,
      key_version: encrypted.keyVersion,
    }),
  });
  if (!credResp.ok) {
    console.warn(`[WARN] 加密凭据写入失败: HTTP ${credResp.status}`);
    console.warn("[WARN] 凭据未写入，账号状态未变更");
    return;
  }
  console.log("[OK] 加密凭据已写入 provider_account_credentials");

  // 4. 同步脱敏 hint 与账号状态（凭据写入成功才把账号标为 ready）
  const hint = Object.fromEntries(Object.entries(credentials).map(([key, value]) => [key, maskHint(value)]));
  const patchResp = await fetch(new URL(`/rest/v1/provider_accounts?id=eq.${accountId}`, supabaseUrl), {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({ credential_hint: hint, status: "ready", auth_mode: "configured" }),
  });
  console.log(patchResp.ok ? "[OK] 账号 credential_hint 已更新" : `[WARN] hint 更新失败: HTTP ${patchResp.status}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const skipBrowser = args.includes("--skip-browser");
  const forceRelogin = args.includes("--relogin");
  const authJsonIndex = args.indexOf("--auth-json");
  const authJsonPath =
    authJsonIndex >= 0 && args[authJsonIndex + 1]
      ? resolve(args[authJsonIndex + 1]!)
      : resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".codex/auth.json");

  // --check 干跑只读取与校验，不写库，因此不加载 .env（loadEnv 延迟到真正写入前）

  const codex = readCodexAuthJson(authJsonPath);
  if (!codex) {
    console.error(`[FAIL] 未读取到 Codex 凭据：${authJsonPath} 缺少 tokens.access_token（请先在 Codex CLI 登录）`);
    process.exit(1);
  }
  console.log(`[OK] auth.json 已读取（accessToken ${maskHint(codex.accessToken)}）`);

  let browser: Awaited<ReturnType<typeof extractSessionToken>> = null;
  let sessionToken: string | null = null;
  if (skipBrowser) {
    if (forceRelogin) {
      console.warn("[WARN] --relogin 与 --skip-browser 同时传入：未打开浏览器，--relogin 不生效");
    }
    console.warn("[WARN] --skip-browser：跳过网页 session cookie 提取（codex 校验退回直连 fetch，可能被 CF 质询拦截）");
  } else {
    browser = await extractSessionToken(forceRelogin);
    sessionToken = browser?.cookieHeader ?? null;
    if (sessionToken) {
      console.log(`[OK] session cookie 已提取并获服务端认可（${maskHint(sessionToken)}，共 ${sessionToken.length} 字符）`);
    } else {
      console.warn("[WARN] 未提取到 __Secure-next-auth.session-token（可仅用 Codex 凭据继续）");
    }
  }

  try {
    console.log("[INFO] 校验 codex token ...");
    const validation = await validateCodexToken(codex, browser?.page);
    if (!validation.ok) {
      console.error(`[FAIL] codex token 校验失败：${validation.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[OK] codex rate_limits HTTP ${validation.status}`);

    const credentials: Record<string, string> = { accessToken: codex.accessToken };
    if (codex.refreshToken) credentials.refreshToken = codex.refreshToken;
    if (codex.accountId) credentials.accountId = codex.accountId;
    if (sessionToken) credentials.sessionToken = sessionToken;

    if (checkOnly) {
      console.log("\n[--check] 干跑结束，未写入任何数据。将导入的字段：");
      for (const [key, value] of Object.entries(credentials)) {
        console.log(`  ${key} = ${maskHint(value)}`);
      }
      return;
    }

    // 真正写入前才加载 .env（--check 干跑不依赖 Supabase 配置）
    const env = loadEnv();
    await upsertChatgptAccountCredentials(env, credentials);
    console.log("\n━━━ 完成 ━━━");
    console.log("看板下次刷新即使用新凭据；Codex token 过期后由 Worker 自动刷新。");
    console.log("session cookie 约 30 天有效，过期后重新运行本脚本（第二期提供续期脚本）。");
  } finally {
    await browser?.context.close();
  }
}

// 检测到系统代理时上方函数会重启自身接管执行；正常路径才运行 main
if (!(await ensureProxyOrRespawn())) {
  main().catch((err) => {
    console.error("[FAIL] 脚本执行失败:", err);
    process.exit(1);
  });
}
