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

import { readFileSync } from "node:fs";
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

// 通过 Cloudflare REST API 更新 Worker secret，避免 wrangler CLI 交互
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
  const { chromium } = await import("playwright");

  let authCookieValue: string | undefined;

  for (const target of BROWSER_TARGETS) {
    const userDataDir = process.env.BROWSER_USER_DATA_DIR ?? target.userDataDir;

    console.log(`🔧 尝试 ${target.name}（${userDataDir}）...`);

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

  console.log("🎉 完成！Worker 下次刷新（2 分钟内）将自动使用新 cookie。");
}

main().catch((err) => {
  console.error("❌ 脚本执行失败:", err);
  process.exit(1);
});
