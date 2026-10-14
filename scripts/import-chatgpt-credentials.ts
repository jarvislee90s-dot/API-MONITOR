/**
 * ChatGPT 凭据一次性导入脚本（需用户真实环境执行）
 *
 * 1. 读取 ~/.codex/auth.json（Codex CLI 登录产物），提取 accessToken / refreshToken / accountId；
 * 2. 复用项目专用浏览器 Profile（output/chatgpt-browser-profile，已 gitignore）打开 chatgpt.com，
 *    已登录则提取 __Secure-next-auth.session-token，未登录等待人工 Google 登录（不自动化登录）；
 * 3. 用 accessToken 试调一次 codex rate_limits，成功才继续；
 * 4. AES-GCM 加密凭据，按 provider_key=chatgpt + account_label=默认账号 upsert 到 Supabase；
 * 5. --check 干跑：只读取与校验，不写库。
 *
 * 使用：
 *   node --experimental-strip-types scripts/import-chatgpt-credentials.ts --check
 *   node --experimental-strip-types scripts/import-chatgpt-credentials.ts [--skip-browser] [--auth-json <路径>]
 *
 * 安全：auth.json 与 cookie 仅在内存中转，不复制进项目目录、不进 git；输出只打印脱敏 hint。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const PROFILE_DIR = resolve(process.cwd(), "output/chatgpt-browser-profile");
const CHATGPT_HOME = "https://chatgpt.com";
const CODEX_RATE_LIMITS_URL = "https://chatgpt.com/backend-api/codex/rate_limits";
const LOGIN_WAIT_MS = 300_000;

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

// 从专用 Profile 提取 chatgpt.com 的 __Secure-next-auth.session-token；未登录则等待人工登录
async function extractSessionToken(): Promise<string | null> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    console.log(`[INFO] 打开 ${CHATGPT_HOME} ...`);
    await page.goto(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4_000);

    const readToken = async (): Promise<string | null> => {
      const cookies = await context.cookies("https://chatgpt.com");
      const token = cookies.find((cookie) => cookie.name === "__Secure-next-auth.session-token");
      return token?.value ?? null;
    };

    // 页面无 "Log in" 入口且已拿到 cookie → 已登录
    const immediate = await readToken();
    const loginButtons = await page.locator("text=Log in").count();
    if (immediate && loginButtons === 0) return immediate;

    console.log("");
    console.log("═════════════════════════════════════════════════");
    console.log("  请在打开的浏览器窗口中完成 Google 登录（脚本不自动化登录）");
    console.log(`  登录成功后自动继续，最长等待 ${LOGIN_WAIT_MS / 1000} 秒`);
    console.log("═════════════════════════════════════════════════");
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      const token = await readToken();
      if (token) return token;
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
  console.log(credResp.ok ? "[OK] 加密凭据已写入 provider_account_credentials" : `[WARN] 加密凭据写入失败: HTTP ${credResp.status}`);

  // 4. 同步脱敏 hint 与账号状态
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
  const authJsonIndex = args.indexOf("--auth-json");
  const authJsonPath =
    authJsonIndex >= 0 && args[authJsonIndex + 1]
      ? resolve(args[authJsonIndex + 1]!)
      : resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".codex/auth.json");

  const env = loadEnv();

  const codex = readCodexAuthJson(authJsonPath);
  if (!codex) {
    console.error(`[FAIL] 未读取到 Codex 凭据：${authJsonPath} 缺少 tokens.access_token（请先在 Codex CLI 登录）`);
    process.exit(1);
  }
  console.log(`[OK] auth.json 已读取（accessToken ${maskHint(codex.accessToken)}）`);

  let sessionToken: string | null = null;
  if (skipBrowser) {
    console.warn("[WARN] --skip-browser：跳过网页 session cookie 提取");
  } else {
    sessionToken = await extractSessionToken();
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

  await upsertChatgptAccountCredentials(env, credentials);
  console.log("\n━━━ 完成 ━━━");
  console.log("看板下次刷新即使用新凭据；Codex token 过期后由 Worker 自动刷新。");
  console.log("session cookie 约 30 天有效，过期后重新运行本脚本（第二期提供续期脚本）。");
}

main().catch((err) => {
  console.error("[FAIL] 脚本执行失败:", err);
  process.exit(1);
});
