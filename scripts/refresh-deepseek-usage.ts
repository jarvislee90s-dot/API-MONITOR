/**
 * DeepSeek 用量抓取脚本
 *
 * 功能：用账号密码登录 DeepSeek 开放平台，提取登录 token 与 WAF cookie，
 *       抓取 usage 用量（余额 / 消费 / 请求数 / Tokens），组装为标准快照后
 *       推送到 Worker 的 /api/ingest/deepseek 端点存入 Supabase；
 *       同时把最新 token / cookie 写回 .env，供 Worker 云端直接取数。
 *
 * 前置条件：
 *   1. .env 中已配置 DEEPSEEK_USER / DEEPSEEK_PASS（平台登录账号密码）
 *   2. .env 中已配置 INGEST_API_KEY、APIMONITOR_INGEST_URL
 *
 * 使用：
 *   node --experimental-strip-types scripts/refresh-deepseek-usage.ts
 *
 * 说明：登录态由平台 Bearer token（localStorage.userToken）+ WAF cookie 组成，
 *       均非明文密码；脚本登录成功后自动刷新 .env 中的 DEEPSEEK_USER_TOKEN 与
 *       DEEPSEEK_AUTH_COOKIE。取数逻辑与 worker/providers/deepseek.ts 保持一致。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

type DeepSeekUsage = {
  balance: number | null;
  totalCost: number | null;
  cost30d: number | null;
  requests30d: number | null;
  tokens30d: number | null;
  promptCacheHitTokens30d: number | null;
  promptCacheMissTokens30d: number | null;
  outputTokens30d: number | null;
  models: Array<{ model: string; requests: number | null; tokens: number | null }>;
};

type UsageWindow = {
  key: string;
  label: string;
  used?: number | null;
  limit?: number | null;
};

type UsageBucket = {
  usage?: {
    RESPONSE_TOKEN?: number;
    REQUEST?: number;
    PROMPT_CACHE_HIT_TOKEN?: number;
    PROMPT_CACHE_MISS_TOKEN?: number;
  };
};

type UsageSeries = { model?: string; buckets?: UsageBucket[] };
type CostBucket = { cost?: string | number };
type CostSeries = { buckets?: CostBucket[] };

type Snapshot = {
  providerId: string;
  providerName: string;
  sourceUrl: string;
  status: string;
  capturedAt: string;
  summary: string;
  windows: UsageWindow[];
  metrics: Record<string, number | string | boolean | null>;
  meta: Record<string, unknown>;
};

const defaultPageUrl = "https://platform.deepseek.com/usage";
const defaultApiBase = "https://platform.deepseek.com";
const GMTPLUS8_OFFSET_SEC = 28_800;

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

async function readUserToken(page: import("playwright").Page): Promise<string | null> {
  const raw = await page.evaluate(() => localStorage.getItem("userToken"));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { value?: unknown };
    return typeof parsed.value === "string" ? parsed.value : null;
  } catch {
    return null;
  }
}

const WAF_COOKIE_NAMES = ["HWWAFSESID", "HWWAFSESTIME", "smidV2", ".thumbcache_6b2e5483f9d858d7c661c5e276b6a6ae"];

async function buildWafCookie(context: import("playwright").BrowserContext): Promise<string | null> {
  const names = new Set(WAF_COOKIE_NAMES);
  const parts: string[] = [];
  const cookies = await context.cookies("https://platform.deepseek.com");
  for (const cookie of cookies) {
    if (names.has(cookie.name)) {
      parts.push(`${cookie.name}=${cookie.value}`);
    }
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

async function ensureLoggedIn(
  page: import("playwright").Page,
  env: Record<string, string>,
): Promise<string | null> {
  const user = env.DEEPSEEK_USER;
  const pass = env.DEEPSEEK_PASS;
  if (!user || !pass) {
    console.error("❌ .env 缺少 DEEPSEEK_USER / DEEPSEEK_PASS，无法自动登录");
    return null;
  }

  await page.goto("https://platform.deepseek.com/usage", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3_000);

  if (!/sign_in|login/i.test(page.url())) {
    const token = await readUserToken(page);
    if (token) {
      console.log("✅ 已处于登录态，直接复用现有 token");
      return token;
    }
  }

  const passwordSwitch = page.getByRole("button", { name: "密码登录" });
  if (await passwordSwitch.count()) {
    await passwordSwitch.click();
    await page.waitForTimeout(1_500);
  }

  const accountInput = page.getByRole("textbox", { name: "请输入手机号/邮箱地址" });
  const passwordInput = page.locator("input[type='password']");
  if (!(await accountInput.count()) || !(await passwordInput.count())) {
    console.error("❌ 未找到账号/密码输入框，可能需要处理验证码或人工登录");
    return null;
  }

  await accountInput.fill(user);
  await passwordInput.fill(pass);
  await page.waitForTimeout(500);

  const submitBtn = page.getByRole("button", { name: "登录", exact: true });
  if (await submitBtn.count()) {
    await submitBtn.click();
    console.log("⏳ 已点击登录，等待跳转（若出现滑块验证码，请在浏览器中手动完成）...");
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    const url = page.url();
    if (!/sign_in|login/i.test(url)) {
      const token = await readUserToken(page);
      if (token) {
        console.log("✅ 登录成功，token 已获取");
        return token;
      }
    }
  }
  console.error("❌ 登录超时（120 秒），请检查账号密码或验证码");
  return null;
}

// ---- 以下取数逻辑与 worker/providers/deepseek.ts 保持一致 ----

function clampNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function buildUsageRange(nowSec: number): { start: number; end: number } {
  const todayMidnightGmt8 =
    Math.floor((nowSec - GMTPLUS8_OFFSET_SEC) / 86400) * 86400 + GMTPLUS8_OFFSET_SEC;
  const end = todayMidnightGmt8 + 86400;
  return { start: end - 30 * 86400, end };
}

function getEnvelopeBizData(payload: unknown): Record<string, unknown> | null {
  const envelope = payload as { code?: number; data?: { biz_code?: number; biz_data?: unknown } };
  if (envelope?.code !== 0 || envelope?.data?.biz_code !== 0) return null;
  const bizData = envelope.data.biz_data;
  if (!bizData || typeof bizData !== "object" || Array.isArray(bizData)) return null;
  return bizData as Record<string, unknown>;
}

function sumUsage(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((value): value is number => typeof value === "number");
  return nums.length > 0 ? nums.reduce((acc, value) => acc + value, 0) : null;
}

function parseAmountResponse(
  bizData: Record<string, unknown>,
): Omit<DeepSeekUsage, "balance" | "totalCost" | "cost30d"> {
  const series = Array.isArray((bizData as { series?: UsageSeries[] }).series)
    ? (bizData as { series?: UsageSeries[] }).series!
    : [];
  const models: Array<{ model: string; requests: number | null; tokens: number | null }> = [];
  let requests: number | null = null;
  let tokens: number | null = null;
  let promptCacheHitTokens: number | null = null;
  let promptCacheMissTokens: number | null = null;
  let outputTokens: number | null = null;

  for (const item of series) {
    const model = typeof item.model === "string" ? item.model : "unknown";
    const buckets = Array.isArray(item.buckets) ? item.buckets : [];
    const modelRequests: number[] = [];
    const modelTokens: number[] = [];

    for (const bucket of buckets) {
      const usage = bucket.usage ?? {};
      const request = clampNumber(usage.REQUEST);
      const cacheHit = clampNumber(usage.PROMPT_CACHE_HIT_TOKEN);
      const cacheMiss = clampNumber(usage.PROMPT_CACHE_MISS_TOKEN);
      const responseToken = clampNumber(usage.RESPONSE_TOKEN);
      const bucketTokens = sumUsage([cacheHit, cacheMiss, responseToken]);

      if (typeof request === "number") {
        requests = (requests ?? 0) + request;
        modelRequests.push(request);
      }
      if (typeof cacheHit === "number") promptCacheHitTokens = (promptCacheHitTokens ?? 0) + cacheHit;
      if (typeof cacheMiss === "number") promptCacheMissTokens = (promptCacheMissTokens ?? 0) + cacheMiss;
      if (typeof responseToken === "number") outputTokens = (outputTokens ?? 0) + responseToken;
      if (typeof bucketTokens === "number") {
        tokens = (tokens ?? 0) + bucketTokens;
        modelTokens.push(bucketTokens);
      }
    }

    if (modelRequests.length > 0 || modelTokens.length > 0) {
      models.push({ model, requests: sumUsage(modelRequests), tokens: sumUsage(modelTokens) });
    }
  }

  return { requests, tokens, promptCacheHitTokens, promptCacheMissTokens, outputTokens, models };
}

function parseCostResponse(bizData: Record<string, unknown>): number | null {
  const cost = bizData as { data?: Array<{ series?: CostSeries[] }> };
  const currencies = Array.isArray(cost.data) ? cost.data : [];
  const totals: number[] = [];
  for (const currencyGroup of currencies) {
    const series = Array.isArray(currencyGroup.series) ? currencyGroup.series : [];
    for (const item of series) {
      const buckets = Array.isArray(item.buckets) ? item.buckets : [];
      for (const bucket of buckets) {
        const value = clampNumber(bucket.cost);
        if (typeof value === "number") totals.push(value);
      }
    }
  }
  return totals.length > 0 ? totals.reduce((acc, value) => acc + value, 0) : null;
}

function parseUserSummary(bizData: Record<string, unknown>): { balance: number | null; totalCost: number | null } {
  const summary = bizData as {
    normal_wallets?: Array<{ currency?: string; balance?: string | number }>;
    bonus_wallets?: Array<{ currency?: string; balance?: string | number }>;
    total_costs?: Array<{ currency?: string; amount?: string | number }>;
  };
  const normalBalance = clampNumber(summary.normal_wallets?.find((wallet) => wallet.currency === "CNY")?.balance);
  const bonusBalance = clampNumber(summary.bonus_wallets?.find((wallet) => wallet.currency === "CNY")?.balance);
  const balance = sumUsage([normalBalance, bonusBalance]);
  const totalCost = clampNumber(summary.total_costs?.find((cost) => cost.currency === "CNY")?.amount);
  return { balance, totalCost };
}

async function fetchDeepSeekUsage(userToken: string, authCookie: string): Promise<DeepSeekUsage> {
  const nowSec = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    accept: "*/*",
    authorization: `Bearer ${userToken}`,
    "x-client-locale": "zh_CN",
    "x-client-bundle-id": "com.deepseek.chat",
    "x-client-platform": "web",
    "x-client-version": "1.0.0",
    "x-client-timezone-offset": "28800",
    referer: "https://platform.deepseek.com/usage",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    cookie: authCookie,
  };
  const { start, end } = buildUsageRange(nowSec);

  const [summaryResp, amountResp, costResp] = await Promise.all([
    fetch(`${defaultApiBase}/api/v0/users/get_user_summary`, { headers }),
    fetch(`${defaultApiBase}/api/v0/usage/by_api_key/amount?start=${start}&end=${end}&tz=28800`, { headers }),
    fetch(`${defaultApiBase}/api/v0/usage/by_api_key/cost?start=${start}&end=${end}&tz=28800`, { headers }),
  ]);

  const summaryPayload = getEnvelopeBizData(await summaryResp.json().catch(() => null));
  const amountPayload = getEnvelopeBizData(await amountResp.json().catch(() => null));
  const costPayload = getEnvelopeBizData(await costResp.json().catch(() => null));

  const summary = summaryPayload ? parseUserSummary(summaryPayload) : { balance: null, totalCost: null };
  const amount = amountPayload
    ? parseAmountResponse(amountPayload)
    : {
        requests: null,
        tokens: null,
        promptCacheHitTokens: null,
        promptCacheMissTokens: null,
        outputTokens: null,
        models: [] as Array<{ model: string; requests: number | null; tokens: number | null }>,
      };
  const cost30d = costPayload ? parseCostResponse(costPayload) : null;

  return {
    balance: summary.balance,
    totalCost: summary.totalCost,
    cost30d,
    requests30d: amount.requests,
    tokens30d: amount.tokens,
    promptCacheHitTokens30d: amount.promptCacheHitTokens,
    promptCacheMissTokens30d: amount.promptCacheMissTokens,
    outputTokens30d: amount.outputTokens,
    models: amount.models,
  };
}

