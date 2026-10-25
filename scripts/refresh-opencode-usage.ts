/**
 * OpenCode Go 用量抓取脚本（新版控制台 /console）
 *
 * 功能：优先用 .env 缓存的 __Host-console_session cookie 直接调
 *       https://opencode.ai/console/api/go/status（需要 x-org-id 头），解析三个用量窗口后
 *       推送到 Worker 的 /api/ingest/opencode-go 端点。
 *       cookie 缺失/失效时才启动 Edge Profile 打开控制台，并保留窗口等你手动登录。
 *       这样正常刷新不需要每次开浏览器，绕开 Worker 被 opencode 数据中心 IP 封锁的问题。
 *
 * 前置条件：
 *   1. .env 中已配置 INGEST_API_KEY、APIMONITOR_INGEST_URL
 *   2. .env 中配置 OPENCODE_GO_WORKSPACE_ID（账号1）/ OPENCODE_GO_WORKSPACE2_ID（账号2）
 *   3. 首次运行或 cookie 过期时，Edge Profile 已登录 opencode（脚本会打开窗口等你登录）
 *   4. 运行前关闭所有 Edge 窗口（脚本也会主动结束 Edge 进程，避免 Profile 锁定）
 *
 * 使用：
 *   node --experimental-strip-types scripts/refresh-opencode-usage.ts
 *   node --experimental-strip-types scripts/refresh-opencode-usage.ts --no-wait-login
 *
 * 说明：APIMONITOR_INGEST_URL 已配置为自定义域名 apimonitor.bondtoolbox.asia，
 *       该域名国内可直连（不受 *.workers.dev 的 SNI 阻断影响），无需设置代理。
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { parseOpenCodeGoStatus, type OpenCodeGoStatusPayload } from "../worker/providers/opencode-go-parser.ts";

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

// 更新 .env 中指定键的值；不存在的键追加到末尾（只写 cookie 值，不进日志）
function updateEnvKey(envPath: string, key: string, value: string): void {
  const content = readFileSync(envPath, "utf-8");
  const lines = content.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  let found = false;
  const updated = lines.map((line) => {
    if (!pattern.test(line)) return line;
    found = true;
    return `${key}="${value}"`;
  });
  if (!found) updated.push(`${key}="${value}"`);
  writeFileSync(envPath, updated.join("\n"), "utf-8");
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

type AccountConfig = {
  label: string;
  profileDirectory: string;
  workspaceIdEnv: string;
  sessionCookieEnv: string;
  // optional=true 的账号（例如已停用）拿不到数据时直接跳过，不等待人工登录
  optional: boolean;
};

// 账号列表：每个账号绑定专属 Edge Profile 与 workspaceId / session cookie 环境变量
const ACCOUNTS: AccountConfig[] = [
  {
    label: "jarvislee90s",
    profileDirectory: "Default",
    workspaceIdEnv: "OPENCODE_GO_WORKSPACE_ID",
    sessionCookieEnv: "OPENCODE_GO_SESSION_COOKIE",
    optional: false,
  },
  {
    label: "lijiawei_jarvis",
    profileDirectory: "Profile 1",
    workspaceIdEnv: "OPENCODE_GO_WORKSPACE2_ID",
    sessionCookieEnv: "OPENCODE_GO_SESSION_COOKIE2",
    optional: true,
  },
];

const SESSION_COOKIE_NAME = "__Host-console_session";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const API_URL = "https://opencode.ai/console/api/go/status";
const LOGIN_WAIT_MS = 300_000;

function dashboardUrl(workspaceId: string): string {
  return `https://opencode.ai/console/${encodeURIComponent(workspaceId)}/go`;
}

// 归一化 cookie：支持完整 cookie 串、单条 name=value、裸值；旧格式 auth=... 视为不可用
function normalizeCookie(rawCookie: string | undefined): string | undefined {
  const trimmed = rawCookie?.trim();
  if (!trimmed) return undefined;

  const parts = trimmed.split(";").map((part) => part.trim()).filter((part) => part.length > 0);
  const sessionPart = parts.find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (sessionPart) return sessionPart.slice(SESSION_COOKIE_NAME.length + 1);
  if (trimmed.includes("=")) {
    return trimmed.startsWith("auth=") ? undefined : trimmed;
  }
  return trimmed;
}

type StatusResult =
  | { ok: true; payload: OpenCodeGoStatusPayload }
  | { ok: false; kind: "unauthorized" | "forbidden" | "http" | "network" | "parse"; status?: number; message: string };

// 调新版控制台用量接口：必须同时带 __Host-console_session cookie 与 x-org-id 头
async function fetchGoStatus(workspaceId: string, cookieValue: string): Promise<StatusResult> {
  try {
    const response = await fetch(API_URL, {
      headers: {
        accept: "application/json",
        "x-org-id": workspaceId,
        cookie: `${SESSION_COOKIE_NAME}=${cookieValue}`,
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();

    if (response.status === 401) {
      return { ok: false, kind: "unauthorized", status: 401, message: "session 无效或已过期" };
    }
    if (response.status === 403) {
      return { ok: false, kind: "forbidden", status: 403, message: "该 session 无权访问此 workspace（登录了其它账号）" };
    }
    if (!response.ok) {
      return { ok: false, kind: "http", status: response.status, message: `HTTP ${response.status}` };
    }

    try {
      return { ok: true, payload: JSON.parse(text) as OpenCodeGoStatusPayload };
    } catch {
      return { ok: false, kind: "parse", status: response.status, message: "接口返回非 JSON" };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: "network", message };
  }
}

async function readSessionCookie(context: import("playwright").BrowserContext): Promise<string | undefined> {
  const cookies = await context.cookies();
  const cookie = cookies.find(
    (item) => item.name === SESSION_COOKIE_NAME && item.domain.includes("opencode.ai"),
  );
  return cookie?.value;
}

// 解析并推送快照；成功返回 true
async function pushSnapshot(
  env: Record<string, string>,
  account: AccountConfig,
  workspaceId: string,
  payload: OpenCodeGoStatusPayload,
): Promise<boolean> {
  const now = new Date();
  const windows = parseOpenCodeGoStatus(payload);
  if (windows.length === 0) {
    console.error(
      `❌ ${account.label} 接口返回成功，但没有 Go 订阅用量窗口（可能未订阅或接口字段变化）`,
    );
    return false;
  }
  console.log(
    `✅ ${account.label} 解析到 ${windows.length} 个用量窗口: ${windows.map((w) => `${w.key}=${w.used}%`).join(", ")}`,
  );

  const sourceUrl = dashboardUrl(workspaceId);
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
      product: payload.product ?? null,
      endsAt: payload.access?.endsAt ?? null,
      hasRolling: windows.some((w) => w.key === "rolling"),
      hasWeekly: windows.some((w) => w.key === "weekly"),
      hasMonthly: windows.some((w) => w.key === "monthly"),
    },
    // accountLabel 让 Supabase 按 source_url 区分账号，前端账号切换卡各显示一行
    meta: { fetchMethod: "local_ingest", accountLabel: account.label },
  };

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

type RefreshOutcome = "ok" | "skipped" | "failed";

// 获取 Playwright chromium（延迟加载：缓存 cookie 可用时完全不启动浏览器）
let chromiumModule: typeof import("playwright")["chromium"] | null = null;
async function getChromium(): Promise<typeof import("playwright")["chromium"]> {
  if (!chromiumModule) {
    const playwright = await import("playwright");
    chromiumModule = playwright.chromium;
  }
  return chromiumModule;
}

// 在 Edge Profile 中打开控制台，等待登录后拿到可用的 session cookie
async function loginInBrowser(
  account: AccountConfig,
  workspaceId: string,
  waitForLogin: boolean,
): Promise<{ cookie: string; result: Extract<StatusResult, { ok: true }> } | null> {
  killBrowserProcesses();

  const chromium = await getChromium();
  const userDataDir = process.env.BROWSER_USER_DATA_DIR ?? resolve(localAppData, "Microsoft/Edge/User Data");
  cleanStaleLocks(userDataDir);
  fixCrashedSession(userDataDir);
  console.log(`🔧 启动 Edge（${account.profileDirectory}）...`);

  let context: import("playwright").BrowserContext;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: { width: 1280, height: 900 },
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
    console.error(`   ⚠️ Edge 启动失败: ${msg.substring(0, 160)}`);
    return null;
  }

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const sourceUrl = dashboardUrl(workspaceId);
    console.log(`🌐 打开 ${sourceUrl} ...`);
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null);
    await page.waitForTimeout(3_000);

    let cookie = await readSessionCookie(context);
    let result = cookie ? await fetchGoStatus(workspaceId, cookie) : null;
    if (cookie && result?.ok) {
      console.log("✅ 当前 Profile 登录态有效（无需手动登录）");
      return { cookie, result };
    }

    const reason =
      result?.ok === false
        ? result.kind === "forbidden"
          ? `当前 Profile 登录的账号无权访问该 workspace（${result.message}）`
          : `接口返回：${result.message}`
        : "当前 Profile 没有 opencode 登录态";

    console.log("");
    console.log("══════════════════════════════════════════════════════════");
    console.log(`  ${account.label} 需要登录：${reason}`);
    if (!waitForLogin) {
      console.log("  当前为无人值守模式（--no-wait-login），本次跳过该账号");
      console.log("══════════════════════════════════════════════════════════");
      console.log("");
      return null;
    }
    console.log("  请在刚打开的 Edge 窗口里登录 opencode.ai：");
    console.log("    · 可用邮箱验证码 / GitHub / Google 任一方式");
    console.log("    · 登录后进入 Go 页面即可，脚本每 3 秒检测一次，成功后自动继续");
    console.log(`  （最长等待 ${LOGIN_WAIT_MS / 1000} 秒，随时可 Ctrl+C 退出）`);
    console.log("══════════════════════════════════════════════════════════");
    console.log("");

    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3_000);
      cookie = await readSessionCookie(context);
      if (!cookie) continue;
      result = await fetchGoStatus(workspaceId, cookie);
      if (result.ok) {
        console.log("✅ 检测到登录成功，session cookie 已就绪");
        return { cookie, result };
      }
    }

    console.error(`❌ 等待登录超时（${LOGIN_WAIT_MS / 1000} 秒），请重新运行脚本`);
    return null;
  } finally {
    await context.close();
  }
}

async function refreshAccount(
  env: Record<string, string>,
  envPath: string,
  account: AccountConfig,
  waitForLogin: boolean,
): Promise<RefreshOutcome> {
  const workspaceId = env[account.workspaceIdEnv];
  if (!workspaceId) {
    console.warn(`⚠️ 未配置 ${account.workspaceIdEnv}，跳过账号 ${account.label}`);
    return "skipped";
  }

  // 1) 优先用 .env 缓存的 session cookie（不启动浏览器）
  const cachedCookie = normalizeCookie(env[account.sessionCookieEnv]);
  if (cachedCookie) {
    const cachedResult = await fetchGoStatus(workspaceId, cachedCookie);
    if (cachedResult.ok) {
      console.log("♻️ 使用 .env 缓存的 session cookie（未启动浏览器）");
      return (await pushSnapshot(env, account, workspaceId, cachedResult.payload)) ? "ok" : "failed";
    }
    if (cachedResult.kind === "forbidden") {
      console.warn(`⚠️ 缓存 cookie 无权访问该 workspace：${cachedResult.message}`);
    } else {
      console.log(`ℹ️ 缓存 cookie 不可用（${cachedResult.message}），转浏览器登录`);
    }
  }

  // 2) 浏览器路径：可选账号（已停用）不再等待人工登录
  if (account.optional) {
    console.log(`ℹ️ 账号 ${account.label} 标记为可选（已停用），跳过浏览器登录；如需恢复请先确认账号状态`);
    return "skipped";
  }

  const loggedIn = await loginInBrowser(account, workspaceId, waitForLogin);
  if (!loggedIn) {
    return "failed";
  }

  // 3) 缓存新 cookie（只写 .env，不进日志）
  updateEnvKey(envPath, account.sessionCookieEnv, loggedIn.cookie);
  console.log(`💾 已把 ${account.sessionCookieEnv} 写入 .env`);

  return (await pushSnapshot(env, account, workspaceId, loggedIn.result.payload)) ? "ok" : "failed";
}

async function main(): Promise<void> {
  const envPath = resolve(process.cwd(), ".env");
  const env = loadEnv();
  console.log("✅ 环境变量加载成功");

  const missing = ["INGEST_API_KEY", "APIMONITOR_INGEST_URL"].filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`缺少环境变量: ${missing.join(", ")}。请在 .env 中配置。`);
    process.exit(1);
  }
  console.log(`   推送目标: ${env.APIMONITOR_INGEST_URL}`);

  // 一键刷新等非交互场景传 --no-wait-login，避免登录失效时卡住 5 分钟
  const waitForLogin = !process.argv.includes("--no-wait-login");
  if (!waitForLogin) {
    console.log("   模式: 无人值守（登录失效时跳过，不等待手动登录）");
  }

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const account of ACCOUNTS) {
    console.log(`\n━━━ 处理账号：${account.label} ━━━`);
    const outcome = await refreshAccount(env, envPath, account, waitForLogin);
    if (outcome === "ok") success += 1;
    else if (outcome === "failed") failed += 1;
    else skipped += 1;
  }

  console.log(`\n━━━ 汇总：成功 ${success} 个，失败 ${failed} 个，跳过 ${skipped} 个 ━━━`);
  if (success === 0) {
    console.error("❌ 没有账号刷新成功");
    process.exit(1);
  }
  console.log("   看板下次加载 /api/usage 将展示该快照（最近成功快照回退）。");
}

main().catch((err) => {
  console.error("❌ 脚本执行失败:", err);
  process.exit(1);
});
