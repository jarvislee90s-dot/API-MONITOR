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
 * 安全：auth.json 与 cookie 仅在内存中转，不复制进项目目录、不进 git；输出只打印脱敏 hint。
 * --check 干跑只读取与校验，不写库，也不依赖 .env（Supabase 配置仅在真正写入前加载）。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const PROFILE_DIR = resolve(process.cwd(), "output/chatgpt-browser-profile");
const CHATGPT_HOME = "https://chatgpt.com";
const CODEX_RATE_LIMITS_URL = "https://chatgpt.com/backend-api/codex/rate_limits";
const AUTH_SESSION_URL = "https://chatgpt.com/api/auth/session";
const LOGIN_WAIT_MS = 300_000;
// 与真实浏览器一致的 UA，避免服务端接口按自动化 UA 拒绝
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
// 登录入口文案：英文 "Log in" / 中文「登录」均视为未登录
const LOGIN_ENTRY_SELECTOR = "text=/Log in|登录/i";

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

// 校验 session cookie 是否被服务端认可：GET /api/auth/session，响应含非空 accessToken 才算有效。
// 未登录时该接口返回 200 + 空 JSON，因此必须检查 accessToken，不能只看 HTTP 状态码。
async function validateSessionCookie(token: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const resp = await fetch(AUTH_SESSION_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: `__Secure-next-auth.session-token=${token}`,
        "User-Agent": BROWSER_USER_AGENT,
      },
    });
    if (!resp.ok) {
      return { valid: false, error: `HTTP ${resp.status}` };
    }
    const json = (await resp.json().catch(() => null)) as { accessToken?: unknown } | null;
    if (!json || typeof json.accessToken !== "string" || json.accessToken.length === 0) {
      return { valid: false, error: "响应不含 accessToken" };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// 从专用 Profile 提取 chatgpt.com 的 __Secure-next-auth.session-token；未登录则等待人工登录。
// 只会返回通过服务端验证的 cookie：Profile 残留的死 cookie 一律按未登录处理。
async function extractSessionToken(forceRelogin: boolean): Promise<string | null> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
  });

  try {
    // --relogin：先清空旧 cookie，避免残留死 session-token 短路登录检测（换账号 / cookie 污染场景）
    if (forceRelogin) {
      await context.clearCookies();
      console.log("[INFO] 已清除 Profile 中的旧 cookie（--relogin）");
    }

    const page = context.pages()[0] ?? (await context.newPage());
    console.log(`[INFO] 打开 ${CHATGPT_HOME} ...`);
    await page.goto(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4_000);

    const readToken = async (): Promise<string | null> => {
      const cookies = await context.cookies("https://chatgpt.com");
      const token = cookies.find((cookie) => cookie.name === "__Secure-next-auth.session-token");
      return token?.value ?? null;
    };

    // 登录入口检测（快速路径与等待循环共用）：页面仍显示登录入口即视为未登录
    const loginEntry = page.locator(LOGIN_ENTRY_SELECTOR);

    // 快速路径：有 cookie + 页面无登录入口 + 服务端验证通过 → 已登录
    const immediate = await readToken();
    if (immediate && (await loginEntry.count()) === 0) {
      const validation = await validateSessionCookie(immediate);
      if (validation.valid) return immediate;
      console.warn(`[WARN] Profile 残留的 session cookie 已被服务端失效（${validation.error}），按未登录处理`);
    }

    console.log("");
    console.log("═════════════════════════════════════════════════");
    console.log("  请在打开的浏览器窗口中完成 Google 登录（脚本不自动化登录）");
    console.log(`  登录成功后自动继续，最长等待 ${LOGIN_WAIT_MS / 1000} 秒`);
    console.log("═════════════════════════════════════════════════");
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      try {
        const token = await readToken();
        // 接受 cookie 前复评登录入口：页面还显示登录按钮说明 cookie 是残留死值，继续等待人工登录
        if (token && (await loginEntry.count()) === 0) {
          const validation = await validateSessionCookie(token);
          if (validation.valid) return token;
          console.warn(`[WARN] session cookie 服务端验证未通过（${validation.error}），继续等待人工登录`);
        }
      } catch {
        // 人工登录涉及多次跳转，页面导航瞬间 locator 可能暂时失效，下一轮重试
      }
      await page.waitForTimeout(2_000);
    }
    console.error(`[FAIL] 登录超时（${LOGIN_WAIT_MS / 1000} 秒）`);
    return null;
  } finally {
    await context.close();
  }
}

// 校验：用导入的 token 试调 codex rate_limits，成功才落库
async function validateCodexToken(
  accessToken: string,
  accountId: string | null,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const response = await fetch(CODEX_RATE_LIMITS_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      },
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}，token 已失效（请在 Codex CLI 重新登录后再导入）` };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
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

  let sessionToken: string | null = null;
  if (skipBrowser) {
    if (forceRelogin) {
      console.warn("[WARN] --relogin 与 --skip-browser 同时传入：未打开浏览器，--relogin 不生效");
    }
    console.warn("[WARN] --skip-browser：跳过网页 session cookie 提取");
  } else {
    sessionToken = await extractSessionToken(forceRelogin);
    if (sessionToken) {
      console.log(`[OK] session cookie 已提取（${maskHint(sessionToken)}）`);
    } else {
      console.warn("[WARN] 未提取到 __Secure-next-auth.session-token（可仅用 Codex 凭据继续）");
    }
  }

  console.log("[INFO] 校验 codex token ...");
  const validation = await validateCodexToken(codex.accessToken, codex.accountId);
  if (!validation.ok) {
    console.error(`[FAIL] codex token 校验失败：${validation.error}`);
    process.exit(1);
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
}

main().catch((err) => {
  console.error("[FAIL] 脚本执行失败:", err);
  process.exit(1);
});