function buildWindows(usage: DeepSeekUsage): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const entries: Array<{ key: string; label: string; value: number | null }> = [
    { key: "balance", label: "余额", value: usage.balance },
    { key: "cost30d", label: "近30天消费", value: usage.cost30d },
    { key: "tokens30d", label: "近30天Tokens", value: usage.tokens30d },
    { key: "requests30d", label: "近30天请求", value: usage.requests30d },
  ];
  for (const entry of entries) {
    if (typeof entry.value === "number") {
      windows.push({ key: entry.key, label: entry.label, used: entry.value, limit: null });
    }
  }
  return windows;
}

function buildSnapshot(usage: DeepSeekUsage, capturedAt: string): Snapshot {
  const windows = buildWindows(usage);
  return {
    providerId: "deepseek",
    providerName: "DeepSeek",
    sourceUrl: defaultPageUrl,
    status: windows.length > 0 ? "ready" : "partial",
    capturedAt,
    summary: windows.length > 0 ? "DeepSeek 用量已加载" : "DeepSeek 用量已加载但未找到数据",
    windows,
    metrics: {
      balance: usage.balance,
      totalCost: usage.totalCost,
      cost30d: usage.cost30d,
      requests30d: usage.requests30d,
      tokens30d: usage.tokens30d,
      promptCacheHitTokens30d: usage.promptCacheHitTokens30d,
      promptCacheMissTokens30d: usage.promptCacheMissTokens30d,
      outputTokens30d: usage.outputTokens30d,
    },
    meta: {
      fetchMethod: "local_ingest",
      models: usage.models,
      entryUrl: defaultPageUrl,
    },
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const envPath = resolve(process.cwd(), ".env");

  const missing = ["INGEST_API_KEY", "APIMONITOR_INGEST_URL"].filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`❌ 缺少环境变量: ${missing.join(", ")}。请在 .env 中配置。`);
    process.exit(1);
  }
  console.log(`   推送目标: ${env.APIMONITOR_INGEST_URL}`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    const token = await ensureLoggedIn(page, env);
    if (!token) {
      process.exit(1);
    }
    const authCookie = await buildWafCookie(context);
    if (!authCookie) {
      console.error("❌ 未提取到 WAF cookie");
      process.exit(1);
    }

    const usage = await fetchDeepSeekUsage(token, authCookie);
    const capturedAt = new Date().toISOString();
    const snapshot = buildSnapshot(usage, capturedAt);
    console.log(`📊 DeepSeek 状态: ${snapshot.status}（${snapshot.summary}）`);
    console.log(`   windows: ${snapshot.windows.map((w) => `${w.label}=${w.used}`).join(", ")}`);

    if (snapshot.status !== "ready" || snapshot.windows.length === 0) {
      console.error("❌ DeepSeek 用量未解析到可用数据，跳过推送");
      process.exit(1);
    }

    // 推送到 Worker ingest 端点（落库 Supabase）
    console.log("📤 推送快照到 Worker ingest 端点...");
    const ingestUrl = `${env.APIMONITOR_INGEST_URL.replace(/\/$/, "")}/api/ingest/deepseek`;
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
    const ingestResult = (await ingestResp.json()) as { ok: boolean; data?: { capturedAt: string } };
    console.log(`🎉 快照已推送（capturedAt: ${ingestResult.data?.capturedAt ?? capturedAt}）`);

    // 刷新 .env 中的 token / cookie，供 Worker 云端直接取数
    updateEnvKeys(envPath, {
      DEEPSEEK_USER_TOKEN: token,
      DEEPSEEK_AUTH_COOKIE: authCookie,
    });
    console.log("✅ .env 中的 DEEPSEEK_USER_TOKEN / DEEPSEEK_AUTH_COOKIE 已刷新");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("❌ 脚本执行失败:", err);
  process.exit(1);
});
