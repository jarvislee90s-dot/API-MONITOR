/**
 * OpenCode Go Cookie 自动刷新脚本
 *
 * 功能：从本地浏览器 Profile 提取 OpenCode Go 的 auth cookie，
 *       验证有效性后，通过 Cloudflare API 更新 Worker 的 OPENCODE_GO_AUTH_COOKIE secret。
 *       Worker 下次刷新立即使用新 cookie。
 *
 * 前置条件：
 *   1. Edge 或 Chrome 浏览器中已登录 https://opencode.ai
 *   2. 运行前关闭所有浏览器窗口（含后台进程），避免 Profile 锁定
 *   3. 项目 .env 中已配置 CLOUDFLARE_API_TOKEN
 *   4. （可选）.env 中配置 OPENCODE_GO_WORKSPACE_ID 用于验证 cookie
 *
 * 使用：
 *   node --experimental-strip-types scripts/refresh-opencode-cookie.ts
 *
 * 原理：生产 Worker 用 env OPENCODE_GO_AUTH_COOKIE 明文 secret（未配置 CREDENTIAL_ENCRYPTION_KEY，
 *       Supabase 加密凭据解密为空，回退到 env）。因此直接更新该 secret 即可让 Worker 生效。
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

// 支持的浏览器列表，按优先级排序：Edge 优先（无 DevTools 远程调试限制）

// 终止浏览器进程，释放 Profile 锁
function killBrowserProcesses(): void {
  const processNames = ["msedge.exe", "chrome.exe"];
  for (const name of processNames) {
    try {
      execSync(`taskkill /F /IM ${name} /T 2>nul`, { stdio: "ignore" });
    } catch {
      // 进程不存在或无法终止，静默继续
    }
  }
  // 等待进程完全退出
  try { execSync("timeout /T 2 /NOBREAK 2>nul", { stdio: "ignore" }); } catch { /* ignore */ }
}
// 清理残留的浏览器锁文件（浏览器已关闭但 SingletonLock/Socket/Cookie 残留会导致 launchPersistentContext 误报"被占用"）
function cleanStaleLocks(userDataDir: string): void {
  const lockNames = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
  for (const name of lockNames) {
    const lockPath = resolve(userDataDir, name);
    try {
      if (existsSync(lockPath)) {
        unlinkSync(lockPath);
      }
    } catch {
      // 删除失败也不阻塞
    }
  }
}
const BROWSER_TARGETS = [
  {
    name: "Edge",
    userDataDir: resolve(localAppData, "Microsoft/Edge/User Data"),
    channel: "msedge" as const,
  },
  {
    name: "Chrome",
    userDataDir: resolve(localAppData, "Google/Chrome/User Data"),
    channel: "chrome" as const,
  },
];

async function validateCookie(
  cookie: string,
  workspaceId: string,
): Promise<{ valid: boolean; windows: string[]; error?: string }> {
  const url = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;
  try {
    const resp = await fetch(url, {
      redirect: "manual",
      headers: {
        Cookie: `auth=${cookie}`,
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApiMonitor/0.1",
      },
    });
    const html = await resp.text();

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location") ?? "";
      return { valid: false, windows: [], error: `被重定向到: ${location}` };
    }

    const patterns = ["rollingUsage", "weeklyUsage", "monthlyUsage"];
    const found = patterns.filter((p) => html.includes(p));

    if (found.length === 0) {
      return { valid: false, windows: [], error: "页面中未找到用量数据" };
    }

    return { valid: true, windows: found };
  } catch (err) {
    return { valid: false, windows: [], error: String(err) };
  }
}


// 同步更新本地 .env 中的 OPENCODE_GO_AUTH_COOKIE
function updateEnvFile(cookieValue: string): void {
  const envPath = resolve(process.cwd(), ".env");
  const content = readFileSync(envPath, "utf-8");
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const newLine = `OPENCODE_GO_AUTH_COOKIE="${cookieValue}"`;
  let found = false;
  const updated = lines.map((line) => {
    if (/^OPENCODE_GO_AUTH_COOKIE\s*=/.test(line)) {
      found = true;
      return newLine;
    }
    return line;
  });
  if (!found) {
    updated.push("# OpenCode Go", newLine);
  }
  writeFileSync(envPath, updated.join(eol), "utf-8");
  console.log("✅ 本地 .env 的 OPENCODE_GO_AUTH_COOKIE 已更新");
}

