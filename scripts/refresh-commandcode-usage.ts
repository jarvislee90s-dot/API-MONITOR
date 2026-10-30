/**
 * Command Code 用量抓取脚本（api.commandcode.ai）
 *
 * 功能：用项目专用浏览器 Profile（output/commandcode-profile）打开 control panel，
 *       提取 __Secure-commandcode_prod_.session_token，调用三个内部接口：
 *         /internal/usage/summary      总 token / 总请求 / 花费 / 计费周期
 *         /internal/usage/by-model     按模型聚合（Top5）
 *         /internal/billing/credits    5h / 周 / 月额度窗口
 *       组装快照后推送到 Worker /api/ingest/commandcode，并同步 cookie 到：
 *         .env / Cloudflare Worker secret / Supabase 加密凭据 / Supabase Edge Function secrets。
 *
 * 使用：
 *   node --experimental-strip-types scripts/refresh-commandcode-usage.ts
 *   node --experimental-strip-types scripts/refresh-commandcode-usage.ts --no-wait-login
 *
 * 说明：首次运行或登录态失效时，会打开浏览器窗口等你手动登录（最长 300 秒）；
 *       登录后 cookie 保存在专用 Profile，之后脚本直接复用、不会再弹登录。
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import crypto from "node:crypto";
import {
  parseCommandCodeTopModels,
  parseCommandCodeWindows,
  type CommandCodeByModel,
  type CommandCodeCredits,
  type CommandCodeSummary,
} from "../worker/providers/commandcode-parser.ts";

const SESSION_COOKIE_NAME = "__Secure-commandcode_prod_.session_token";
const DEFAULT_ACCOUNT = "jarvislee90s-dot";
const DEFAULT_API_BASE = "https://api.commandcode.ai";
const SITE_ORIGIN = "https://commandcode.ai";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const LOGIN_WAIT_MS = 300_000;
const PROFILE_DIR = resolve(process.cwd(), "output/commandcode-profile");

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

function killBrowserProcesses(): void {
  for (const name of ["msedge.exe", "chrome.exe"]) {
    try {
      execSync(`taskkill /F /IM ${name} /T 2>nul`, { stdio: "ignore" });
    } catch {
      // ignore
    }
  }
  try { execSync("timeout /T 2 /NOBREAK 2>nul", { stdio: "ignore" }); } catch { /* ignore */ }
}

function cleanStaleLocks(userDataDir: string): void {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      const lockPath = resolve(userDataDir, name);
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

function usageUrl(account: string): string {
  return `${SITE_ORIGIN}/zh/${encodeURIComponent(account)}/settings/usage`;
}

type Bundle = {
  summary: CommandCodeSummary;
  byModel: CommandCodeByModel;
  credits: CommandCodeCredits;
};

async function fetchBundle(apiBase: string, cookieValue: string, account: string): Promise<Bundle> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": USER_AGENT,
    cookie: `${SESSION_COOKIE_NAME}=${cookieValue}`,
    origin: SITE_ORIGIN,
    referer: usageUrl(account),
  };
  const [summaryResp, byModelResp, creditsResp] = await Promise.all([
    fetch(`${apiBase}/internal/usage/summary`, { headers, signal: AbortSignal.timeout(20_000) }),
    fetch(`${apiBase}/internal/usage/by-model`, { headers, signal: AbortSignal.timeout(20_000) }),
    fetch(`${apiBase}/internal/billing/credits`, { headers, signal: AbortSignal.timeout(20_000) }),
  ]);

  if ([summaryResp, byModelResp, creditsResp].some((resp) => resp.status === 401 || resp.status === 403)) {
    throw new Error("LOGIN_REQUIRED");
  }
  if (!summaryResp.ok || !byModelResp.ok || !creditsResp.ok) {
    throw new Error(`接口返回 HTTP ${summaryResp.status}/${byModelResp.status}/${creditsResp.status}`);
  }

  return {
    summary: (await summaryResp.json()) as CommandCodeSummary,
    byModel: (await byModelResp.json()) as CommandCodeByModel,
    credits: (await creditsResp.json()) as CommandCodeCredits,
  };
}

