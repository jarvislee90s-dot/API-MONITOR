/**
 * 智谱 BigModel Coding Plan Cookie 刷新脚本
 *
 * 功能:用账号密码登录智谱 BigModel 开放平台(open.bigmodel.cn),提取登录 token
 *      与 WAF cookie,调 /monitor/usage/quota/limit 验证有效性后,按"默认账号"写入
 *      Supabase(加密凭据 {authCookie, authToken} + config 兜底),并同步更新本地
 *      .env 的 ZHIPU_AUTH_COOKIE / ZHIPU_AUTH_TOKEN 与 Cloudflare Worker 的
 *      ZHIPU_AUTH_COOKIE secret,供 Worker 云端直接取数。
 *
 * 前置条件:
 *   1. .env 中已配置 Zai_account / Zai_password(登录脚本专用,不写入 Worker)
 *   2. .env 中已配置 CLOUDFLARE_API_TOKEN(缺失则跳过 Worker secret 更新)
 *   3. .env 中已配置 Supabase 凭据(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
 *      CREDENTIAL_ENCRYPTION_KEY / SUPABASE_USER_ID),缺失则仅更新 .env / secret
 *
 * 使用:
 *   node --experimental-strip-types scripts/refresh-zhipu-cookie.ts
 *
 * 说明:登录遇腾讯点选验证码(请点击图中文字,非滑块)时不自动绕过,脚本打印提示
 *      等待人工完成(轮询最长 180 秒)。登录态由 bigmodel_token_production cookie 判定;
 *      token 约 7 天过期,过期后重新执行本脚本即可。取数逻辑与 worker/providers/zhipu.ts
 *      保持一致。验证码 DOM 特征参照 https://github.com/OLmatter/glm-coding-helper。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const defaultPageUrl = "https://bigmodel.cn/coding-plan/personal/usage";
const defaultApiBase = "https://bigmodel.cn/api";
// 登录页:账号登录 tab 下填用户名/邮箱/手机号 + 密码;redirect 指向 Coding Plan 个人用量页
const LOGIN_URL = "https://open.bigmodel.cn/login?redirect=%2Fcoding-plan%2Fpersonal%2Fusage";
const TOKEN_COOKIE_NAME = "bigmodel_token_production";

// 登录成功后等待人工完成点选验证码/登录的最长时间(毫秒)
const LOGIN_WAIT_MS = 180_000;

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
  token: string;
  tokenExpiresAt: number | null; // 毫秒时间戳;未知为 null
};

// 提取 .bigmodel.cn / open.bigmodel.cn 下的 cookie 串与 token 值(须含 bigmodel_token_production)
async function buildCredential(
  context: import("playwright").BrowserContext,
): Promise<ExtractedCredential | null> {
  const cookies = await context.cookies();
  const picked = new Map<string, string>();
  let token: string | null = null;
  let tokenExpiresAt: number | null = null;

  for (const cookie of cookies) {
    if (!cookie.domain.includes("bigmodel.cn")) continue;
    // 同名 cookie 可能跨 domain/path 重复,只取第一个
    if (!picked.has(cookie.name)) picked.set(cookie.name, cookie.value);
    if (cookie.name === TOKEN_COOKIE_NAME) {
      token = cookie.value;
      // expires 为秒级 epoch;session cookie 为 -1
      tokenExpiresAt = cookie.expires > 0 ? cookie.expires * 1000 : null;
    }
  }

  if (!token || picked.size === 0) return null;
  const cookieString = [...picked.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  return { cookieString, token, tokenExpiresAt };
}

// 腾讯点选验证码容器选择器(触发后进入视口;容器默认被移到视口外,y=-1000000)
const CAPTCHA_CONTAINER_SELECTORS = [
  ".tencent-captcha-dy__warp",
  ".tencent-captcha-dy__container",
  "[id*='tcaptcha']",
  ".captcha-component",
];
// 点选提示语所在节点(如"请点击图中文字")
const CAPTCHA_PROMPT_SELECTORS = [
  ".tencent-captcha-dy__header-text",
  ".tencent-captcha-dy__header-title-wrap .tencent-captcha-dy__header-text",
  "div[class*='tencent-captcha'] div[class*='header-text']",
];

// 腾讯点选验证码是否真正弹出(容器进入视口且有实际尺寸)
async function isCaptchaVisible(page: import("playwright").Page): Promise<boolean> {
  return page
    .evaluate((selectors) => {
      for (const selector of selectors) {
        const root = document.querySelector(selector);
        if (!root) continue;
        const rect = root.getBoundingClientRect();
        if (
          rect.height > 100 &&
          rect.width > 100 &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          rect.right > 0 &&
          rect.left < window.innerWidth
        ) {
          return true;
        }
      }
      return false;
    }, CAPTCHA_CONTAINER_SELECTORS)
    .catch(() => false);
}

// 读取点选验证码的提示文字(用于提示人工;读不到返回空)
async function readCaptchaPrompt(page: import("playwright").Page): Promise<string> {
  return page
    .evaluate((selectors) => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        const text = el?.textContent?.trim();
        if (text) return text;
      }
      return "";
    }, CAPTCHA_PROMPT_SELECTORS)
    .catch(() => "");
}

// 校验 cookie/token:调用量接口,200 且 data.limits 非空才算有效
async function validateCredential(
  authToken: string,
  authCookie: string,
): Promise<{ valid: boolean; limitsCount?: number; error?: string }> {
  try {
    const resp = await fetch(`${defaultApiBase}/monitor/usage/quota/limit`, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        Authorization: authToken,
        Cookie: authCookie,
        Referer: defaultPageUrl,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApiMonitor/0.1",
      },
    });

    if (resp.status === 401 || resp.status === 403) {
      return { valid: false, error: `HTTP ${resp.status}，登录态无效或已过期` };
    }
    if (!resp.ok) {
      return { valid: false, error: `HTTP ${resp.status}` };
    }

    const payload = (await resp.json().catch(() => null)) as {
      code?: number;
      data?: { limits?: unknown[] };
    } | null;
    const limits = Array.isArray(payload?.data?.limits) ? payload.data!.limits! : [];
    if (limits.length === 0) {
      return { valid: false, error: "接口未返回 limits 数据" };
    }
    return { valid: true, limitsCount: limits.length };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

// 登录并提取凭据:优先复用已登录态,否则填账号密码并等待人工过滑块;完成/失败均关闭浏览器
async function loginAndExtract(env: Record<string, string>): Promise<ExtractedCredential | null> {
  const user = env.Zai_account;
  const pass = env.Zai_password;
  if (!user || !pass) {
    console.error("❌ .env 缺少 Zai_account / Zai_password，无法自动登录");
    return null;
  }

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    console.log(`[INFO] 打开登录页 ${LOGIN_URL} ...`);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2_000);

    // 已处于登录态则直接提取
    if (!/\/login/i.test(page.url())) {
      const existing = await buildCredential(context);
      if (existing) {
        console.log("✅ 已处于登录态，直接复用现有 cookie");
        return existing;
      }
    }

    // 切「账号登录」tab
    const accountTab = page.getByRole("tab", { name: "账号登录" });
    if (await accountTab.count()) {
      await accountTab.click();
      await page.waitForTimeout(500);
    }

    const accountInput = page.getByRole("textbox", { name: "请输入用户名/邮箱/手机号" });
    const passwordInput = page.getByRole("textbox", { name: "请输入密码" });
    if (!(await accountInput.count()) || !(await passwordInput.count())) {
      console.error("❌ 未找到账号/密码输入框，登录页结构可能已变化");
      return null;
    }

    await accountInput.fill(user);
    await passwordInput.fill(pass);
    await page.waitForTimeout(300);

    const submitBtn = page.getByRole("button", { name: "登录", exact: true });
    if (await submitBtn.count()) {
      await submitBtn.click();
      console.log("⏳ 已点击登录，若出现点选验证码请在浏览器中手动完成...");
    }

    // 轮询等待登录成功(最长 180 秒),期间提示人工处理腾讯点选验证码
    const deadline = Date.now() + LOGIN_WAIT_MS;
    let captchaNotified = false;
    while (Date.now() < deadline) {
      if (!captchaNotified && (await isCaptchaVisible(page))) {
        const prompt = await readCaptchaPrompt(page);
        console.log(
          `🛡️ 检测到腾讯点选验证码${prompt ? `（${prompt}）` : ""}，请在浏览器中按提示点击图中文字完成（脚本会等待，最长 180 秒）...`,
        );
        captchaNotified = true;
      }
      const credential = await buildCredential(context);
      if (credential && !/\/login/i.test(page.url())) {
        console.log("✅ 登录成功，cookie 与 token 已提取");
        return credential;
      }
      await page.waitForTimeout(2_000);
    }

    console.error("❌ 登录超时（180 秒），请检查账号密码或验证码后重试");
    return null;
  } finally {
    await browser.close();
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

// 按 provider_key=zhipu + account_label="默认账号" 写入加密凭据与 config 兜底
async function upsertZhipuAccountCredentials(
  env: Record<string, string>,
  authCookie: string,
  authToken: string,
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

  // 1. 按 (user_id, provider_key=zhipu, account_label) 查找账号
  let accountId: string | null = null;
  let existingConfig: Record<string, unknown> = {};
  const findUrl = new URL("/rest/v1/provider_accounts", supabaseUrl);
  findUrl.searchParams.set("select", "id,config");
  findUrl.searchParams.set("user_id", `eq.${userId}`);
  findUrl.searchParams.set("provider_key", "eq.zhipu");
  findUrl.searchParams.set("account_label", `eq.${accountLabel}`);
  findUrl.searchParams.set("limit", "1");

  try {
    const findResp = await fetch(findUrl, { headers });
    if (findResp.ok) {
      const rows = (await findResp.json()) as Array<{ id: string; config?: Record<string, unknown> }>;
      accountId = rows[0]?.id ?? null;
      existingConfig = (rows[0]?.config ?? {}) as Record<string, unknown>;
    }
  } catch {
    console.warn("[WARN] 查询 Supabase 账号失败，跳过凭据写入");
    return;
  }

  // 2. 未找到则创建:source_url 为用量页;同 provider 下唯一索引按 (user_id,provider_key,source_url)
  if (!accountId) {
    try {
      const createResp = await fetch(new URL("/rest/v1/provider_accounts", supabaseUrl), {
        method: "POST",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({
          user_id: userId,
          provider_key: "zhipu",
          display_name: accountLabel,
          account_label: accountLabel,
          source_url: defaultPageUrl,
          auth_mode: "configured",
          status: "ready",
        }),
      });
      if (createResp.ok) {
        const rows = (await createResp.json()) as Array<{ id: string }>;
        accountId = rows[0]?.id ?? null;
        if (accountId) console.log(`   [OK] 已创建 zhipu 账号(label=${accountLabel})`);
      } else {
        console.warn(`[WARN] 创建 Supabase 账号失败: HTTP ${createResp.status}`);
        return;
      }
    } catch {
      console.warn("[WARN] 创建 Supabase 账号异常，跳过凭据写入");
      return;
    }
  }

  if (!accountId) {
    console.warn("[WARN] 无法确定账号 ID，跳过凭据写入");
    return;
  }

  // 3. 写入加密凭据 {authCookie, authToken} 到 provider_account_credentials
  try {
    const encrypted = await encryptPayload({ authCookie, authToken }, encryptionKey);
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
  } catch {
    console.warn("[WARN] 加密凭据写入异常");
  }

  // 4. 同步更新 config.authCookie/authToken + 状态(兼容旧读取路径)
  try {
    const mergedConfig = { ...existingConfig, authCookie, authToken };
    const patchResp = await fetch(
      new URL(`/rest/v1/provider_accounts?id=eq.${accountId}`, supabaseUrl),
      {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify({ config: mergedConfig, status: "ready", auth_mode: "configured" }),
      },
    );
    if (patchResp.ok) {
      console.log("[OK] Supabase 账号 config.authCookie/authToken 已更新");
    } else {
      console.warn(`[WARN] config 更新失败: HTTP ${patchResp.status}`);
    }
  } catch {
    console.warn("[WARN] config 更新异常");
  }
}

// 通过 Cloudflare REST API 更新 Worker secret,避开 wrangler CLI 交互
async function updateWorkerSecret(env: Record<string, string>, secretName: string, value: string): Promise<void> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const scriptName = env.CLOUDFLARE_WORKER_NAME ?? "apimonitor";
  const baseHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // 1. 获取 account_id(token 关联的账号)
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

  // 2. 更新 secret
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

  if (!env.Zai_account || !env.Zai_password) {
    console.error("[FAIL] .env 中缺少 Zai_account / Zai_password，无法自动登录。");
    process.exit(1);
  }

  const credential = await loginAndExtract(env);
  if (!credential) {
    process.exit(1);
  }
  const { cookieString, token, tokenExpiresAt } = credential;
  console.log(`[OK] 提取到 cookie 串(${cookieString.length} 字符)，token 已获取`);

  // 验证有效性
  console.log("[INFO] 验证 cookie/token 有效性 ...");
  const validation = await validateCredential(token, cookieString);
  if (!validation.valid) {
    console.error(`[FAIL] 凭据无效: ${validation.error}`);
    process.exit(1);
  }
  console.log(`[OK] 凭据验证通过，quota/limit 返回 ${validation.limitsCount} 个 limits`);

  // 写入 Supabase(加密凭据 + config),按 provider_key=zhipu + label="默认账号" 定位
  console.log("[INFO] 同步凭据到 Supabase ...");
  await upsertZhipuAccountCredentials(env, cookieString, token);

  // 更新本地 .env 兜底
  console.log("[INFO] 更新本地 .env ...");
  updateEnvKeys(resolve(process.cwd(), ".env"), {
    ZHIPU_AUTH_COOKIE: cookieString,
    ZHIPU_AUTH_TOKEN: token,
  });
  console.log("[OK] 本地 .env 的 ZHIPU_AUTH_COOKIE / ZHIPU_AUTH_TOKEN 已更新");

  // 通过 Cloudflare API 更新 Worker secret(token 可由 cookie 推导,只需 cookie)
  if (env.CLOUDFLARE_API_TOKEN) {
    console.log("[INFO] 通过 Cloudflare API 更新 Worker secret ...");
    await updateWorkerSecret(env, "ZHIPU_AUTH_COOKIE", cookieString);
  } else {
    console.warn("[WARN] .env 中缺少 CLOUDFLARE_API_TOKEN，跳过 Worker secret 更新。");
  }

  if (tokenExpiresAt) {
    const expires = new Date(tokenExpiresAt);
    const days = Math.max(0, Math.round((tokenExpiresAt - Date.now()) / 86_400_000));
    console.log(`\n━━━ 完成 ━━━`);
    console.log(`token 过期时间: ${expires.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（约 ${days} 天后）`);
    console.log("下次刷新: token 过期后重新执行本脚本即可。看板下次刷新即使用新 cookie。");
  } else {
    console.log(`\n━━━ 完成 ━━━`);
    console.log("未获取到 token 过期时间（session cookie）。看板下次刷新即使用新 cookie。");
  }
}

main().catch((err) => {
  console.error("[FAIL] 脚本执行失败:", err);
  process.exit(1);
});
