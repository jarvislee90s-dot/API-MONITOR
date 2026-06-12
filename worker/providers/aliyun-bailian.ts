import { clampNumber, parseHeadersCookie, toIsoString } from "../http";
import type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult, ProviderSnapshot } from "../types";
import { createResult } from "./types";

type AliyunBailianConfig = {
  pageUrl?: string;
  apiUrl?: string;
  authCookie?: string;
};

type AliyunWindowPayload = {
  key?: unknown;
  label?: unknown;
  used?: unknown;
  usage?: unknown;
  limit?: unknown;
  total?: unknown;
  remaining?: unknown;
  resetAt?: unknown;
};

const defaultPageUrl = "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/coding-plan";

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getWindowPayloads(payload: Record<string, unknown>): AliyunWindowPayload[] {
  const data = asObject(payload.data) ?? payload;
  const windows = data.windows ?? data.quotaWindows ?? data.items;
  return Array.isArray(windows) ? (windows as AliyunWindowPayload[]) : [];
}

function buildWindows(payload: Record<string, unknown>): ProviderSnapshot["windows"] {
  return getWindowPayloads(payload).flatMap((window, index) => {
    const used = clampNumber(window.used ?? window.usage);
    const limit = clampNumber(window.limit ?? window.total);
    const remaining = clampNumber(window.remaining);
    if (typeof used !== "number" && typeof limit !== "number") return [];

    return [
      {
        key: typeof window.key === "string" ? window.key : `window-${index + 1}`,
        label: typeof window.label === "string" ? window.label : "Coding Plan",
        used,
        limit,
        remaining:
          typeof remaining === "number"
            ? remaining
            : typeof used === "number" && typeof limit === "number"
              ? Math.max(0, limit - used)
              : null,
        resetAt: typeof window.resetAt === "string" ? window.resetAt : null,
      },
    ];
  });
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

export async function fetchAliyunBailianSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = (input.config ?? {}) as AliyunBailianConfig;
  const sourceUrl = config.pageUrl ?? defaultPageUrl;

  if (!config.authCookie) {
    return createResult({
      providerId: "aliyun-bailian",
      providerName: "阿里云百炼",
      sourceUrl,
      status: "login_required",
      capturedAt: now,
      summary: "Missing Aliyun Bailian auth cookie",
      windows: [],
      metrics: {},
      meta: {},
    });
  }

  if (!config.apiUrl) {
    return createResult({
      providerId: "aliyun-bailian",
      providerName: "阿里云百炼",
      sourceUrl,
      status: "partial",
      capturedAt: now,
      summary: "阿里云百炼看板入口已配置，等待补充稳定 JSON 用量接口",
      windows: [],
      metrics: { hasAuthCookie: true },
      meta: {},
    });
  }

  if (!isTrustedAliyunApiUrl(config.apiUrl)) {
    return createResult({
      providerId: "aliyun-bailian",
      providerName: "阿里云百炼",
      sourceUrl,
      status: "error",
      capturedAt: now,
      summary: "阿里云百炼 API URL 不安全，已拒绝发送登录态",
      windows: [],
      metrics: {},
      meta: {},
    });
  }

  const response = await fetchImpl(config.apiUrl, {
    redirect: "manual",
    headers: {
      Accept: "application/json",
      ...(parseHeadersCookie(config.authCookie) ? { Cookie: parseHeadersCookie(config.authCookie)! } : {}),
      "User-Agent": "Mozilla/5.0 ApiMonitor/0.1",
    },
  });

  if (!response.ok) {
    return createResult({
      providerId: "aliyun-bailian",
      providerName: "阿里云百炼",
      sourceUrl,
      status: response.status === 401 || response.status === 403 ? "login_required" : "error",
      capturedAt: now,
      summary: `阿里云百炼接口返回 HTTP ${response.status}`,
      windows: [],
      metrics: { httpStatus: response.status },
      meta: {},
    });
  }

  const text = await response.text();
  if (looksLikeLoginPage(text)) {
    return createResult({
      providerId: "aliyun-bailian",
      providerName: "阿里云百炼",
      sourceUrl,
      status: "login_required",
      capturedAt: now,
      summary: "阿里云百炼接口返回登录页",
      windows: [],
      metrics: {},
      meta: {},
    });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return createResult({
      providerId: "aliyun-bailian",
      providerName: "阿里云百炼",
      sourceUrl,
      status: "error",
      capturedAt: now,
      summary: "阿里云百炼接口返回非 JSON 响应",
      windows: [],
      metrics: {},
      meta: {},
    });
  }
  const data = asObject(payload.data) ?? payload;
  const windows = buildWindows(payload);

  return createResult({
    providerId: "aliyun-bailian",
    providerName: "阿里云百炼",
    sourceUrl,
    status: windows.length > 0 ? "ready" : "partial",
    capturedAt: now,
    summary: windows.length > 0 ? "阿里云百炼 Coding Plan 用量已解析" : "阿里云百炼接口未返回窗口数据",
    windows,
    metrics: {
      planName: typeof data.planName === "string" ? data.planName : "Coding Plan",
    },
    meta: {},
  });
}

export const aliyunBailian: ProviderDefinition = {
  id: "aliyun-bailian",
  name: "阿里云百炼",
  sourceUrl: defaultPageUrl,
  description: "阿里云百炼 Coding Plan 用量入口和可配置 API 抓取",
  fetchSnapshot: fetchAliyunBailianSnapshot,
};