function buildSnapshot(bundle: Bundle, account: string) {
  const windows = parseCommandCodeWindows(bundle.credits, bundle.summary);
  const topModels = parseCommandCodeTopModels(bundle.byModel, bundle.summary.totalTokens);
  const capturedAt = new Date().toISOString();
  return {
    providerId: "commandcode",
    providerName: "Command Code",
    sourceUrl: usageUrl(account),
    status: windows.length > 0 ? "ready" : "partial",
    capturedAt,
    summary: `Command Code 用量已解析（${topModels.length} 个模型）`,
    windows,
    metrics: {
      totalTokens: bundle.summary.totalTokens ?? null,
      totalRequests: bundle.summary.totalCount ?? null,
      totalCost: bundle.summary.totalCost ?? null,
      periodStart: bundle.summary.periodStart ?? null,
      topModels: JSON.stringify(topModels),
    },
    meta: { fetchMethod: "local_ingest", accountLabel: account },
  };
}

async function pushSnapshot(env: Record<string, string>, snapshot: ReturnType<typeof buildSnapshot>): Promise<boolean> {
  const ingestUrl = `${env.APIMONITOR_INGEST_URL.replace(/\/$/, "")}/api/ingest/commandcode`;
  const resp = await fetch(ingestUrl, {
    method: "POST",
    headers: { "X-Ingest-Key": env.INGEST_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ snapshot }),
  });
  if (resp.status === 401) {
    console.error("❌ 推送鉴权失败：INGEST_API_KEY 与 Worker 端不一致");
    return false;
  }
  if (!resp.ok) {
    console.error(`❌ 推送失败: HTTP ${resp.status} - ${(await resp.text()).slice(0, 200)}`);
    return false;
  }
  console.log(`🎉 快照已推送（${snapshot.windows.length} 个窗口，${snapshot.metrics.topModels ? "含 Top5 模型" : "无模型数据"}）`);
  return true;
}

async function updateWorkerSecret(env: Record<string, string>, cookieValue: string): Promise<void> {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    console.warn("⚠️ 缺少 CLOUDFLARE_API_TOKEN，跳过 Worker secret 更新");
    return;
  }
  try {
    const accountsResp = await fetch("https://api.cloudflare.com/client/v4/accounts", {
      headers: { authorization: `Bearer ${token}` },
    });
    const accounts = (await accountsResp.json()) as { success: boolean; result?: Array<{ id: string }> };
    const accountId = accounts.result?.[0]?.id;
    if (!accountId) {
      console.warn("⚠️ 获取 Cloudflare account 失败，跳过 Worker secret 更新");
      return;
    }
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/apimonitor/secrets`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "COMMANDCODE_SESSION_COOKIE", text: cookieValue, type: "secret_text" }),
      },
    );
    const json = (await resp.json()) as { success: boolean };
    console.log(json.success ? "✅ Worker secret COMMANDCODE_SESSION_COOKIE 已更新" : `⚠️ Worker secret 更新失败: HTTP ${resp.status}`);
  } catch (error) {
    console.warn(`⚠️ Worker secret 更新异常: ${String(error)}`);
  }
}

async function updateEdgeFunctionSecrets(env: Record<string, string>, cookieValue: string): Promise<void> {
  const token = env.Access_Token ?? env.SUPABASE_ACCESS_TOKEN;
  const projectRef = env.SUPABASE_PROJECT_REF ?? "cdzjuvewreribelvpccz";
  if (!token) {
    console.warn("⚠️ 缺少 Access_Token，跳过 Edge Function secret 更新");
    return;
  }
  try {
    const resp = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/secrets`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([
        { name: "COMMANDCODE_SESSION_COOKIE", value: cookieValue },
        { name: "COMMANDCODE_ACCOUNT", value: env.COMMANDCODE_ACCOUNT ?? DEFAULT_ACCOUNT },
      ]),
    });
    console.log(resp.ok ? "✅ Supabase Edge Function secrets 已更新" : `⚠️ Edge Function secrets 更新失败: HTTP ${resp.status}`);
  } catch (error) {
    console.warn(`⚠️ Edge Function secrets 更新异常: ${String(error)}`);
  }
}