// AES-GCM 加密，与 Worker security/credentials.ts 保持一致
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

// 向 Supabase 写入加密凭据，确保前端配置页和 Worker 都能读取最新 cookie
async function updateSupabaseCredentials(
  env: Record<string, string>,
  providerKey: string,
  credentials: Record<string, string>,
): Promise<void> {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
  const userId = env.SUPABASE_USER_ID;

  if (!supabaseUrl || !serviceRoleKey || !encryptionKey || !userId) {
    console.warn(
      "⚠️ 缺少 Supabase 配置（SUPABASE_URL / SERVICE_ROLE_KEY / CREDENTIAL_ENCRYPTION_KEY / USER_ID），" +
        "跳过数据库凭据更新。Worker env secret 已更新，无 Supabase 时仍可正常工作。",
    );
    return;
  }

  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // 1. 查找该 provider 的已有账号
  let accountId: string | null = null;
  let existingRows: Array<{ id: string; config?: Record<string, unknown> }> = [];
  const accountUrl = new URL("/rest/v1/provider_accounts", supabaseUrl);
  accountUrl.searchParams.set("select", "id,config");
  accountUrl.searchParams.set("user_id", `eq.${userId}`);
  accountUrl.searchParams.set("provider_key", `eq.${providerKey}`);
  accountUrl.searchParams.set("order", "created_at.asc");
  accountUrl.searchParams.set("limit", "1");

  try {
    const accountResp = await fetch(accountUrl, { headers });
    if (accountResp.ok) {
      existingRows = (await accountResp.json()) as Array<{ id: string; config?: Record<string, unknown> }>;
      accountId = existingRows[0]?.id ?? null;
    }
  } catch {
    console.warn("⚠️ 查询 Supabase 账号失败，跳过凭据写入");
    return;
  }

  // 2. 若无账号则创建一个
  if (!accountId) {
    const label = providerKey === "opencode-go" ? "OpenCode Go" : providerKey;
    const sourceUrl =
      providerKey === "opencode-go"
        ? `https://opencode.ai/workspace/${env.OPENCODE_GO_WORKSPACE_ID ?? ""}/go`
        : "";
    try {
      const createResp = await fetch(
        new URL("/rest/v1/provider_accounts", supabaseUrl),
        {
          method: "POST",
          headers: {
            ...headers,
            Prefer: "return=representation",
          },
          body: JSON.stringify({
            user_id: userId,
            provider_key: providerKey,
            display_name: label,
            source_url: sourceUrl,
            status: "unknown",
          }),
        },
      );
      if (createResp.ok) {
        const createRows = (await createResp.json()) as Array<{ id: string }>;
        accountId = createRows[0]?.id ?? null;
        if (accountId) {
          console.log(`   ✅ 已创建 ${label} Supabase 账号`);
        }
      } else {
        console.warn("⚠️ 创建 Supabase 账号失败，跳过凭据写入");
        return;
      }
    } catch {
      console.warn("⚠️ 创建 Supabase 账号异常，跳过凭据写入");
      return;
    }
  }

  if (!accountId) {
    console.warn("⚠️ 无法确定 Supabase 账号 ID，跳过凭据写入");
    return;
  }

  // 3. 更新账号的 config（当前数据库使用 config JSONB 列存储凭据）
  try {
    const existingConfig = (existingRows[0]?.config ?? {}) as Record<string, unknown>;
    const mergedConfig = { ...existingConfig, ...credentials };
    const patchResp = await fetch(
      new URL(`/rest/v1/provider_accounts?id=eq.${accountId}`, supabaseUrl),
      {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          config: mergedConfig,
          status: "ready",
        }),
      },
    );
    if (patchResp.ok) {
      console.log("✅ Supabase 凭据已更新（config.authCookie）");
    } else {
      console.warn(`⚠️ Supabase 凭据更新失败: HTTP ${patchResp.status}`);
    }
  } catch {
    console.warn("⚠️ Supabase 凭据写入网络异常");
  }
}

