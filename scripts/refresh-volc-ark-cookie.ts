/**
 * 火山方舟 Cookie 刷新脚本（多账号）
 *
 * 功能:从本地 Edge 浏览器的多个 Profile 提取火山方舟登录态 cookie(csrfToken/digest/AccountID/userInfo),
 *       调 GetCodingPlanUsage 接口验证有效性后,按账号别名写入 Supabase(加密凭据 + config.authCookie),
 *       并以首个成功账号的 cookie 更新 Worker 的 VOLC_ARK_AUTH_COOKIE secret 与本地 .env 作为兜底。
 *
 * 多账号:每个账号绑定一个 Edge Profile(通过 --profile-directory 区分),label 须与前端
 *       Supabase provider_accounts.account_label 一致。串行刷新互不阻塞。
 *
 * 前置条件:
 *   1. Edge 浏览器各 Profile 已分别登录对应的火山方舟账号
 *   2. 运行前关闭所有浏览器窗口(含后台进程),避免 Profile 锁定
 *   3. .env 中已配置 CLOUDFLARE_API_TOKEN
 *   4. .env 中已配置 Supabase 凭据(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
 *      CREDENTIAL_ENCRYPTION_KEY / SUPABASE_USER_ID),否则仅更新 Worker secret
 *
 * 使用:
 *   node --experimental-strip-types scripts/refresh-volc-ark-cookie.ts
 *
 * 原理:火山方舟控制台 3.0 改版后,订阅页路径为 region:cn-beijing/subscription/coding-plan,
 *       登录态由 /api/passport/account/getUser 接口返回状态判定(200=已登录,401=未登录),
 *       digest cookie JWT 约 2 天过期。每个账号的 cookie 单独抓取并同步到云端。
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

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

const localAppData = process.env.LOCALAPPDATA ?? resolve(process.env.HOME ?? "", "AppData/Local");
const EDGE_USER_DATA_DIR = resolve(localAppData, "Microsoft/Edge/User Data");

// 账号列表:label 须与前端 Supabase provider_accounts.account_label 一致;
// profileDirectory 为 Edge 的 Profile 目录名(Default / Profile 1 ...)。
// 若 cherry 实际登录在 Default 而非 Profile 1,交换下面两项 profileDirectory 即可。
type VolcAccountConfig = {
  label: string;
  browserName: string;
  profileDirectory: string;
};

const ACCOUNTS: VolcAccountConfig[] = [
  { label: "默认账号", browserName: "Edge (Default)", profileDirectory: "Default" },
  { label: "cherry", browserName: "Edge (Profile 1)", profileDirectory: "Profile 1" },
];

// 终止 Edge 残留进程,释放 Profile 锁(避免 launchPersistentContext 启动出空白实例)
function killBrowserProcesses(): void {
  for (const name of ["msedge.exe"]) {
    try {
      execSync(`taskkill /F /IM ${name} /T 2>nul`, { stdio: "ignore" });
    } catch {
      // 进程不存在或无法终止,静默继续
    }
  }
  // 等待进程完全退出
  try { execSync("timeout /T 2 /NOBREAK 2>nul", { stdio: "ignore" }); } catch { /* ignore */ }
}

// 清理残留的浏览器锁文件(浏览器已关闭但 SingletonLock/Socket/Cookie 残留会导致 launchPersistentContext 报"被占用")
function cleanStaleLocks(userDataDir: string): void {
  const lockNames = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
  for (const name of lockNames) {
    const lockPath = resolve(userDataDir, name);
    try {
      if (existsSync(lockPath)) {
        unlinkSync(lockPath);
      }
    } catch {
      // 删除失败也不阻塞(文件可能正被占用或权限不足)
    }
  }
}

// 修复非正常关闭后的崩溃恢复弹窗,该弹窗会阻塞 Playwright 的 CDP 连接
function fixCrashedSession(userDataDir: string, profileDirectory: string): void {
  const prefsPath = resolve(userDataDir, profileDirectory, "Preferences");
  try {
    if (!existsSync(prefsPath)) return;
    const content = readFileSync(prefsPath, "utf-8");
    const prefs = JSON.parse(content) as Record<string, unknown>;
    const profile = (prefs.profile ?? {}) as Record<string, unknown>;
    profile.exit_type = "Normal";
    profile.exited_cleanly = true;
    prefs.profile = profile;
    writeFileSync(prefsPath, JSON.stringify(prefs), "utf-8");
  } catch {
    // 解析失败不阻塞
  }
}

// 火山方舟订阅页(控制台 3.0 新版路径,2026-06 改版后启用)
const SUBSCRIBE_URL =
  "https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan";
const USAGE_API_URL =
  "https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetCodingPlanUsage?";

