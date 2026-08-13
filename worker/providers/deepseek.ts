import { clampNumber, parseHeadersCookie, toIsoString } from "../http";
import type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult, ProviderSnapshot } from "../types";
import { createResult } from "./types";

type DeepSeekConfig = {
  apiKey?: string;
  pageUrl?: string;
  userToken?: string;
  authCookie?: string;
};

type UsageBucket = {
  time?: number;
  usage?: {
    RESPONSE_TOKEN?: number;
    REQUEST?: number;
    PROMPT_CACHE_HIT_TOKEN?: number;
    PROMPT_CACHE_MISS_TOKEN?: number;
  };
};

type UsageSeries = {
  api_key?: { tracking_id?: string; name?: string; sensitive_id?: string; valid?: boolean };
  model?: string;
  buckets?: UsageBucket[];
};

type CostBucket = {
  time?: number;
  cost?: string | number;
};

type CostSeries = {
  api_key?: { tracking_id?: string; name?: string; sensitive_id?: string; valid?: boolean };
  model?: string;
  buckets?: CostBucket[];
};

type DeepSeekEnvelope = {
  code?: number;
  msg?: string;
  data?: {
    biz_code?: number;
    biz_msg?: string;
    biz_data?: unknown;
  };
};

type UserSummary = {
  normal_wallets?: Array<{ currency?: string; balance?: string | number }>;
  bonus_wallets?: Array<{ currency?: string; balance?: string | number }>;
  total_costs?: Array<{ currency?: string; amount?: string | number }>;
};

type AmountResponse = {
  series?: UsageSeries[];
};

type CostResponse = {
  data?: Array<{ currency?: string; series?: CostSeries[] }>;
};

type BalanceInfo = {
  is_available?: boolean;
  balance_infos?: Array<{ currency?: string; total_balance?: string | number }>;
};

const defaultPageUrl = "https://platform.deepseek.com/usage";
const defaultApiBase = "https://platform.deepseek.com";
const defaultBalanceApiUrl = "https://api.deepseek.com/user/balance";
const GMTPLUS8_OFFSET_SEC = 28_800;

// 平台 API 域名白名单，防止凭据被发往非预期地址
function isTrustedDeepSeekApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "deepseek.com" || url.hostname.endsWith(".deepseek.com"))
    );
  } catch {
    return false;
  }
}

// 近 30 天区间：start/end 必须对齐到 GMT+8 的午夜，end 取"明天 00:00"以包含今天
function buildUsageRange(nowSec: number): { start: number; end: number } {
  const todayMidnightGmt8 =
    Math.floor((nowSec - GMTPLUS8_OFFSET_SEC) / 86400) * 86400 + GMTPLUS8_OFFSET_SEC;
  const end = todayMidnightGmt8 + 86400;
  return { start: end - 30 * 86400, end };
}

function getEnvelopeBizData(payload: unknown): Record<string, unknown> | null {
  const envelope = payload as DeepSeekEnvelope;
  if (envelope?.code !== 0 || envelope?.data?.biz_code !== 0) return null;
  const bizData = envelope.data.biz_data;
  if (!bizData || typeof bizData !== "object" || Array.isArray(bizData)) return null;
  return bizData as Record<string, unknown>;
}

function sumUsage(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((value): value is number => typeof value === "number");
  return nums.length > 0 ? nums.reduce((acc, value) => acc + value, 0) : null;
}

function parseAmountResponse(bizData: Record<string, unknown>): {
  requests: number | null;
  tokens: number | null;
  promptCacheHitTokens: number | null;
  promptCacheMissTokens: number | null;
  outputTokens: number | null;
  models: Array<{ model: string; requests: number | null; tokens: number | null }>;
} {
  const amount = bizData as AmountResponse;
  const series = Array.isArray(amount.series) ? amount.series : [];
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
      models.push({
        model,
        requests: sumUsage(modelRequests),
        tokens: sumUsage(modelTokens),
      });
    }
  }

  return { requests, tokens, promptCacheHitTokens, promptCacheMissTokens, outputTokens, models };
}

