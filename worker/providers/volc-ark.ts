import { clampNumber, parseHeadersCookie, toIsoString } from "../http";
import type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult, ProviderSnapshot } from "../types";
import { createResult } from "./types";

type VolcArkConfig = {
  pageUrl?: string;
  apiUrl?: string;
  authCookie?: string;
};

// 火山方舟 Coding Plan 用量查询端点，返回 session/weekly/monthly 百分比用量
const defaultPageUrl =
  "https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=subscribe";
const defaultApiUrl =
  "https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetCodingPlanUsage?";

type QuotaItem = {
  Level?: unknown;
  Percent?: unknown;
  ResetTimestamp?: unknown;
};

type CodingPlanUsageResponse = {
  ResponseMetadata?: { RequestId?: string };
  Result?: {
    Status?: unknown;
    UpdateTimestamp?: unknown;
    QuotaUsage?: QuotaItem[];
  };
};

// 从 cookie 串里提取 csrfToken，火山引擎控制台要求请求头 x-csrf-token 与该 cookie 值一致
function extractCsrfToken(authCookie: string): string | null {
  const match = authCookie.match(/csrfToken=([^;]+)/i);
  return match?.[1] ? match[1] : null;
}

// 校验 API URL 是否属于火山引擎域名，防止凭据被发往非预期地址
function isTrustedVolcApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "volcengine.com" || url.hostname.endsWith(".volcengine.com"));
  } catch {
    return false;
  }
}

// 把秒级时间戳转成 ISO 字符串
function resetTimestampToIso(value: unknown): string | null {
  const ts = clampNumber(value);
  if (typeof ts !== "number") return null;
  return toIsoString(ts * 1000);
}

// 窗口级别到展示标签的映射
const WINDOW_LABELS: Record<string, string> = {
  session: "5小时",
  weekly: "每周",
  monthly: "每月",
};

function buildWindows(items: QuotaItem[]): ProviderSnapshot["windows"] {
  return items
    .map((item) => {
      const level = typeof item.Level === "string" ? item.Level : "";
      const percent = clampNumber(item.Percent);
      if (typeof percent !== "number" || !WINDOW_LABELS[level]) return null;
      const remaining = Math.max(0, 100 - percent);
      return {
        key: level,
        label: WINDOW_LABELS[level],
        used: percent,
        limit: 100,
        remaining,
        percentUsed: percent,
        percentRemaining: remaining,
        resetAt: resetTimestampToIso(item.ResetTimestamp),
      } as ProviderSnapshot["windows"][number];
    })
    .filter((window): window is ProviderSnapshot["windows"][number] => window !== null);
}

export async function fetchVolcArkSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = (input.config ?? {}) as VolcArkConfig;
  const sourceUrl = config.pageUrl?.trim() || defaultPageUrl;

  if (!config.authCookie) {
    return createResult({
      providerId: "volc-ark",
      providerName: "火山方舟",
      sourceUrl,
      status: "login_required",
      capturedAt: now,
      summary: "火山方舟需要登录态 cookie",
      windows: [],
      metrics: { hasAuthCookie: false },
      meta: { entryUrl: sourceUrl },
    });
  }

  const apiUrl = config.apiUrl?.trim() || defaultApiUrl;
  if (!isTrustedVolcApiUrl(apiUrl)) {
    return createResult({
      providerId: "volc-ark",
      providerName: "火山方舟",
      sourceUrl,
      status: "error",
      capturedAt: now,
      summary: "火山方舟 API URL 不安全，已拒绝发送请求",
      windows: [],
      metrics: {},
      meta: { entryUrl: sourceUrl },
    });
  }

  const csrfToken = extractCsrfToken(config.authCookie);
  const cookie = parseHeadersCookie(config.authCookie);

  const response = await fetchImpl(apiUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-csrf-token": csrfToken ?? "",
      ...(cookie ? { Cookie: cookie } : {}),
      Referer: sourceUrl,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApiMonitor/0.1",
    },
    body: "{}",
  });

  if (response.status === 401 || response.status === 403) {
    return createResult({
      providerId: "volc-ark",
      providerName: "火山方舟",
      sourceUrl,
      status: "login_required",
      capturedAt: now,
      summary: `火山方舟返回 HTTP ${response.status}，登录态可能已过期`,
      windows: [],
      metrics: { httpStatus: response.status },
      meta: { entryUrl: sourceUrl },
    });
  }

  if (!response.ok) {
    return createResult({
      providerId: "volc-ark",
      providerName: "火山方舟",
      sourceUrl,
      status: "error",
      capturedAt: now,
      summary: `火山方舟返回 HTTP ${response.status}`,
      windows: [],
      metrics: { httpStatus: response.status },
      meta: { entryUrl: sourceUrl },
    });
  }

  let payload: CodingPlanUsageResponse;
  try {
    payload = (await response.json()) as CodingPlanUsageResponse;
  } catch {
    return createResult({
      providerId: "volc-ark",
      providerName: "火山方舟",
      sourceUrl,
      status: "partial",
      capturedAt: now,
      summary: "火山方舟响应解析失败",
      windows: [],
      metrics: {},
      meta: { entryUrl: sourceUrl },
    });
  }

  const items = payload.Result?.QuotaUsage ?? [];
  const windows = buildWindows(items);
  const planStatus = typeof payload.Result?.Status === "string" ? payload.Result.Status : null;

  if (windows.length === 0) {
    return createResult({
      providerId: "volc-ark",
      providerName: "火山方舟",
      sourceUrl,
      status: "partial",
      capturedAt: now,
      summary: "火山方舟用量已加载但未找到用量窗口",
      windows: [],
      metrics: { planStatus },
      meta: { entryUrl: sourceUrl },
    });
  }

  return createResult({
    providerId: "volc-ark",
    providerName: "火山方舟",
    sourceUrl,
    status: "ready",
    capturedAt: now,
    summary: "火山方舟 Coding Plan 用量已解析",
    windows,
    metrics: {
      planStatus,
      updateTimestamp: resetTimestampToIso(payload.Result?.UpdateTimestamp),
      sessionPercent: clampNumber(items.find((i) => i.Level === "session")?.Percent),
      weeklyPercent: clampNumber(items.find((i) => i.Level === "weekly")?.Percent),
      monthlyPercent: clampNumber(items.find((i) => i.Level === "monthly")?.Percent),
    },
    meta: { entryUrl: sourceUrl },
  });
}

export const volcArk: ProviderDefinition = {
  id: "volc-ark",
  name: "火山方舟",
  sourceUrl: defaultPageUrl,
  description: "火山方舟 Coding Plan 用量（5小时/周/月百分比）",
  fetchSnapshot: fetchVolcArkSnapshot,
};