// 抓取用量必需的 cookie 名称(均位于 .volcengine.com 域)
const REQUIRED_COOKIES = ["csrfToken", "digest", "AccountID", "userInfo"];

type PlaywrightCookie = {
  name: string;
  value: string;
  domain: string;
  expires: number;
};

// 从浏览器 cookie 列表里筛出火山方舟登录态 cookie,组合成请求头用的 cookie 串
function buildCookieString(cookies: PlaywrightCookie[]): string {
  const picked = new Map<string, string>();
  for (const cookie of cookies) {
    if (!cookie.domain.includes("volcengine.com")) continue;
    if (!REQUIRED_COOKIES.includes(cookie.name)) continue;
    // 同名 cookie 可能跨 domain/path 重复,只取第一个
    if (!picked.has(cookie.name)) picked.set(cookie.name, cookie.value);
  }
  return REQUIRED_COOKIES.filter((name) => picked.has(name))
    .map((name) => `${name}=${picked.get(name)}`)
    .join("; ");
}

// 调用火山方舟用量接口验证 cookie 是否有效,顺便回显当前用量
async function validateCookie(cookie: string): Promise<{ valid: boolean; usage?: string; error?: string }> {
  const csrfMatch = cookie.match(/csrfToken=([^;]+)/i);
  const csrf = csrfMatch ? csrfMatch[1] : "";
  try {
    const resp = await fetch(USAGE_API_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-csrf-token": csrf,
        Cookie: cookie,
        Referer: SUBSCRIBE_URL,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApiMonitor/0.1",
      },
      body: "{}",
    });

    if (resp.status === 401 || resp.status === 403) {
      return { valid: false, error: `HTTP ${resp.status}，登录态无效或已过期` };
    }
    if (!resp.ok) {
      return { valid: false, error: `HTTP ${resp.status}` };
    }

    const json = (await resp.json()) as {
      Result?: { QuotaUsage?: Array<{ Level?: string; Percent?: number }> };
    };
    const items = json.Result?.QuotaUsage ?? [];
    if (items.length === 0) {
      return { valid: false, error: "接口未返回用量数据" };
    }
    const summary = items
      .map((item) => `${item.Level}=${Number(item.Percent).toFixed(2)}%`)
      .join(", ");
    return { valid: true, usage: summary };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

// 通过 Cloudflare REST API 更新 Worker secret,避开 wrangler CLI 交互
// 多账号下 env secret 只能存一个值,这里用首个成功账号的 cookie 作为兜底
async function updateWorkerSecret(env: Record<string, string>, cookieValue: string): Promise<void> {
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
      body: JSON.stringify({
        name: "VOLC_ARK_AUTH_COOKIE",
        text: cookieValue,
        type: "secret_text",
      }),
    },
  );
  const secretJson = (await secretResp.json()) as {
    success: boolean;
    errors?: Array<{ message: string }>;
  };
  if (!secretJson.success) {
    throw new Error(`更新 Worker secret 失败: ${JSON.stringify(secretJson.errors)}`);
  }

  console.log("[OK] Worker secret VOLC_ARK_AUTH_COOKIE 已更新(首个成功账号,兜底用)");
}

// 同步更新本地 .env 中的 VOLC_ARK_AUTH_COOKIE,保持本地与云端一致(首个成功账号,兜底用)
function updateEnvFile(cookieValue: string): void {
  const envPath = resolve(process.cwd(), ".env");
  const content = readFileSync(envPath, "utf-8");
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const newLine = `VOLC_ARK_AUTH_COOKIE="${cookieValue}"`;
  let found = false;
  const updated = lines.map((line) => {
    if (/^VOLC_ARK_AUTH_COOKIE\s*=/.test(line)) {
      found = true;
      return newLine;
    }
    return line;
  });
  if (!found) {
    updated.push("# 火山方舟", newLine);
  }
  writeFileSync(envPath, updated.join(eol), "utf-8");
  console.log("[OK] 本地 .env 的 VOLC_ARK_AUTH_COOKIE 已更新(首个成功账号,兜底用)");
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
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    plaintext,
  );
  const bytesToB64 = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes));
  return {
    encryptedPayload: bytesToB64(new Uint8Array(encrypted)),
    nonce: bytesToB64(nonce),
    keyVersion: "v1",
  };
}

