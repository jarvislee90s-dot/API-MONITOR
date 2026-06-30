/**
 * OpenCode Go 用量抓取脚本
 *
 * 功能：从本地浏览器 Profile 提取 auth cookie，抓取 opencode 用量页，
 *       解析为标准快照后推送到 Worker 的 /api/ingest/opencode-go 端点。
 *       绕开 Worker 被 opencode 数据中心 IP 封锁的问题。
 *       支持多账号：每个账号绑定专属浏览器与 workspaceId，串行刷新互不阻塞。
 *
 * 前置条件：
 *   1. Edge 或 Chrome 浏览器中已登录 https://opencode.ai
 *   2. 运行前关闭所有浏览器窗口（含后台进程），避免 Profile 锁定
 *   3. .env 中已配置 INGEST_API_KEY、APIMONITOR_INGEST_URL
 *   4. .env 中配置 OPENCODE_GO_WORKSPACE_ID（账号1）和/或 OPENCODE_GO_WORKSPACE2_ID（账号2）
 *
 * 使用：
 *   node --experimental-strip-types scripts/refresh-opencode-usage.ts
 *
 * 说明：APIMONITOR_INGEST_URL 已配置为自定义域名 apimonitor.bondtoolbox.asia，
 *       该域名国内可直连（不受 *.workers.dev 的 SNI 阻断影响），无需设置代理。
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

// 终止浏览器残留进程，释放 Profile 锁（避免 launchPersistentContext 启动出空白实例）
function killBrowserProcesses(): void {
  const processNames = ["msedge.exe"];
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

// 修复 Chrome 非正常关闭后的崩溃恢复弹窗，该弹窗会阻塞 Playwright 的 CDP 连接
function fixCrashedSession(userDataDir: string): void {
  const prefsPath = resolve(userDataDir, "Default", "Preferences");
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

// 账号列表：每个账号绑定专属浏览器与 workspaceId 环境变量，串行刷新互不阻塞
type AccountConfig = {
  label: string;
  browserName: string;
  userDataDir: string;
  profileDirectory: string;
  workspaceIdEnv: string;
};

const ACCOUNTS: AccountConfig[] = [
  {
    label: "jarvislee90s",
    browserName: "Edge (Profile 1)",
    userDataDir: resolve(localAppData, "Microsoft/Edge/User Data"),
    profileDirectory: "Profile 1",
    workspaceIdEnv: "OPENCODE_GO_WORKSPACE_ID",
  },
  {
    label: "lijiawei_jarvis",
    browserName: "Edge (Default)",
    userDataDir: resolve(localAppData, "Microsoft/Edge/User Data"),
    profileDirectory: "Default",
    workspaceIdEnv: "OPENCODE_GO_WORKSPACE2_ID",
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

// 从指定浏览器 Profile 提取 opencode.ai 的 auth cookie
async function extractAuthCookie(
  chromium: typeof import("playwright")["chromium"],
  browserName: string,
  userDataDir: string,
  profileDirectory: string,
): Promise<string | null> {
  cleanStaleLocks(userDataDir);
  fixCrashedSession(userDataDir);
  console.log(`🔧 启动 ${browserName}（${profileDirectory}）...`);

  // Edge 允许在真实 Profile 上远程调试，用 launchPersistentContext + --profile-directory 区分账号
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
        `--profile-directory=${profileDirectory}`,
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`   ⚠️ ${browserName} 启动失败: ${msg.substring(0, 120)}`);
    return null;
  }

  try {
    const page = await context.newPage();
    await page.goto("https://opencode.ai", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2_000);

    const cookies = await context.cookies();
    const authCookie = cookies.find((c) => c.name === "auth" && c.domain.includes("opencode.ai"));
    if (!authCookie) {
      console.log(`   ℹ️ ${browserName} 中未找到 opencode.ai auth cookie`);
      return null;
    }
    console.log(`✅ 从 ${browserName} 提取到 auth cookie（${authCookie.value.length} 字符）`);
    return authCookie.value;
  } finally {
    await context.close();
  }
}

// 抓取单个账号用量页并推送快照，成功返回 true
async function refreshAccount(
  env: Record<string, string>,
  account: AccountConfig,
  authCookie: string,
): Promise<boolean> {
  const workspaceId = env[account.workspaceIdEnv];
  if (!workspaceId) {
    console.error(`❌ 账号 ${account.label} 缺少 ${account.workspaceIdEnv}，跳过`);
    return false;
  }
  const sourceUrl = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;

  // 抓取用量页（本地直连国内 IP 可达）
  console.log(`🌐 抓取 ${account.label} 用量页...`);
  const resp = await fetch(sourceUrl, {
    redirect: "manual",
    headers: {
      Cookie: `auth=${authCookie}`,
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApiMonitor/0.1",
    },
  });

  if (resp.status >= 300 && resp.status < 400) {
    const location = resp.headers.get("location") ?? "";
    console.error(`❌ ${account.label} 被重定向到登录页: ${location}（cookie 无效或出口 IP 被封）`);
    return false;
  }
  if (!resp.ok) {
    console.error(`❌ ${account.label} 用量页返回 HTTP ${resp.status}`);
    return false;
  }

  const html = await resp.text();
  const now = new Date();
  const windows = parseOpenCodeGoWindows(html, now);
  if (windows.length === 0) {
    console.error(`❌ ${account.label} 页面已加载但未找到用量窗口数据`);
    return false;
  }
  console.log(`✅ ${account.label} 解析到 ${windows.length} 个用量窗口: ${windows.map((w) => `${w.key}=${w.used}%`).join(", ")}`);

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
    // accountLabel 让 Supabase 按 source_url 区分账号，前端账号切换卡各显示一行
    meta: { fetchMethod: "local_ingest", accountLabel: account.label },
  };

  // 推送到 Worker ingest 端点
  console.log(`📤 推送 ${account.label} 快照到 Worker ingest 端点...`);
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
    console.error(`❌ ${account.label} 推送鉴权失败：INGEST_API_KEY 与 Worker 端不一致`);
    return false;
  }
  if (!ingestResp.ok) {
    const errorBody = await ingestResp.text();
    console.error(`❌ ${account.label} 推送失败: HTTP ${ingestResp.status} - ${errorBody}`);
    return false;
  }

  const result = (await ingestResp.json()) as { ok: boolean; data?: { capturedAt: string } };
  console.log(`🎉 ${account.label} 完成！快照已推送（capturedAt: ${result.data?.capturedAt ?? capturedAt}）`);
  return true;
}

async function main(): Promise<void> {
  const env = loadEnv();
  console.log("✅ 环境变量加载成功");

  const missing = ["INGEST_API_KEY", "APIMONITOR_INGEST_URL"].filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`缺少环境变量: ${missing.join(", ")}。请在 .env 中配置。`);
    process.exit(1);
  }
  console.log(`   推送目标: ${env.APIMONITOR_INGEST_URL}`);

  // 终止残留浏览器进程，释放 Profile 锁
  killBrowserProcesses();

  const { chromium } = await import("playwright");

  let success = 0;
  let failed = 0;

  for (const account of ACCOUNTS) {
    console.log(`\n━━━ 处理账号：${account.label} ━━━`);

    // 未配置该账号 workspaceId 则跳过（不计入失败）
    if (!env[account.workspaceIdEnv]) {
      console.warn(`⚠️ 未配置 ${account.workspaceIdEnv}，跳过账号 ${account.label}`);
      continue;
    }

    const userDataDir = process.env.BROWSER_USER_DATA_DIR ?? account.userDataDir;
    const authCookie = await extractAuthCookie(chromium, account.browserName, userDataDir, account.profileDirectory);
    if (!authCookie) {
      console.error(`❌ 账号 ${account.label} 未提取到 auth cookie`);
      failed += 1;
      continue;
    }

    const ok = await refreshAccount(env, account, authCookie);
    if (ok) {
      success += 1;
    } else {
      failed += 1;
    }
  }

  console.log(`\n━━━ 汇总：成功 ${success} 个，失败 ${failed} 个 ━━━`);
  if (success === 0) {
    console.error("❌ 所有账号刷新均失败");
    process.exit(1);
  }
  console.log("   看板下次加载 /api/usage 将展示该快照（最近成功快照回退）。");
}

main().catch((err) => {
  console.error("❌ 脚本执行失败:", err);
  process.exit(1);
});