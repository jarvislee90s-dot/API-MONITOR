import { clampNumber, parseHeadersCookie, toIsoString } from "../http";
import type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult, ProviderSnapshot } from "../types";
import { createResult } from "./types";

type AliyunBailianConfig = {
  pageUrl?: string;
  apiUrl?: string;
  authCookie?: string;
  secToken?: string;
  cloudFetchEnabled?: boolean | string;
};

type GenericUsageResponse = {
  data?: {
    windows?: Array<{
      key: string;
      label: string;
      used: number;
      limit: number;
      resetAt?: string | null;
    }>;
  };
};

type BailianQuotaInfo = {
  per5HourUsedQuota?: unknown;
  per5HourTotalQuota?: unknown;
  per5HourQuotaNextRefreshTime?: unknown;
  perWeekUsedQuota?: unknown;
  perWeekTotalQuota?: unknown;
  perWeekQuotaNextRefreshTime?: unknown;
  perBillMonthUsedQuota?: unknown;
  perBillMonthTotalQuota?: unknown;
  perBillMonthQuotaNextRefreshTime?: unknown;
};

type BailianInstanceInfo = {
  instanceName?: unknown;
  status?: unknown;
  remainingDays?: unknown;
  instanceStartTime?: unknown;
  instanceEndTime?: unknown;
  codingPlanQuotaInfo?: BailianQuotaInfo;
};

type ProviderMetrics = Record<string, number | string | boolean | null>;

const defaultPageUrl = "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/coding-plan";
const codingPlanApi = "zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2";

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isCloudFetchEnabled(value: unknown): boolean {
  return value === true || value === "1" || value === "true";
}

function isTrustedAliyunApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "aliyun.com" || url.hostname.endsWith(".aliyun.com"));
  } catch {
    return false;
  }
}

function looksLikeLoginPage(text: string): boolean {
  return /登录|登入|login|sign in|验证码|verification|aliyun_sso/i.test(text);
}

function toBeijingOffsetIso(value: unknown): string | null {
  const timestamp = clampNumber(value);
  if (typeof timestamp !== "number") return null;
  const beijingDate = new Date(timestamp + 8 * 60 * 60 * 1000);
  return beijingDate.toISOString().replace(/\.\d{3}Z$/, "+08:00");
}

function createManualResult(
  now: string,
  sourceUrl: string,
  meta: Record<string, unknown> = {},
): ProviderFetchResult {
  return createResult({
    providerId: "aliyun-bailian",
    providerName: "阿里云百炼",
    sourceUrl,
    status: "partial",
    capturedAt: now,
    summary: "阿里云百炼需要打开原网页查看；登录态由浏览器保存",
    windows: [],
    metrics: {
      mode: "manual_open",
      hasOriginalPage: true,
    },
    meta: {
      openMode: "external",
      ...meta,
    },
  });
}

function createCornerstoneParam(sourceUrl: string): Record<string, unknown> {
  return {
    feTraceId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    feURL: sourceUrl,
    protocol: "V2",
    console: "ONE_CONSOLE",
    productCode: "p_efm",
    switchUserType: 3,
    domain: "bailian.console.aliyun.com",
    consoleSite: "BAILIAN_ALIYUN",
    userNickName: "",
    userPrincipalName: "",
    xsp_lang: "zh-CN",
    "X-Anonymous-Id": "",
  };
}

function createQuotaWindow(
  key: string,
  label: string,
  usedValue: unknown,
  limitValue: unknown,
  resetValue: unknown,
): ProviderSnapshot["windows"][number] | null {
  const used = clampNumber(usedValue);
  const limit = clampNumber(limitValue);
  if (typeof used !== "number" && typeof limit !== "number") return null;

  return {
    key,
    label,
    used,
    limit,
    remaining: typeof used === "number" && typeof limit === "number" ? Math.max(0, limit - used) : null,
    resetAt: toBeijingOffsetIso(resetValue),
  };
}

function getAliyunError(payload: Record<string, unknown>): string | null {
  const data = asObject(payload.data);
  const directError = [data?.errorCode, data?.errorMsg, payload.errorCode, payload.errorMsg]
    .map(asString)
    .find(Boolean);
  if (directError) return directError;

  const dataV2 = asObject(data?.DataV2);
  const dataV2Data = asObject(dataV2?.data);
  return [dataV2Data?.errorCode, dataV2Data?.errorMsg].map(asString).find(Boolean) ?? null;
}

function parseGenericFormat(payload: Record<string, unknown>): ProviderSnapshot["windows"] {
  const data = (payload as GenericUsageResponse).data;
  if (!data?.windows?.length) return [];

  return data.windows.map((window) => ({
    key: window.key,
    label: window.label,
    used: window.used,
    limit: window.limit,
    remaining: window.limit - window.used,
    resetAt: window.resetAt ?? null,
  }));
}

