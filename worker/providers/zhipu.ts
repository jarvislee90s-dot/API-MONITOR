import { clampNumber, parseHeadersCookie, toIsoString } from "../http";
import type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult, ProviderSnapshot } from "../types";
import { createResult } from "./types";

type ZhipuConfig = {
  pageUrl?: string;
  apiBase?: string;
  authCookie?: string;
  authToken?: string;
};

// 智谱 BigModel 用量页与 API 前缀（axios baseURL=/api，同源拼接）
const defaultPageUrl = "https://bigmodel.cn/coding-plan/personal/usage";
const defaultApiBase = "https://bigmodel.cn/api";

const GMT8_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_COOKIE_NAME = "bigmodel_token_production";

type ZhipuEnvelope = {
  code?: number;
  msg?: string;
  data?: unknown;
};

type QuotaLimit = {
  type?: unknown;
  title?: unknown;
  usage?: unknown;
  currentValue?: unknown;
  remaining?: unknown;
  percentage?: unknown;
  nextResetTime?: unknown;
};

type QuotaLimitData = {
  limits?: QuotaLimit[];
  level?: unknown;
};

type SummaryValue = {
  value?: unknown;
  trend?: unknown;
};

type CreditUsageSummary = {
  cacheHitRate?: SummaryValue;
  totalCredits?: SummaryValue;
  averageDailyCredits?: SummaryValue;
};

type UsageDetailData = {
  summary?: CreditUsageSummary;
  modelUsage?: {
    xTime?: unknown[];
    totalUsage?: {
      totalTokens?: unknown;
      totalCredits?: unknown;
    };
  };
};

// API 域名白名单，防止凭据被发往非预期地址
function isTrustedZhipuApiBase(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "bigmodel.cn" || url.hostname.endsWith(".bigmodel.cn"))
    );
  } catch {
    return false;
  }
}

