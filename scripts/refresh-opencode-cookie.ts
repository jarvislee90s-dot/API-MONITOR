// scripts/refresh-opencode-cookie.ts
// 从浏览器 Profile 提取 OpenCode Go auth cookie，加密写入 Supabase
//
// 支持 Edge（默认）和 Chrome。Edge 没有 Chrome 的 DevTools 远程调试限制。

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

// 支持的浏览器列表，按优先级排序：Edge 优先（无 DevTools 限制）
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

async function main(): Promise<void> {
  const env = loadEnv();

  const missing: string[] = [];

  console.log("✅ 环境变量加载成功");

  function requireEnv(key: string): string {
    const value = env[key];
    if (!value) {
      missing.push(key);
    }
    return value ?? "";
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
      if (msg.includes("lock") || msg.includes("singleton")) {
        console.error(`   ⚠️ ${target.name} 正在运行，跳过。请关闭所有 ${target.name} 窗口后重试。`);
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
}

main().catch((err) => {
  console.error("❌ 脚本执行失败:", err);
  process.exit(1);
});