function parseCostResponse(bizData: Record<string, unknown>): number | null {
  const cost = bizData as CostResponse;
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

function parseUserSummary(bizData: Record<string, unknown>): {
  balance: number | null;
  totalCost: number | null;
} {
  const summary = bizData as UserSummary;
  const normalBalance = clampNumber(
    summary.normal_wallets?.find((wallet) => wallet.currency === "CNY")?.balance,
  );
  const bonusBalance = clampNumber(
    summary.bonus_wallets?.find((wallet) => wallet.currency === "CNY")?.balance,
  );
  const balance = sumUsage([normalBalance, bonusBalance]);
  const totalCost = clampNumber(
    summary.total_costs?.find((cost) => cost.currency === "CNY")?.amount,
  );
  return { balance, totalCost };
}

function parseBalanceApi(payload: unknown): { balance: number | null; currency: string | null } {
  const body = payload as BalanceInfo;
  const info = body.balance_infos?.[0];
  return {
    balance: clampNumber(info?.total_balance),
    currency: info?.currency ?? null,
  };
}

function buildWindows(values: {
  balance: number | null;
  totalCost: number | null;
  cost30d: number | null;
  requests30d: number | null;
  tokens30d: number | null;
}): ProviderSnapshot["windows"] {
  const windows = [
    {
      key: "balance",
      label: "余额",
      used: values.balance,
      limit: null,
    },
    {
      key: "cost30d",
      label: "近30天消费",
      used: values.cost30d,
      limit: null,
    },
    {
      key: "tokens30d",
      label: "近30天Tokens",
      used: values.tokens30d,
      limit: null,
    },
    {
      key: "requests30d",
      label: "近30天请求",
      used: values.requests30d,
      limit: null,
    },
  ].filter(
    (window) =>
      typeof window.used === "number" || typeof window.limit === "number",
  );

  return windows;
}

async function fetchPlatformUsage(
  fetchImpl: typeof fetch,
  config: { userToken?: string; authCookie?: string; apiBase?: string },
  nowSec: number,
): Promise<{
  balance: number | null;
  totalCost: number | null;
  cost30d: number | null;
  requests30d: number | null;
  tokens30d: number | null;
  promptCacheHitTokens30d: number | null;
  promptCacheMissTokens30d: number | null;
  outputTokens30d: number | null;
  models: Array<{ model: string; requests: number | null; tokens: number | null }>;
}> {
  const empty = {
    balance: null,
    totalCost: null,
    cost30d: null,
    requests30d: null,
    tokens30d: null,
    promptCacheHitTokens30d: null,
    promptCacheMissTokens30d: null,
    outputTokens30d: null,
    models: [] as Array<{ model: string; requests: number | null; tokens: number | null }>,
  };

  if (!config.userToken || !config.authCookie) {
    return empty;
  }

  const baseUrl = config.apiBase ?? defaultApiBase;
  if (!isTrustedDeepSeekApiUrl(baseUrl)) {
    return empty;
  }

  const headers: Record<string, string> = {
    accept: "*/*",
    authorization: `Bearer ${config.userToken}`,
    "x-client-locale": "zh_CN",
    "x-client-bundle-id": "com.deepseek.chat",
    "x-client-platform": "web",
    "x-client-version": "1.0.0",
    "x-client-timezone-offset": "28800",
    referer: "https://platform.deepseek.com/usage",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  };
  const cookie = parseHeadersCookie(config.authCookie);
  if (cookie) {
    headers.cookie = cookie;
  }

  const { start, end } = buildUsageRange(nowSec);
  const [summaryResp, amountResp, costResp] = await Promise.all([
    fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/v0/users/get_user_summary`, { headers }),
    fetchImpl(
      `${baseUrl.replace(/\/$/, "")}/api/v0/usage/by_api_key/amount?start=${start}&end=${end}&tz=28800`,
      { headers },
    ),
    fetchImpl(
      `${baseUrl.replace(/\/$/, "")}/api/v0/usage/by_api_key/cost?start=${start}&end=${end}&tz=28800`,
      { headers },
    ),
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

async function fetchBalanceApi(
  fetchImpl: typeof fetch,
  apiKey: string,
): Promise<{ balance: number | null; currency: string | null }> {
  const response = await fetchImpl(defaultBalanceApiUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    return { balance: null, currency: null };
  }
  return parseBalanceApi(await response.json().catch(() => null));
}

export async function fetchDeepSeekSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const nowSec = Math.floor(input.now.getTime() / 1000);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = (input.config ?? {}) as DeepSeekConfig;
  const sourceUrl = config.pageUrl?.trim() || defaultPageUrl;

  if (!config.apiKey && !config.userToken) {
    return createResult({
      providerId: "deepseek",
      providerName: "DeepSeek",
      sourceUrl,
      status: "login_required",
      capturedAt: now,
      summary: "DeepSeek 缺少 API Key 或登录态",
      windows: [],
      metrics: {
        hasApiKey: Boolean(config.apiKey),
        hasUserToken: Boolean(config.userToken),
      },
      meta: {
        entryUrl: sourceUrl,
      },
    });
  }

  // 优先走平台 usage API（需要登录 token + WAF cookie），失败时回退官方余额 API
  const platform = await fetchPlatformUsage(fetchImpl, config, nowSec);
  const hasPlatformUsage = platform.balance !== null || platform.cost30d !== null;

  if (!hasPlatformUsage && config.apiKey) {
    const balance = await fetchBalanceApi(fetchImpl, config.apiKey);
    if (balance.balance !== null) {
      return createResult({
        providerId: "deepseek",
        providerName: "DeepSeek",
        sourceUrl,
        status: "ready",
        capturedAt: now,
        summary: "DeepSeek 余额已加载",
        windows: buildWindows({
          balance: balance.balance,
          totalCost: null,
          cost30d: null,
          requests30d: null,
          tokens30d: null,
        }),
        metrics: {
          balance: balance.balance,
          currency: balance.currency,
        },
        meta: {
          fetchMethod: "balance_api",
          entryUrl: sourceUrl,
        },
      });
    }
  }

  if (!hasPlatformUsage) {
    return createResult({
      providerId: "deepseek",
      providerName: "DeepSeek",
      sourceUrl,
      status: "partial",
      capturedAt: now,
      summary: "DeepSeek 用量接口未返回可用数据",
      windows: [],
      metrics: {
        hasApiKey: Boolean(config.apiKey),
        hasUserToken: Boolean(config.userToken),
      },
      meta: {
        entryUrl: sourceUrl,
      },
    });
  }

  const windows = buildWindows({
    balance: platform.balance,
    totalCost: platform.totalCost,
    cost30d: platform.cost30d,
    requests30d: platform.requests30d,
    tokens30d: platform.tokens30d,
  });

  return createResult({
    providerId: "deepseek",
    providerName: "DeepSeek",
    sourceUrl,
    status: windows.length > 0 ? "ready" : "partial",
    capturedAt: now,
    summary: windows.length > 0 ? "DeepSeek 用量已加载" : "DeepSeek 用量已加载但未找到数据",
    windows,
    metrics: {
      balance: platform.balance,
      totalCost: platform.totalCost,
      cost30d: platform.cost30d,
      requests30d: platform.requests30d,
      tokens30d: platform.tokens30d,
      promptCacheHitTokens30d: platform.promptCacheHitTokens30d,
      promptCacheMissTokens30d: platform.promptCacheMissTokens30d,
      outputTokens30d: platform.outputTokens30d,
    },
    meta: {
      fetchMethod: "platform_usage",
      models: platform.models,
      entryUrl: sourceUrl,
    },
  });
}

export const deepseek: ProviderDefinition = {
  id: "deepseek",
  name: "DeepSeek",
  sourceUrl: defaultPageUrl,
  description: "DeepSeek API 余额与近 30 天用量（请求数 / Tokens / 消费）",
  fetchSnapshot: fetchDeepSeekSnapshot,
};