function parseBailianConsoleFormat(payload: Record<string, unknown>): {
  windows: ProviderSnapshot["windows"];
  metrics: ProviderMetrics;
} {
  const data = asObject(payload.data);
  const dataV2 = asObject(data?.DataV2);
  const nestedData = asObject(asObject(dataV2?.data)?.data);
  const infos = nestedData?.codingPlanInstanceInfos;
  const instance = Array.isArray(infos) ? (asObject(infos[0]) as BailianInstanceInfo | null) : null;
  const quota = asObject(instance?.codingPlanQuotaInfo) as BailianQuotaInfo | null;
  if (!quota || !instance) return { windows: [], metrics: {} };

  const windows = [
    createQuotaWindow("5h", "5h", quota.per5HourUsedQuota, quota.per5HourTotalQuota, quota.per5HourQuotaNextRefreshTime),
    createQuotaWindow("weekly", "Weekly", quota.perWeekUsedQuota, quota.perWeekTotalQuota, quota.perWeekQuotaNextRefreshTime),
    createQuotaWindow(
      "monthly",
      "Monthly",
      quota.perBillMonthUsedQuota,
      quota.perBillMonthTotalQuota,
      quota.perBillMonthQuotaNextRefreshTime,
    ),
  ].filter((window): window is ProviderSnapshot["windows"][number] => Boolean(window));

  return {
    windows,
    metrics: {
      planName: typeof instance.instanceName === "string" ? instance.instanceName : "Coding Plan",
      planStatus: typeof instance.status === "string" ? instance.status : "unknown",
      remainingDays: clampNumber(instance.remainingDays),
      instanceStartTime: toBeijingOffsetIso(instance.instanceStartTime),
      instanceEndTime: toBeijingOffsetIso(instance.instanceEndTime),
    },
  };
}

function buildWindowsAndMetrics(payload: Record<string, unknown>): {
  windows: ProviderSnapshot["windows"];
  metrics: ProviderMetrics;
} {
  const consoleFormat = parseBailianConsoleFormat(payload);
  if (consoleFormat.windows.length > 0) return consoleFormat;

  return { windows: parseGenericFormat(payload), metrics: {} };
}

export async function fetchAliyunBailianSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = (input.config ?? {}) as AliyunBailianConfig;
  const sourceUrl = config.pageUrl ?? defaultPageUrl;

  if (!isCloudFetchEnabled(config.cloudFetchEnabled)) {
    return createManualResult(now, sourceUrl);
  }

  if (!config.authCookie || !config.apiUrl) {
    return createManualResult(now, sourceUrl, {
      cloudFetchStatus: "missing_config",
    });
  }

  if (!isTrustedAliyunApiUrl(config.apiUrl)) {
    return createResult({
      providerId: "aliyun-bailian",
      providerName: "阿里云百炼",
      sourceUrl,
      status: "error",
      capturedAt: now,
      summary: "阿里云百炼 API URL 不安全，已拒绝发送请求",
      windows: [],
      metrics: {},
      meta: {},
    });
  }

  const postData = new URLSearchParams();
  postData.append("params", JSON.stringify({
    Api: codingPlanApi,
    V: "1.0",
    Data: {
      queryCodingPlanInstanceInfoRequest: {
        commodityCode: "sfm_codingplan_public_cn",
        onlyLatestOne: true,
      },
      cornerstoneParam: createCornerstoneParam(sourceUrl),
    },
  }));
  postData.append("region", "cn-beijing");
  if (config.secToken) postData.append("sec_token", config.secToken);

  const cookie = parseHeadersCookie(config.authCookie);
  const response = await fetchImpl(config.apiUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookie ? { Cookie: cookie } : {}),
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApiMonitor/0.1",
      Origin: "https://bailian.console.aliyun.com",
      Referer: "https://bailian.console.aliyun.com/cn-beijing?tab=plan",
    },
    body: postData.toString(),
  });

  if (!response.ok) {
    return createManualResult(now, sourceUrl, {
      cloudFetchStatus: response.status === 401 || response.status === 403 ? "login_required" : "error",
      httpStatus: response.status,
    });
  }

  const text = await response.text();
  if (looksLikeLoginPage(text)) {
    return createManualResult(now, sourceUrl, {
      cloudFetchStatus: "login_required",
    });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return createManualResult(now, sourceUrl, {
      cloudFetchStatus: "non_json",
    });
  }

  const aliyunError = getAliyunError(payload);
  if (aliyunError && /NotLogined|Login|登录|未登录/i.test(aliyunError)) {
    return createManualResult(now, sourceUrl, {
      cloudFetchStatus: "login_required",
    });
  }

  const { windows, metrics } = buildWindowsAndMetrics(payload);
  if (windows.length === 0) {
    return createManualResult(now, sourceUrl, {
      cloudFetchStatus: "empty_usage",
    });
  }

  return createResult({
    providerId: "aliyun-bailian",
    providerName: "阿里云百炼",
    sourceUrl,
    status: "ready",
    capturedAt: now,
    summary: "阿里云百炼 Coding Plan 用量已解析",
    windows,
    metrics,
    meta: {
      cloudFetchStatus: "ready",
      openMode: "external",
    },
  });
}

export const aliyunBailian: ProviderDefinition = {
  id: "aliyun-bailian",
  name: "阿里云百炼",
  sourceUrl: defaultPageUrl,
  description: "阿里云百炼 Coding Plan 原网页入口；云端抓取仅作为实验选项",
  fetchSnapshot: fetchAliyunBailianSnapshot,
};
