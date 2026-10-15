/**
 * ChatGPT 本机抓取共享工具（被 import-chatgpt-credentials.ts 与 refresh-chatgpt-usage.ts 复用）
 *
 * 为什么需要本机抓取：实测 Cloudflare Worker 出口与 Browser Rendering 出口访问 chatgpt.com
 * 均被 403 整体拒绝（含 robots.txt，无 cf-mitigated 头，返回 CF 拦截 HTML 页），
 * 因此云端无法取 ChatGPT 数据，只能借本机浏览器会话（住宅 IP + 真实指纹 + cf_clearance）取数。
 *
 * 关键实现约定：
 *   - 登录判定只认服务端 /api/auth/session 的响应，不做任何页面 DOM 选择器假设；
 *   - 取数走页面内同源 fetch（credentials: include），绕开 CF 对纯 fetch 的质询；
 *   - NextAuth session token 超 4KB 会分片为 name.0/name.1，按分片号排序原样拼接回发；
 *   - 输出只打印脱敏 hint，凭据不落盘、不进 git。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright";

export const PROFILE_DIR = resolve(process.cwd(), "output/chatgpt-browser-profile");
export const CHATGPT_HOME = "https://chatgpt.com";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
export const AUTH_SESSION_URL = "https://chatgpt.com/api/auth/session";
// 等待人工登录的时长；可用 CHATGPT_LOGIN_WAIT_MS 覆盖（自动化/自测场景）
export const LOGIN_WAIT_MS = Number(process.env.CHATGPT_LOGIN_WAIT_MS ?? 300_000);
// 与真实浏览器一致的 UA，避免服务端接口按自动化 UA 拒绝
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function loadEnv(): Record<string, string> {
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

export function readCodexAuthJson(path: string): {
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

export function maskHint(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

// Node 的 fetch 默认不走 Windows 系统代理（国内直连 chatgpt.com 会失败）；
// 检测到可达的系统代理时以 NODE_USE_ENV_PROXY=1 重启自身，让内置 fetch 显式走代理。
// 注意：读注册表必须用 spawnSync 参数数组——execSync 经 cmd.exe 传参会吃掉路径里的反斜杠。
let cachedProxy: string | null | undefined;

export function detectProxy(): string | null {
  if (cachedProxy !== undefined) return cachedProxy;
  const fromEnv = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null;
  if (fromEnv) {
    cachedProxy = fromEnv;
    return cachedProxy;
  }
  if (process.platform !== "win32") {
    cachedProxy = null;
    return null;
  }
  try {
    const settingsKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const run = (value: string) =>
      spawnSync("reg", ["query", settingsKey, "/v", value], { encoding: "utf8" });
    const enabled = run("ProxyEnable");
    if (enabled.status !== 0 || !/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enabled.stdout ?? "")) {
      cachedProxy = null;
      return null;
    }
    const server = run("ProxyServer");
    const matched =
      server.status === 0 ? /ProxyServer\s+REG_SZ\s+(\S+)/.exec(server.stdout ?? "") : null;
    cachedProxy = matched
      ? matched[1].startsWith("http")
        ? matched[1]
        : `http://${matched[1]}`
      : null;
    return cachedProxy;
  } catch {
    cachedProxy = null;
    return null;
  }
}

export function proxyReachable(proxyUrl: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const url = new URL(proxyUrl);
      const socket = connect(
        { host: url.hostname, port: Number(url.port) || 80, timeout: timeoutMs },
        () => {
          socket.destroy();
          resolve(true);
        },
      );
      socket.on("error", () => resolve(false));
      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

// 返回 true 表示已重启子进程接管执行，当前进程应停在原地等待子进程退出
export async function ensureProxyOrRespawn(): Promise<boolean> {
  if (process.env.NODE_USE_ENV_PROXY === "1") return false;
  const proxy = detectProxy();
  if (!proxy) return false;
  if (!(await proxyReachable(proxy))) {
    console.warn(`[WARN] 系统代理 ${proxy} 当前不可达，将直连（请先启动代理软件，或用 HTTPS_PROXY 指定其他地址）`);
    return false;
  }
  console.log(`[INFO] 检测到可达代理 ${proxy}，以 NODE_USE_ENV_PROXY=1 重启自身使 fetch 走代理 ...`);
  const child = spawn(
    process.execPath,
    // argv[1] 是脚本路径，必须保留；respawn 参数 = [node, --experimental-strip-types, 脚本, ...用户参数]
    ["--experimental-strip-types", process.argv[1]!, ...process.argv.slice(2)],
    {
      env: { ...process.env, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: proxy, HTTP_PROXY: proxy },
      stdio: "inherit",
    },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
  return true;
}

// NextAuth 的 session token 超过单 cookie 上限（约 4KB）时会分片存储为 name.0 / name.1 ...，
// 必须收集全部分片按序拼接；向服务端发送与入库均按浏览器原样形态（name.0=v0; name.1=v1）。
function chunkIndex(name: string): number {
  const matched = /\.(\d+)$/.exec(name);
  return matched ? Number(matched[1]) : -1;
}

export function buildSessionCookieHeader(cookies: Array<{ name: string; value: string }>): string | null {
  const parts = cookies
    .filter((cookie) => /^__Secure-next-auth\.session-token(\.\d+)?$/.test(cookie.name))
    .sort((a, b) => chunkIndex(a.name) - chunkIndex(b.name));
  if (parts.length === 0) return null;
  return parts.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export const SUBSCRIPTION_CHECK_V4_URL = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";

// v4 accounts/check 响应体 → 档位：accounts.<id>.account.plan_type（plus/free/guest…），
// 缺失时退到 entitlement.subscription_plan。访客会话同样返回 200 但 plan_type=guest，
// 不能当作"已登录真实账号"（也就读不到订阅档位/续费日期/网页额度）
export function parseWebPlanType(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const accounts = (body as { accounts?: Record<string, Record<string, unknown>> }).accounts;
  if (!accounts || typeof accounts !== "object") return null;
  const entry = Object.values(accounts)[0];
  if (!entry) return null;
  const account = (entry.account as Record<string, unknown> | undefined) ?? {};
  const entitlement = (entry.entitlement as Record<string, unknown> | undefined) ?? {};
  if (typeof account.plan_type === "string") return account.plan_type.toLowerCase();
  if (typeof entitlement.subscription_plan === "string") return entitlement.subscription_plan.toLowerCase();
  return null;
}

export async function readWebPlanType(page: import("playwright").Page): Promise<string | null> {
  const result = await fetchInPage(page, SUBSCRIPTION_CHECK_V4_URL, { Accept: "application/json" });
  return parseWebPlanType(result?.body);
}

export type BrowserSession = {
  cookieHeader: string | null;
  page: import("playwright").Page;
  context: import("playwright").BrowserContext;
};

// 从专用 Profile 提取 chatgpt.com 的 session cookie；未登录则打开页面等待人工登录。
// 登录判定在浏览器页面内同源请求 /api/auth/session（完整浏览器指纹 + 自动携带 cookie），
// 不做任何页面 DOM 选择器假设；返回页面句柄供后续取数复用（调用方负责关闭 context）。
export async function extractSessionToken(
  forceRelogin: boolean,
  options: { requireRealAccount?: boolean } = {},
): Promise<BrowserSession | null> {
  // 检测到可达代理时显式传给 Chromium，避免依赖（可能残留失效的）系统代理设置
  const proxy = detectProxy();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
    ...(proxy ? { proxy: { server: proxy } } : {}),
  });

  try {
    // --relogin：先清空旧 cookie，避免残留死 session-token 干扰（换账号 / cookie 污染场景）
    if (forceRelogin) {
      await context.clearCookies();
      console.log("[INFO] 已清除 Profile 中的旧 cookie（--relogin）");
    }

    const page = context.pages()[0] ?? (await context.newPage());
    console.log(`[INFO] 打开 ${CHATGPT_HOME} ...`);
    await page.goto(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const readCookieHeader = async (): Promise<string | null> =>
      buildSessionCookieHeader(await context.cookies("https://chatgpt.com"));

    // 登录判定：页面内同源 fetch session 端点，服务端认可当前登录态
    // requireRealAccount：还要求不是访客会话（访客同样 200，但拿不到订阅/网页额度数据）
    let guestHinted = false;
    const loggedIn = async (): Promise<boolean> => {
      const result = await fetchInPage(page, AUTH_SESSION_URL);
      const body = result?.body as { accessToken?: unknown } | null | undefined;
      const accepted =
        result !== null &&
        result.status === 200 &&
        (typeof body?.accessToken === "string" && body.accessToken.length > 0
          ? true
          : // 部分会话不再返回 accessToken：退回档位判定
            (await readWebPlanType(page)) !== null);
      if (!accepted) return false;
      if (!options.requireRealAccount) return true;
      const plan = await readWebPlanType(page);
      if (plan === "guest" || plan === null) {
        if (!guestHinted) {
          guestHinted = true;
          console.log("[HINT] 当前是访客会话（plan=guest），需要完成 Google 登录才能读取订阅与网页额度数据");
        }
        return false;
      }
      return true;
    };

    console.log("[INFO] 检查登录态 ...");
    await page.waitForTimeout(3_000);
    if (await loggedIn()) {
      const cookieHeader = await readCookieHeader();
      if (cookieHeader) return { cookieHeader, page, context };
    }

    console.log("");
    console.log("═════════════════════════════════════════════════");
    console.log("  请在打开的浏览器窗口中完成 Google 登录（脚本不自动化登录）");
    console.log(`  登录成功后自动继续，最长等待 ${LOGIN_WAIT_MS / 1000} 秒`);
    console.log("═════════════════════════════════════════════════");
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      if (await loggedIn()) {
        const cookieHeader = await readCookieHeader();
        if (cookieHeader) return { cookieHeader, page, context };
      }
      await page.waitForTimeout(2_000);
    }
    console.error(`[FAIL] 登录超时（${LOGIN_WAIT_MS / 1000} 秒）`);
    // 超时仍返回页面句柄：允许仅用 Codex 凭据继续（cookieHeader 为 null）
    return { cookieHeader: null, page, context };
  } catch (error) {
    await context.close();
    throw error;
  }
}

// 页面内同源 fetch：借浏览器完整指纹与 Profile 中的 cf_clearance 绕开 CF 对纯 fetch 的质询。
// credentials 默认 "include"（网页链路需要 session cookie）；Codex 链路必须用 "omit"——
// 同时携带 session cookie 与 CLI Bearer 会被服务端判为 token_expired（实测 2026-10-15）。
// SPA 在请求期间可能跳转导致执行上下文销毁（实测），这类错误重试并等待页面稳定。
export async function fetchInPage(
  page: import("playwright").Page,
  url: string,
  headers?: Record<string, string>,
  credentials: RequestCredentials = "include",
): Promise<{ status: number; cfMitigated: string | null; body: unknown } | null> {
  const attemptOnce = () =>
    page.evaluate(
      async ({ url, headers, credentials }) => {
        try {
          const resp = await fetch(url, { headers, credentials });
          let body: unknown = null;
          try {
            body = await resp.json();
          } catch {
            body = null;
          }
          return { status: resp.status, cfMitigated: resp.headers.get("cf-mitigated"), body };
        } catch {
          return null;
        }
      },
      { url, headers: headers ?? {}, credentials },
    );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await attemptOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = /Execution context was destroyed|Target closed|navigat/i.test(message);
      if (!transient || attempt === 2) throw error;
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(1_200);
    }
  }
  return null;
}
