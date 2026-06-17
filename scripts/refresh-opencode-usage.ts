/**
 * OpenCode Go 用量抓取脚本
 *
 * 功能：从本地浏览器 Profile 提取 auth cookie，抓取 opencode 用量页，
 *       解析为标准快照后推送到 Worker 的 /api/ingest/opencode-go 端点。
 *       绕开 Worker 被 opencode 数据中心 IP 封锁的问题。
 *
 * 前置条件：
 *   1. Edge 或 Chrome 浏览器中已登录 https://opencode.ai
 *   2. 运行前关闭所有浏览器窗口（含后台进程），避免 Profile 锁定
 *   3. .env 中已配置 INGEST_API_KEY、APIMONITOR_INGEST_URL、OPENCODE_GO_WORKSPACE_ID
 *
 * 使用：
 *   node --experimental-strip-types scripts/refresh-opencode-usage.ts
 *
 * 说明：APIMONITOR_INGEST_URL 已配置为自定义域名 apimonitor.bondtoolbox.asia，
 *       该域名国内可直连（不受 *.workers.dev 的 SNI 阻断影响），无需设置代理。
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

// 以下解析逻辑移植自 worker/providers/opencode-go-parser.ts，保持一致
const WINDOW_KEYS = ["rolling", "weekly", "monthly"] as const;
type WindowKey = (typeof WINDOW_KEYS)[number];

function toBeijingOffsetIso(date: Date): string {
  const beijingDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return beijingDate.toISOString().replace(/\.\d{3}Z$/, "+08:00");
}

function parseWindow(html: string, key: WindowKey): { used: number; resetInSec?: number } | null {
  const pattern = new RegExp(`${key}Usage:\\$R\\[\\d+\\]=\\{([^}]*)\\}`, "i");
  const match = html.match(pattern);
  if (!match?.[1]) return null;

  const body = match[1];
  const usedMatch = body.match(/usagePercent:([0-9]+(?:\.[0-9]+)?)/i);
  const resetMatch = body.match(/resetInSec:([0-9]+(?:\.[0-9]+)?)/i);
  const used = usedMatch ? Number(usedMatch[1]) : Number.NaN;
  if (!Number.isFinite(used)) return null;

  return {
    used,
    resetInSec: resetMatch ? Number(resetMatch[1]) : undefined,
  };
}

function parseOpenCodeGoWindows(html: string, now: Date): Array<{
  key: string;
  label: string;
  used: number;
  limit: number;
  remaining: number;
  percentUsed: number;
  percentRemaining: number;
  resetAt: string | null;
}> {
  return WINDOW_KEYS.flatMap((key) => {
    const parsed = parseWindow(html, key);
    if (!parsed) return [];

    return [{
      key,
      label: key === "rolling" ? "5h" : key === "weekly" ? "Weekly" : "Monthly",
      used: parsed.used,
      limit: 100,
      remaining: Math.max(0, 100 - parsed.used),
      percentUsed: Math.min(100, parsed.used),
      percentRemaining: Math.max(0, 100 - parsed.used),
      resetAt: parsed.resetInSec
        ? toBeijingOffsetIso(new Date(now.getTime() + parsed.resetInSec * 1000))
        : null,
    }];
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  console.log("✅ 环境变量加载成功");

  const missing = ["INGEST_API_KEY", "APIMONITOR_INGEST_URL", "OPENCODE_GO_WORKSPACE_ID"].filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`缺少环境变量: ${missing.join(", ")}。请在 .env 中配置。`);
    process.exit(1);
  }
  console.log(`   推送目标: ${env.APIMONITOR_INGEST_URL}`);

  const workspaceId = env.OPENCODE_GO_WORKSPACE_ID;
  const sourceUrl = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;

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
      break;
    } finally {
      await context.close();
    }
  }

  if (!authCookieValue) {
    console.error("❌ 在所有浏览器中均未找到 opencode.ai auth cookie。请确认已登录。");
    process.exit(1);
  }

  // 抓取用量页（本地直连国内 IP 可达）
  console.log("🌐 抓取 OpenCode Go 用量页...");
  const resp = await fetch(sourceUrl, {
    redirect: "manual",
    headers: {
      Cookie: `auth=${authCookieValue}`,
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApiMonitor/0.1",
    },
  });

  if (resp.status >= 300 && resp.status < 400) {
    const location = resp.headers.get("location") ?? "";
    console.error(`❌ 被重定向到登录页: ${location}（cookie 无效或当前出口 IP 被封）`);
    process.exit(1);
  }
  if (!resp.ok) {
    console.error(`❌ 用量页返回 HTTP ${resp.status}`);
    process.exit(1);
  }

  const html = await resp.text();
  const now = new Date();
  const windows = parseOpenCodeGoWindows(html, now);
  if (windows.length === 0) {
    console.error("❌ 页面已加载但未找到用量窗口数据");
    process.exit(1);
  }
  console.log(`✅ 解析到 ${windows.length} 个用量窗口: ${windows.map((w) => `${w.key}=${w.used}%`).join(", ")}`);

  // 构造标准快照（字段与 worker/providers/opencode-go.ts 的 createResult 对齐）
  const capturedAt = now.toISOString();
  const snapshot = {
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    sourceUrl,
    status: "ready" as const,
    capturedAt,
    summary: "OpenCode Go usage windows parsed",
    windows,
    metrics: {
      hasRolling: windows.some((w) => w.key === "rolling"),
      hasWeekly: windows.some((w) => w.key === "weekly"),
      hasMonthly: windows.some((w) => w.key === "monthly"),
    },
    meta: { fetchMethod: "local_ingest" },
  };

  // 推送到 Worker ingest 端点
  console.log("📤 推送快照到 Worker ingest 端点...");
  const ingestUrl = `${env.APIMONITOR_INGEST_URL.replace(/\/$/, "")}/api/ingest/opencode-go`;
  const ingestResp = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      "X-Ingest-Key": env.INGEST_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ snapshot }),
  });

  if (ingestResp.status === 401) {
    console.error("❌ 推送鉴权失败：INGEST_API_KEY 与 Worker 端不一致");
    process.exit(1);
  }
  if (!ingestResp.ok) {
    const errorBody = await ingestResp.text();
    console.error(`❌ 推送失败: HTTP ${ingestResp.status} - ${errorBody}`);
    process.exit(1);
  }

  const result = (await ingestResp.json()) as { ok: boolean; data?: { capturedAt: string } };
  console.log(`🎉 完成！快照已推送（capturedAt: ${result.data?.capturedAt ?? capturedAt}）`);
  console.log("   看板下次加载 /api/usage 将展示该快照（最近成功快照回退）。");
}

main().catch((err) => {
  console.error("❌ 脚本执行失败:", err);
  process.exit(1);
});