// 按 account_label 定位 Supabase 账号,写入加密凭据(provider_account_credentials)
// 与 config.authCookie。加密凭据为权威存储,Worker 优先读取且不受 persistSnapshot 覆盖 config 影响。
async function upsertVolcAccountCredentials(
  env: Record<string, string>,
  accountLabel: string,
  cookie: string,
): Promise<void> {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
  const userId = env.SUPABASE_USER_ID;

  if (!supabaseUrl || !serviceRoleKey || !encryptionKey || !userId) {
    console.warn(
      "[WARN] 缺少 Supabase 配置,跳过数据库凭据更新。Worker env secret 已更新,缺 Supabase 时仍可正常工作。",
    );
    return;
  }

  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // 1. 按 (user_id, provider_key=volc-ark, account_label) 查找账号
  let accountId: string | null = null;
  let existingConfig: Record<string, unknown> = {};
  const findUrl = new URL("/rest/v1/provider_accounts", supabaseUrl);
  findUrl.searchParams.set("select", "id,config");
  findUrl.searchParams.set("user_id", `eq.${userId}`);
  findUrl.searchParams.set("provider_key", "eq.volc-ark");
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
    console.warn("[WARN] 查询 Supabase 账号失败,跳过凭据写入");
    return;
  }

  // 2. 未找到则创建:source_url 加 label 片段,避开同 provider 下 (user_id,provider_key,source_url) 唯一索引冲突
  if (!accountId) {
    const sourceUrl = accountLabel === "默认账号" ? SUBSCRIBE_URL : `${SUBSCRIBE_URL}#${accountLabel}`;
    try {
      const createResp = await fetch(new URL("/rest/v1/provider_accounts", supabaseUrl), {
        method: "POST",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({
          user_id: userId,
          provider_key: "volc-ark",
          display_name: accountLabel,
          account_label: accountLabel,
          source_url: sourceUrl,
          auth_mode: "configured",
          status: "ready",
        }),
      });
      if (createResp.ok) {
        const rows = (await createResp.json()) as Array<{ id: string }>;
        accountId = rows[0]?.id ?? null;
        if (accountId) console.log(`   [OK] 已创建 volc-ark 账号(label=${accountLabel})`);
      } else {
        console.warn(`[WARN] 创建 Supabase 账号失败: HTTP ${createResp.status}`);
        return;
      }
    } catch {
      console.warn("[WARN] 创建 Supabase 账号异常,跳过凭据写入");
      return;
    }
  }

  if (!accountId) {
    console.warn("[WARN] 无法确定账号 ID,跳过凭据写入");
    return;
  }

  // 3. 写入加密凭据到 provider_account_credentials(on_conflict=provider_account_id)
  try {
    const encrypted = await encryptPayload({ authCookie: cookie }, encryptionKey);
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

  // 4. 同步更新 config.authCookie + 状态(兼容旧读取路径;persistSnapshot 可能覆盖 config,加密凭据已兜底)
  try {
    const mergedConfig = { ...existingConfig, authCookie: cookie };
    const patchResp = await fetch(
      new URL(`/rest/v1/provider_accounts?id=eq.${accountId}`, supabaseUrl),
      {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify({ config: mergedConfig, status: "ready", auth_mode: "configured" }),
      },
    );
    if (patchResp.ok) {
      console.log("[OK] Supabase 账号 config.authCookie 已更新");
    } else {
      console.warn(`[WARN] config 更新失败: HTTP ${patchResp.status}`);
    }
  } catch {
    console.warn("[WARN] config 更新异常");
  }
}