async function updateWorkerSecret(env: Record<string, string>, cookieValue: string): Promise<void> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const scriptName = env.CLOUDFLARE_WORKER_NAME ?? "apimonitor";
  const baseHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // 1. 获取 account_id（token 关联的账号）
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
        name: "OPENCODE_GO_AUTH_COOKIE",
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

  console.log("✅ Worker secret OPENCODE_GO_AUTH_COOKIE 已更新");
}

async function main(): Promise<void> {
  const env = loadEnv();

  console.log("✅ 环境变量加载成功");

  if (!env.CLOUDFLARE_API_TOKEN) {
    console.error("❌ .env 中缺少 CLOUDFLARE_API_TOKEN，无法更新 Worker secret。");
    process.exit(1);
  }

  // 动态 import playwright
    // 终止残留浏览器进程，释放 Profile 锁
  killBrowserProcesses();

  const { chromium } = await import("playwright");

  let authCookieValue: string | undefined;

  for (const target of BROWSER_TARGETS) {
    const userDataDir = process.env.BROWSER_USER_DATA_DIR ?? target.userDataDir;

        console.log(`🔧 尝试 ${target.name}（${userDataDir}）...`);
    cleanStaleLocks(userDataDir);

    let context: import("playwright").BrowserContext | null = null;

    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        channel: target.channel,
        args: ["--disable-blink-features=AutomationControlled"],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("lock") || msg.includes("singleton") || msg.includes("closed")) {
        console.error(`   ⚠️ ${target.name} 启动失败（可能仍在运行或 Profile 被占用）。请完全关闭所有 ${target.name} 进程后重试。`);
        continue;
      }
      console.error(`   ⚠️ ${target.name} 启动失败:`, msg.substring(0, 120));
      continue;
    }

    try {
      const page = await context.newPage();
      await page.goto("https://opencode.ai", { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(2_000);

      const cookies = await context.cookies();
      const authCookie = cookies.find((c) => c.name === "auth" && c.domain.includes("opencode.ai"));

      if (!authCookie) {
        console.log(`   ℹ️ ${target.name} 中未找到 opencode.ai auth cookie`);
        continue;
      }

      authCookieValue = authCookie.value;
      console.log(`✅ 从 ${target.name} 提取到 auth cookie（${authCookieValue.length} 字符）`);
      console.log(`   有效期至: ${authCookie.expires ? new Date(authCookie.expires * 1000).toISOString() : "session"}`);

      // 验证 cookie
      const workspaceId = env.OPENCODE_GO_WORKSPACE_ID;
      if (!workspaceId) {
        console.warn("⚠️ .env 中未配置 OPENCODE_GO_WORKSPACE_ID，跳过验证");
      } else {
        console.log("🔍 验证 cookie 有效性...");
        const validation = await validateCookie(authCookieValue, workspaceId);
        if (!validation.valid) {
          console.error(`❌ Cookie 无效: ${validation.error}`);
          process.exit(1);
        }
        console.log(`✅ Cookie 验证通过，找到 ${validation.windows.join(", ")}`);
      }
      break;
    } finally {
      await context.close();
    }
  }

  if (!authCookieValue) {
    console.error("❌ 在所有浏览器中均未找到 OpenCode Go 的 auth cookie。");
    console.error("   请确认已在 Edge 或 Chrome 中登录 https://opencode.ai。");
    process.exit(1);
  }

  // 更新 Worker secret
  console.log("🔐 通过 Cloudflare API 更新 Worker secret...");
    await updateWorkerSecret(env, authCookieValue);

  // 同步本地 .env
  console.log("📝 更新本地 .env...");
  updateEnvFile(authCookieValue);

  // 写入 Supabase，使前端配置页和数据库账号直接生效
  const workspaceId = env.OPENCODE_GO_WORKSPACE_ID;
  const creds: Record<string, string> = { authCookie: authCookieValue };
  if (workspaceId) {
    creds.workspaceId = workspaceId;
  }
  console.log("🗄️ 同步凭据到 Supabase...");
  await updateSupabaseCredentials(env, "opencode-go", creds);

  console.log("🎉 完成！Worker 下次刷新（2 分钟内）将自动使用新 cookie。");
}

main().catch((err) => {
  console.error("❌ 脚本执行失败:", err);
  process.exit(1);
});