// 同步 Supabase：账号行 + 加密凭据 + 看板显示配置（首次运行会创建）
async function updateSupabaseAccount(
  env: Record<string, string>,
  cookieValue: string,
  account: string,
): Promise<void> {
  const base = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const userId = env.SUPABASE_USER_ID;
  const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
  if (!base || !serviceKey || !userId || !encryptionKey) {
    console.warn("⚠️ 缺少 Supabase 配置（URL / SERVICE_ROLE_KEY / USER_ID / CREDENTIAL_ENCRYPTION_KEY），跳过账号同步");
    return;
  }
  const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" };
  const sourceUrl = usageUrl(account);

  try {
    const existing = await fetch(
      `${base}/rest/v1/provider_accounts?select=id&provider_key=eq.commandcode&user_id=eq.${userId}`,
      { headers },
    );
    const rows = (await existing.json()) as Array<{ id?: string }>;
    let accountId = rows[0]?.id;

    if (!accountId) {
      const created = await fetch(`${base}/rest/v1/provider_accounts`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({
          user_id: userId,
          provider_key: "commandcode",
          account_label: account,
          display_name: account,
          source_url: sourceUrl,
          homepage_enabled: true,
          homepage_order: 10,
          status: "ready",
          credential_hint: {},
        }),
      });
      const createdRows = (await created.json()) as Array<{ id?: string }>;
      accountId = createdRows[0]?.id;
    }
    if (!accountId) {
      console.warn("⚠️ 无法创建/找到 Command Code 账号，跳过凭据同步");
      return;
    }

    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(encryptionKey, "utf8"), nonce);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify({ sessionCookie: cookieValue, account }), "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const credResp = await fetch(`${base}/rest/v1/provider_account_credentials?on_conflict=provider_account_id`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([
        {
          user_id: userId,
          provider_account_id: accountId,
          encrypted_payload: encrypted.toString("base64"),
          nonce: nonce.toString("base64"),
          key_version: "v1",
        },
      ]),
    });
    console.log(credResp.ok ? "✅ Supabase 加密凭据已同步" : `⚠️ Supabase 凭据同步失败: HTTP ${credResp.status}`);

    const prefResp = await fetch(`${base}/rest/v1/provider_preferences?on_conflict=user_id,provider_key`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([
        {
          user_id: userId,
          provider_key: "commandcode",
          enabled: true,
          display_order: 10,
          active_provider_account_id: accountId,
        },
      ]),
    });
    console.log(prefResp.ok ? "✅ 看板显示配置已就绪" : `⚠️ preference 写入失败: HTTP ${prefResp.status}`);
  } catch (error) {
    console.warn(`⚠️ Supabase 账号同步异常: ${String(error)}`);
  }
}