function unwrapData(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as ZhipuEnvelope;
  const data = envelope.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

// 从 cookie 串里提取登录 token（请求头 Authorization 直接用其值，不带 Bearer）
function extractTokenFromCookie(authCookie?: string): string | null {
  if (!authCookie) return null;
  const match = authCookie.match(new RegExp(`(?:^|;\\s*)${TOKEN_COOKIE_NAME}=([^;]+)`, "i"));
  return match?.[1] ? match[1] : null;
}

// 智谱接口返回的重置时间为 GMT+8 墙上时间（如 2026-08-22 10:00:00），
// 统一转成带时区的 ISO 字符串；数字则按毫秒时间戳处理。
function normalizeResetTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const wallClock = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (wallClock) {
    const [, year, month, day, hour, minute, second] = wallClock;
    const utcMs = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - 8,
      Number(minute),
      second ? Number(second) : 0,
    );
    const date = new Date(utcMs);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// 页面配额标题（如 5小时用量额度 / 周用量额度）归一化为看板窗口标签。
// 接口的 limits 没有 title 字段时，按窗口顺序兜底：首个为 5小时滚动，其次为每周。
function normalizeLabel(title: string, index: number): string {
  if (/5\s*小\s*时|5\s*h/i.test(title)) return "5小时";
  if (title.includes("周")) return "每周";
  if (title.includes("月")) return "每月";
  if (!title) {
    if (index === 0) return "5小时";
    if (index === 1) return "每周";
    return "配额";
  }
  return title;
}

function windowKey(label: string, index: number): string {
  if (label === "5小时") return "rp5h";
  if (label === "每周") return "weekly";
  if (label === "每月") return "monthly";
  return `quota-${index}`;
}

function buildWindows(limits: QuotaLimit[]): ProviderSnapshot["windows"] {
  return limits
    .map((limit, index) => {
      const title = typeof limit.title === "string" ? limit.title : "";
      const label = normalizeLabel(title, index);
      // usage=额度，currentValue=当前已用积分；percentage 缺失时按已用/额度计算
      const used = clampNumber(limit.currentValue) ?? clampNumber(limit.usage);
      const cap = clampNumber(limit.usage);
      const percentFromApi = clampNumber(limit.percentage);
      const percentUsed =
        percentFromApi ??
        (used !== null && cap !== null && cap > 0 ? (used / cap) * 100 : null);
      if (used === null && percentUsed === null) return null;
      return {
        key: windowKey(label, index),
        label,
        used,
        limit: cap,
        remaining: clampNumber(limit.remaining),
        percentUsed,
        percentRemaining: percentUsed !== null ? Math.max(0, 100 - percentUsed) : null,
        resetAt: normalizeResetTime(limit.nextResetTime),
      } as ProviderSnapshot["windows"][number];
    })
    .filter((window): window is ProviderSnapshot["windows"][number] => window !== null);
}

// 单个 usage-detail 响应解析：范围内 Cache 命中率 / 消耗积分 / Tokens
function parseUsageDetail(payload: unknown): {
  cacheHitRate: number | null;
  totalCredits: number | null;
  totalTokens: number | null;
} {
  const data = unwrapData(payload) as UsageDetailData | null;
  return {
    cacheHitRate: clampNumber(data?.summary?.cacheHitRate?.value),
    totalCredits: clampNumber(data?.modelUsage?.totalUsage?.totalCredits),
    totalTokens: clampNumber(data?.modelUsage?.totalUsage?.totalTokens),
  };
}

// 近 N 天区间（7/30），对齐 GMT+8 的 00:00:00 ~ 23:59:59
function buildUsageRange(now: Date, days: number): { start: string; end: string } {
  const nowMs = now.getTime();
  const todayStartGmt8 =
    Math.floor((nowMs + GMT8_OFFSET_MS) / DAY_MS) * DAY_MS - GMT8_OFFSET_MS;
  const endMs = todayStartGmt8 + DAY_MS - 1;
  const startMs = endMs - (days - 1) * DAY_MS;
  const formatGmt8 = (ms: number): string => {
    const date = new Date(ms + GMT8_OFFSET_MS);
    return date
      .toISOString()
      .replace(/\.\d{3}Z$/, "")
      .replace("T", " ");
  };
  return { start: formatGmt8(startMs), end: formatGmt8(endMs) };
}

function buildUsageDetailUrl(apiBase: string, range: { start: string; end: string }): string {
  return (
    `${apiBase}/monitor/credit-usage/usage-detail?` +
    `usageType=MODEL&type=1&startTime=${encodeURIComponent(range.start)}` +
    `&endTime=${encodeURIComponent(range.end)}`
  );
}

export async function fetchZhipuSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = (input.config ?? {}) as ZhipuConfig;
  const sourceUrl = config.pageUrl?.trim() || defaultPageUrl;
  const apiBase = (config.apiBase?.trim() || defaultApiBase).replace(/\/+$/, "");

  if (!config.authCookie && !config.authToken) {
    return createResult({
      providerId: "zhipu",
      providerName: "智谱 BigModel",
      sourceUrl,
      status: "login_required",
      capturedAt: now,
      summary: "智谱需要登录态 cookie/token",
      windows: [],
      metrics: {
        hasAuthCookie: Boolean(config.authCookie),
        hasAuthToken: Boolean(config.authToken),
      },
      meta: { entryUrl: sourceUrl },
    });
  }

  if (!isTrustedZhipuApiBase(apiBase)) {
    return createResult({
      providerId: "zhipu",
      providerName: "智谱 BigModel",
      sourceUrl,
      status: "error",
      capturedAt: now,
      summary: "智谱 API URL 不安全，已拒绝发送请求",
      windows: [],
      metrics: {},
      meta: { entryUrl: sourceUrl },
    });
  }

  const authToken = config.authToken?.trim() || extractTokenFromCookie(config.authCookie);
  const cookie = parseHeadersCookie(config.authCookie);

  const headers: Record<string, string> = {
    Accept: "application/json",
    Referer: sourceUrl,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApiMonitor/0.1",
    ...(authToken ? { Authorization: authToken } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  };

  const range7d = buildUsageRange(input.now, 7);
  const range30d = buildUsageRange(input.now, 30);

  const [quotaResponse, usage7dResponse, usage30dResponse] = await Promise.all([
    fetchImpl(`${apiBase}/monitor/usage/quota/limit`, {
      method: "GET",
      redirect: "manual",
      headers,
    }),
    fetchImpl(buildUsageDetailUrl(apiBase, range7d), {
      method: "GET",
      redirect: "manual",
      headers,
    }),
    fetchImpl(buildUsageDetailUrl(apiBase, range30d), {
      method: "GET",
      redirect: "manual",
      headers,
    }),
  ]);

  const quotaLogin = quotaResponse.status === 401 || quotaResponse.status === 403;
  const usageLogin =
    usage7dResponse.status === 401 ||
    usage7dResponse.status === 403 ||
    usage30dResponse.status === 401 ||
    usage30dResponse.status === 403;
  if (quotaLogin || usageLogin) {
    return createResult({
      providerId: "zhipu",
      providerName: "智谱 BigModel",
      sourceUrl,
      status: "login_required",
      capturedAt: now,
      summary: `智谱返回 HTTP ${quotaLogin ? quotaResponse.status : usageLogin ? usage7dResponse.status : usage30dResponse.status}，登录态可能已过期`,
      windows: [],
      metrics: {
        httpStatus: quotaLogin
          ? quotaResponse.status
          : usageLogin
            ? usage7dResponse.status
            : usage30dResponse.status,
      },
      meta: { entryUrl: sourceUrl },
    });
  }

  const quotaPayload = quotaResponse.ok ? await quotaResponse.json().catch(() => null) : null;
  const usage7dPayload = usage7dResponse.ok ? await usage7dResponse.json().catch(() => null) : null;
  const usage30dPayload = usage30dResponse.ok ? await usage30dResponse.json().catch(() => null) : null;

  const quotaData = unwrapData(quotaPayload) as QuotaLimitData | null;
  const limits = Array.isArray(quotaData?.limits) ? quotaData.limits! : [];
  const windows = buildWindows(limits);
  const quotaLevel = typeof quotaData?.level === "string" ? quotaData.level : null;

  const usage7d = parseUsageDetail(usage7dPayload);
  const usage30d = parseUsageDetail(usage30dPayload);
  const hasUsageData =
    usage7d.cacheHitRate !== null ||
    usage7d.totalCredits !== null ||
    usage30d.cacheHitRate !== null ||
    usage30d.totalCredits !== null;

  if (windows.length === 0 && !hasUsageData) {
    return createResult({
      providerId: "zhipu",
      providerName: "智谱 BigModel",
      sourceUrl,
      status: "partial",
      capturedAt: now,
      summary: "智谱用量接口未返回可用数据",
      windows: [],
      metrics: {
        quotaLevel,
        httpQuota: quotaResponse.status,
        httpUsage: usage7dResponse.status,
      },
      meta: { entryUrl: sourceUrl },
    });
  }

  return createResult({
    providerId: "zhipu",
    providerName: "智谱 BigModel",
    sourceUrl,
    status: "ready",
    capturedAt: now,
    summary: "智谱 Coding Plan 用量已解析",
    windows,
    metrics: {
      quotaLevel,
      cacheHitRate7d: usage7d.cacheHitRate,
      totalCredits7d: usage7d.totalCredits,
      totalTokens7d: usage7d.totalTokens,
      cacheHitRate30d: usage30d.cacheHitRate,
      totalCredits30d: usage30d.totalCredits,
      totalTokens30d: usage30d.totalTokens,
    },
    meta: { entryUrl: sourceUrl },
  });
}

export const zhipu: ProviderDefinition = {
  id: "zhipu",
  name: "智谱 BigModel",
  sourceUrl: defaultPageUrl,
  description: "智谱 Coding Plan 用量（5小时/周配额、30天 Cache 命中率、积分）",
  fetchSnapshot: fetchZhipuSnapshot,
};
