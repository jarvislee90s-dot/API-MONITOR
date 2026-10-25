/**
 * Ollama Pro 登录态 Cookie 刷新脚本
 *
 * 功能:复用项目专用浏览器 Profile(output/ollama-browser-profile),从中提取 ollama.com 登录态
 *      cookie,调 settings 页验证可用性后,按"默认账号"写入 Supabase(加密凭据 {authCookie} +
 *      config.authCookie),并同步更新本地 .env 的 OLLAMA_AUTH_COOKIE 与 Cloudflare Worker 的
 *      OLLAMA_AUTH_COOKIE secret,供 Worker 云端直接取数。
 *
 * 前置条件:
 *   1. 已存在登录态:首次运行会打开浏览器窗口,请在其中登录 ollama(之后 Profile 会记住)
 *   2. .env 中已配置 Supabase 凭据(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
 *      CREDENTIAL_ENCRYPTION_KEY / SUPABASE_USER_ID),缺失则仅更新 .env / secret
 *   3. .env 中已配置 CLOUDFLARE_API_TOKEN(缺失则跳过 Worker secret 更新)
 *
 * 使用:
 *   node --experimental-strip-types scripts/refresh-ollama-cookie.ts
 *   node --experimental-strip-types scripts/refresh-ollama-cookie.ts --relogin   # 强制重新登录
 *
 * 背景:Ollama 官方 /api/usage 接口已改为只返回请求数统计,5小时/周额度百分比与模型请求明细
 *      只出现在网页登录态(ollama.com/settings)的服务端渲染 HTML 中,因此需要 cookie 而非 API Key。
 *      Ollama 的网页登录态由 __Secure-session cookie 承载,过期后重新运行本脚本即可。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const PROFILE_DIR = resolve(process.cwd(), "output/ollama-browser-profile");
const SETTINGS_URL = "https://ollama.com/settings";
const REQUIRED_COOKIE_NAMES = ["__Secure-session"];
// 人工登录等待时长(毫秒)
const LOGIN_WAIT_MS = 300_000;

function loadEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), ".env");
  const content = readFileSync(envPath, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
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

// 更新 .env 中指定键的值;不存在的键追加到末尾
function updateEnvKeys(envPath: string, updates: Record<string, string>): void {
  const content = readFileSync(envPath, "utf-8");
  const lines = content.split(/\r?\n/);
  const updated: string[] = [];
  for (const line of lines) {
    const key = line.split("=")[0]?.trim();
    if (key && key in updates) {
      updated.push(`${key}="${updates[key]}"`);
      delete updates[key];
    } else {
      updated.push(line);
    }
  }
  for (const [key, value] of Object.entries(updates)) {
    updated.push(`${key}="${value}"`);
  }
  writeFileSync(envPath, updated.join("\n"), "utf-8");
}

type ExtractedCredential = {
  cookieString: string;
  sessionCookieCount: number;
};

// 从 context 提取 ollama.com 下的登录态 cookie(__Secure-session 是登录凭据)
async function buildCredential(
  context: import("playwright").BrowserContext,
): Promise<ExtractedCredential | null> {
  const cookies = await context.cookies("https://ollama.com");
  const picked = new Map<string, string>();
  for (const cookie of cookies) {
    if (!cookie.domain.includes("ollama.com")) continue;
    // 同名 cookie 可能跨 domain/path 重复,只取第一个
    if (!picked.has(cookie.name)) picked.set(cookie.name, cookie.value);
  }
  if (!REQUIRED_COOKIE_NAMES.some((name) => picked.has(name))) {
    return null;
  }
  const cookieString = [...picked.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  return { cookieString, sessionCookieCount: picked.size };
}

// 校验 cookie:请求 settings 页,HTML 中能解析出额度数据即有效
async function validateCookie(cookieString: string): Promise<{ valid: boolean; usage?: string; error?: string }> {
  try {
    const resp = await fetch(SETTINGS_URL, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/html",
        Cookie: cookieString,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });

    if (resp.status === 401 || resp.status === 403) {
      return { valid: false, error: `HTTP ${resp.status}，登录态无效或已过期` };
    }
    if (resp.status === 303 || resp.status === 302) {
      return { valid: false, error: `HTTP ${resp.status}，被重定向到登录页，登录态已过期` };
    }
    if (!resp.ok) {
      return { valid: false, error: `HTTP ${resp.status}` };
    }

    const html = await resp.text();
    const session = /aria-label="Session usage ([\d.]+)% used"/.exec(html)?.[1];
    const weekly = /aria-label="Weekly usage ([\d.]+)% used"/.exec(html)?.[1];
    if (session === undefined && weekly === undefined) {
      return { valid: false, error: "settings 页未解析出额度数据（页面结构可能变化）" };
    }
    const parts: string[] = [];
    if (session !== undefined) parts.push(`session=${session}%`);
    if (weekly !== undefined) parts.push(`weekly=${weekly}%`);
    return { valid: true, usage: parts.join(", ") };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

// 打开专用 Profile,提取 cookie;未登录时等待人工登录
async function extractCookie(env: Record<string, string>, forceRelogin: boolean): Promise<ExtractedCredential | null> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    if (forceRelogin) {
      await context.clearCookies();
      console.log("[INFO] 已清除旧 cookie(--relogin)");
    }

    console.log(`[INFO] 打开 ${SETTINGS_URL} ...`);
    await page.goto(SETTINGS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4_000);

    // 已在 settings 页且解析到额度数据 → 直接提取
    const isSettings = page.url().startsWith(SETTINGS_URL);
    if (isSettings) {
      const hasUsage = (await page.locator("text=Session usage").count()) > 0;
      if (hasUsage) {
        console.log("✅ 复用已有登录态");
        const credential = await buildCredential(context);
        if (credential) return credential;
        console.warn("[WARN] 页面已登录但未提取到登录态 cookie,尝试重新登录");
      }
    }

    // 未登录:等待人工完成登录
    console.log("");
    console.log("═════════════════════════════════════════════════");
    console.log("  请在打开的浏览器窗口中登录 ollama 账号");
    console.log("  登录后会自动跳回 settings 页,脚本继续");
    console.log(`  (等待最长 ${LOGIN_WAIT_MS / 1000} 秒)`);
    console.log("═════════════════════════════════════════════════");
    console.log("");

    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      const credential = await buildCredential(context);
      if (credential && page.url().startsWith(SETTINGS_URL)) {
        const hasUsage = (await page.locator("text=Session usage").count()) > 0;
        if (hasUsage) {
          console.log("✅ 登录成功,cookie 已提取");
          return credential;
        }
      }
      await page.waitForTimeout(2_000);
    }

    console.error(`❌ 登录超时(${LOGIN_WAIT_MS / 1000} 秒),请重试`);
    return null;
  } finally {
    await context.close();
  }
}

// AES-GCM 加密,与 Worker security/credentials.ts 保持一致
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

// 按 provider_key=ollama + account_label="默认账号" 写入加密凭据与 config 兜底
async function upsertOllamaAccountCredentials(
  env: Record<string, string>,
  authCookie: string,
): Promise<void> {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
  const userId = env.SUPABASE_USER_ID;

  if (!supabaseUrl || !serviceRoleKey || !encryptionKey || !userId) {
    console.warn(
      "[WARN] 缺少 Supabase 配置，跳过数据库凭据更新。.env / Worker secret 已更新，缺 Supabase 时仍可正常工作。",
    );
    return;
  }

  const accountLabel = "默认账号";
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // 1. 按 (user_id, provider_key=ollama, account_label) 查找账号
  let accountId: string | null = null;
  let existingConfig: Record<string, unknown> = {};
  const findUrl = new URL("/rest/v1/provider_accounts", supabaseUrl);
  findUrl.searchParams.set("select", "id,config");
  findUrl.searchParams.set("user_id", `eq.${userId}`);
  findUrl.searchParams.set("provider_key", "eq.ollama");
  findUrl.searchParams.set("account_label", `eq.${accountLabel}`);
  findUrl.searchParams.set("limit", "1");

  try {
    const findResp = await fetch(findUrl, { headers });
    if (!findResp.ok) {
      console.warn(`[WARN] 查询 Supabase 账号失败: HTTP ${findResp.status},跳过凭据写入`);
      return;
    }
    const rows = (await findResp.json()) as Array<{ id: string; config?: Record<string, unknown> }>;
    accountId = rows[0]?.id ?? null;
    existingConfig = (rows[0]?.config ?? {}) as Record<string, unknown>;
  } catch (err) {
    console.warn(`[WARN] 查询 Supabase 账号异常,跳过凭据写入: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 2. 未找到则创建:source_url 为用量页
  if (!accountId) {
    try {
      const createResp = await fetch(new URL("/rest/v1/provider_accounts", supabaseUrl), {
        method: "POST",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({
          user_id: userId,
          provider_key: "ollama",
          display_name: accountLabel,
          account_label: accountLabel,
          source_url: SETTINGS_URL,
          auth_mode: "configured",
          status: "ready",
        }),
      });
      if (createResp.ok) {
        const rows = (await createResp.json()) as Array<{ id: string }>;
        accountId = rows[0]?.id ?? null;
        if (accountId) console.log(`   [OK] 已创建 ollama 账号(label=${accountLabel})`);
      } else {
        console.warn(`[WARN] 创建 Supabase 账号失败: HTTP ${createResp.status}`);
        return;
      }
    } catch (err) {
      console.warn(`[WARN] 创建 Supabase 账号异常,跳过凭据写入: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  if (!accountId) {
    console.warn("[WARN] 无法确定账号 ID，跳过凭据写入");
    return;
  }

  // 3. 写入加密凭据 {authCookie} 到 provider_account_credentials
  try {
    const encrypted = await encryptPayload({ authCookie }, encryptionKey);
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
    if (credResp.ok) {
      console.log("[OK] 加密凭据已写入 provider_account_credentials");
    } else {
      console.warn(`[WARN] 加密凭据写入失败: HTTP ${credResp.status}`);
    }
  } catch (err) {
    console.warn(`[WARN] 加密凭据写入异常: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. 同步更新 config.authCookie + 状态(兼容旧读取路径)
  try {
    const mergedConfig = { ...existingConfig, authCookie };
    const patchResp = await fetch(
      new URL(`/rest/v1/provider_accounts?id=eq.${accountId}`, supabaseUrl),
      {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify({ config: mergedConfig, status: "ready", auth_mode: "configured", homepage_enabled: true }),
      },
    );
    if (patchResp.ok) {
      console.log("[OK] Supabase 账号 config.authCookie 已更新");
    } else {
      console.warn(`[WARN] config 更新失败: HTTP ${patchResp.status}`);
    }
  } catch (err) {
    console.warn(`[WARN] config 更新异常: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 通过 Cloudflare REST API 更新 Worker secret,避开 wrangler CLI 交互
async function updateWorkerSecret(env: Record<string, string>, secretName: string, value: string): Promise<void> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const scriptName = env.CLOUDFLARE_WORKER_NAME ?? "apimonitor";
  const baseHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const acctResp = await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: baseHeaders });
  const acctJson = (await acctResp.json()) as {
    success: boolean;
    result?: Array<{ id: string; name: string }>;
    errors?: Array<{ message: string }>;
  };
  if (!acctJson.success || !acctJson.result?.length) {
    throw new Error(`获取 Cloudflare account 失败: ${JSON.stringify(acctJson.errors)}`);
  }
  const accountId = acctJson.result[0].id;
  console.log(`   Cloudflare account: ${acctJson.result[0].name} (${accountId})`);

  const secretResp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/secrets`,
    {
      method: "PUT",
      headers: baseHeaders,
      body: JSON.stringify({ name: secretName, text: value, type: "secret_text" }),
    },
  );
  const secretJson = (await secretResp.json()) as { success: boolean; errors?: Array<{ message: string }> };
  if (!secretJson.success) {
    throw new Error(`更新 Worker secret 失败: ${JSON.stringify(secretJson.errors)}`);
  }
  console.log(`[OK] Worker secret ${secretName} 已更新`);
}

async function main(): Promise<void> {
  const env = loadEnv();
  console.log("[OK] 环境变量加载成功");

  const forceRelogin = process.argv.includes("--relogin");

  const credential = await extractCookie(env, forceRelogin);
  if (!credential) {
    process.exit(1);
  }
  const { cookieString, sessionCookieCount } = credential;
  console.log(`[OK] 提取到 cookie 串(${cookieString.length} 字符,含 ${sessionCookieCount} 个 cookie)`);

  console.log("[INFO] 验证 cookie 有效性 ...");
  const validation = await validateCookie(cookieString);
  if (!validation.valid) {
    console.error(`[FAIL] 凭据无效: ${validation.error}`);
    process.exit(1);
  }
  console.log(`[OK] 凭据验证通过,当前用量: ${validation.usage}`);

  console.log("[INFO] 同步凭据到 Supabase ...");
  await upsertOllamaAccountCredentials(env, cookieString);

  console.log("[INFO] 更新本地 .env ...");
  updateEnvKeys(resolve(process.cwd(), ".env"), { OLLAMA_AUTH_COOKIE: cookieString });
  console.log("[OK] 本地 .env 的 OLLAMA_AUTH_COOKIE 已更新");

  if (env.CLOUDFLARE_API_TOKEN) {
    console.log("[INFO] 通过 Cloudflare API 更新 Worker secret ...");
    await updateWorkerSecret(env, "OLLAMA_AUTH_COOKIE", cookieString);
  } else {
    console.warn("[WARN] .env 中缺少 CLOUDFLARE_API_TOKEN，跳过 Worker secret 更新。");
  }

  console.log(`\n━━━ 完成 ━━━`);
  console.log("看板下次刷新即使用新登录态。登录态过期后重新执行本脚本即可（无需 API Key）。");
}

main().catch((err) => {
  console.error("[FAIL] 脚本执行失败:", err);
  process.exit(1);
});