export async function extractCookieFromBrowser(chromium: typeof import("playwright")["chromium"], account: string, waitForLogin: boolean): Promise<string | null> {
  killBrowserProcesses();
  cleanStaleLocks(PROFILE_DIR);
  console.log("🔧 启动专用 Chrome Profile（output/commandcode-profile）...");

  let context: import("playwright").BrowserContext;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: "chrome",
      viewport: { width: 1280, height: 900 },
      args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`   ⚠️ Chrome 启动失败: ${msg.substring(0, 200)}`);
    return null;
  }

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(usageUrl(account), { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => null);
    await page.waitForTimeout(4_000);

    let cookie = (await context.cookies()).find((item) => item.name === SESSION_COOKIE_NAME)?.value;
    const valid = async (value: string | undefined) => {
      if (!value) return false;
      try {
        const resp = await fetch(`${DEFAULT_API_BASE}/internal/usage/summary`, {
          headers: { accept: "application/json", cookie: `${SESSION_COOKIE_NAME}=${value}`, "user-agent": USER_AGENT },
          signal: AbortSignal.timeout(15_000),
        });
        return resp.status === 200;
      } catch {
        return false;
      }
    };

    if (cookie && (await valid(cookie))) {
      console.log("✅ 专用 Profile 登录态有效");
      return cookie;
    }

    console.log("");
    console.log("══════════════════════════════════════════════════════════");
    console.log(`  还没有可用的 Command Code 登录态`);
    if (!waitForLogin) {
      console.log("  无人值守模式（--no-wait-login），本次跳过");
      console.log("══════════════════════════════════════════════════════════");
      return null;
    }
    console.log("  请在刚打开的窗口里登录 commandcode.ai（GitHub / Google / 邮箱）");
    console.log(`  登录后脚本每 3 秒检测一次，成功后自动继续（最长 ${LOGIN_WAIT_MS / 1000} 秒）`);
    console.log("══════════════════════════════════════════════════════════");
    console.log("");

    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3_000);
      cookie = (await context.cookies()).find((item) => item.name === SESSION_COOKIE_NAME)?.value;
      if (cookie && (await valid(cookie))) {
        console.log("✅ 检测到登录成功");
        return cookie;
      }
    }
    console.error(`❌ 等待登录超时（${LOGIN_WAIT_MS / 1000} 秒）`);
    return null;
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const envPath = resolve(process.cwd(), ".env");
  const env = loadEnv();
  const account = env.COMMANDCODE_ACCOUNT ?? DEFAULT_ACCOUNT;
  const apiBase = (env.COMMANDCODE_API_BASE_URL ?? DEFAULT_API_BASE).replace(/\/$/, "");
  const waitForLogin = !process.argv.includes("--no-wait-login");

  console.log("✅ 环境变量加载成功");
  console.log(`   账号: ${account} | API: ${apiBase}`);
  if (!env.APIMONITOR_INGEST_URL || !env.INGEST_API_KEY) {
    console.error("❌ .env 缺少 APIMONITOR_INGEST_URL / INGEST_API_KEY");
    process.exit(1);
  }

  const { chromium } = await import("playwright");
  let cookie: string | undefined = env.COMMANDCODE_SESSION_COOKIE?.trim();
  let bundle: Bundle | null = null;

  if (cookie) {
    try {
      bundle = await fetchBundle(apiBase, cookie, account);
      console.log("♻️ 使用 .env 缓存的 session cookie（未启动浏览器）");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`ℹ️ .env 缓存 cookie 不可用（${message}），转浏览器`);
      cookie = undefined;
    }
  }

  if (!cookie || !bundle) {
    cookie = (await extractCookieFromBrowser(chromium, account, waitForLogin)) ?? undefined;
    if (!cookie) {
      console.error("❌ 未获取到可用的 Command Code 登录态");
      process.exit(1);
    }
    bundle = await fetchBundle(apiBase, cookie, account);
  }

  updateEnvKey(envPath, "COMMANDCODE_SESSION_COOKIE", cookie);
  console.log("💾 已把 COMMANDCODE_SESSION_COOKIE 写入 .env");

  const snapshot = buildSnapshot(bundle, account);
  const ok = await pushSnapshot(env, snapshot);
  if (!ok) process.exit(1);

  await updateWorkerSecret(env, cookie);
  await updateEdgeFunctionSecrets(env, cookie);
  await updateSupabaseAccount(env, cookie, account);
  console.log("🎉 完成");
}

main().catch((err) => {
  console.error("❌ 脚本执行失败:", err);
  process.exit(1);
});