// 在指定 Edge Profile 中打开订阅页,等待登录完成后提取 cookie 串
async function extractCookieFromProfile(
  chromium: typeof import("playwright")["chromium"],
  account: VolcAccountConfig,
  userDataDir: string,
): Promise<string | null> {
  cleanStaleLocks(userDataDir);
  fixCrashedSession(userDataDir, account.profileDirectory);
  console.log(`[INFO] 启动 ${account.browserName}(profile=${account.profileDirectory}) ...`);

  let context: import("playwright").BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: "msedge",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        "--disable-restore-session-state",
        `--profile-directory=${account.profileDirectory}`,
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("lock") || msg.includes("singleton") || msg.includes("closed")) {
      console.error(`   [WARN] ${account.label} Edge Profile 被占用,请关闭所有 Edge 进程后重试`);
    } else {
      console.error(`   [WARN] ${account.label} Edge 启动失败: ${msg.substring(0, 120)}`);
    }
    return null;
  }

  try {
    const page = await context.newPage();

    // 跟踪 getUser 接口返回状态(200=已登录,401=未登录),这是火山方舟 3.0 控制台判断登录态的依据
    let getUserStatus: number | undefined;
    const waitFirstGetUser = page
      .waitForResponse(
        (resp) => resp.url().includes("/api/passport/account/getUser"),
        { timeout: 30_000 },
      )
      .then((resp) => {
        getUserStatus = resp.status();
      })
      .catch(() => {
        // 首次请求未触发,继续走后续判定
      });

    await page.goto(SUBSCRIBE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitFirstGetUser;

    // 情形 A:旧版行为--直接重定向到 signin 域名
    if (page.url().includes("signin.volcengine.com")) {
      console.log(`   [WARN] ${account.label} 跳转到 signin 页面,请在浏览器完成登录...`);
      await page.waitForURL("**/console.volcengine.com/**", { timeout: 300_000 });
      await page.waitForTimeout(3_000);
      console.log("   [OK] 已返回控制台,登录完成");
    }
    // 情形 B:新版行为--同域名下显示"登录"按钮,getUser 返回 401
    else if (getUserStatus !== 200) {
      console.log(
        `   [WARN] ${account.label} 未登录火山方舟(getUser=${getUserStatus ?? "no-response"}),请在浏览器右上角点击"登录"完成登录...`,
      );
      const loginResp = await page
        .waitForResponse(
          (resp) =>
            resp.url().includes("/api/passport/account/getUser") && resp.status() === 200,
          { timeout: 300_000 },
        )
        .catch(() => null);
      if (!loginResp) {
        console.error("   [FAIL] 等待登录超时,请重试");
        return null;
      }
      await page.waitForTimeout(3_000);
      console.log("   [OK] 检测到登录成功(getUser=200)");
    }
    // 情形 C:已登录,直接提取
    else {
      console.log(`   -> ${account.label} 已登录(getUser=200),等待 API 调用完成后提取 cookie`);
      await page.waitForTimeout(3_000);
    }

    const cookies = (await context.cookies()) as PlaywrightCookie[];
    const cookieString = buildCookieString(cookies);
    if (!cookieString) {
      console.warn(`   [WARN] ${account.label} 未提取到火山方舟 cookie`);
      return null;
    }

    const found = REQUIRED_COOKIES.filter((name) => cookieString.includes(`${name}=`));
    if (found.length < REQUIRED_COOKIES.length) {
      const missing = REQUIRED_COOKIES.filter((name) => !found.includes(name));
      console.warn(`   [WARN] 缺少 cookie: ${missing.join(", ")}(继续尝试验证)`);
    }

    const digestCookie = cookies.find((c) => c.name === "digest" && c.domain.includes("volcengine.com"));
    if (digestCookie?.expires) {
      console.log(`   digest 有效至: ${new Date(digestCookie.expires * 1000).toISOString()}`);
    }

    console.log(`[OK] 从 ${account.browserName} 提取到 cookie 串(${cookieString.length} 字符)`);
    return cookieString;
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  console.log("[OK] 环境变量加载成功");

  if (!env.CLOUDFLARE_API_TOKEN) {
    console.error("[FAIL] .env 中缺少 CLOUDFLARE_API_TOKEN,无法更新 Worker secret。");
    process.exit(1);
  }

  // 终止残留浏览器进程,释放 Profile 锁
  killBrowserProcesses();

  const { chromium } = await import("playwright");

  let primaryCookie: string | undefined;
  let success = 0;
  let failed = 0;

  for (const account of ACCOUNTS) {
    console.log(`\n━━━ 处理账号:${account.label}(${account.profileDirectory}) ━━━`);
    const userDataDir = process.env.BROWSER_USER_DATA_DIR ?? EDGE_USER_DATA_DIR;

    const cookie = await extractCookieFromProfile(chromium, account, userDataDir);
    if (!cookie) {
      failed += 1;
      continue;
    }

    // 验证 cookie 有效性
    console.log("[INFO] 验证 cookie 有效性 ...");
    const validation = await validateCookie(cookie);
    if (!validation.valid) {
      console.error(`[FAIL] ${account.label} Cookie 无效: ${validation.error}`);
      failed += 1;
      continue;
    }
    console.log(`[OK] ${account.label} Cookie 验证通过,当前用量: ${validation.usage}`);

    // 写入 Supabase(加密凭据 + config.authCookie),按 account_label 定位账号
    console.log("[INFO] 同步凭据到 Supabase ...");
    await upsertVolcAccountCredentials(env, account.label, cookie);

    // 首个成功账号的 cookie 作为 Worker secret / .env 兜底
    if (!primaryCookie) primaryCookie = cookie;
    success += 1;
  }

  // 用首个成功账号的 cookie 更新 Worker secret 与本地 .env(兜底,Supabase 不可达时仍能展示主账号)
  if (primaryCookie) {
    console.log("\n[INFO] 更新本地 .env ...");
    updateEnvFile(primaryCookie);
    console.log("[INFO] 通过 Cloudflare API 更新 Worker secret ...");
    await updateWorkerSecret(env, primaryCookie);
  }

  console.log(`\n━━━ 汇总:成功 ${success} 个,失败 ${failed} 个 ━━━`);
  if (success === 0) {
    console.error("[FAIL] 所有账号刷新均失败");
    process.exit(1);
  }
  console.log("   看板下次刷新即使用新 cookie。火山方舟 cookie 约 2 天过期,过期后重新执行本脚本即可。");
}

main().catch((err) => {
  console.error("[FAIL] 脚本执行失败:", err);
  process.exit(1);
});