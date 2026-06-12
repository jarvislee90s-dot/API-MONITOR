import { clampNumber, toIsoString } from "../http";
import type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult, ProviderSnapshot } from "../types";
import { createResult } from "./types";

type OpenRouterResponse = {
  data?: {
    usage?: unknown;
    usage_daily?: unknown;
    usage_weekly?: unknown;
    usage_monthly?: unknown;
    limit?: unknown;
    limit_remaining?: unknown;
    is_free_tier?: unknown;
    rate_limit_requests?: unknown;
    rate_limit_interval?: unknown;
    label?: unknown;
  };
  usage?: unknown;
  usage_daily?: unknown;
  usage_weekly?: unknown;
  usage_monthly?: unknown;
  limit?: unknown;
  limit_remaining?: unknown;
  is_free_tier?: unknown;
  rate_limit_requests?: unknown;
  rate_limit_interval?: unknown;
  label?: unknown;
};

function buildWindows(payload: Record<string, unknown>): ProviderSnapshot["windows"] {
  const usage = clampNumber(payload.usage);
  const usageDaily = clampNumber(payload.usage_daily);
  const usageWeekly = clampNumber(payload.usage_weekly);
  const usageMonthly = clampNumber(payload.usage_monthly);
  const limit = clampNumber(payload.limit);
  const remaining = clampNumber(payload.limit_remaining);

  const windows = [
    {
      key: "current",
      label: "Current",
      used: usage,
      limit,
      remaining,
    },
    {
      key: "daily",
      label: "Daily",
      used: usageDaily,
    },
    {
      key: "weekly",
      label: "Weekly",
      used: usageWeekly,
    },
    {
      key: "monthly",
      label: "Monthly",
      used: usageMonthly,
    },
  ];

  return windows
    .filter((window) => window.used !== null && window.used !== undefined)
    .map((window) => ({
      ...window,
      percentUsed:
        typeof window.used === "number" && typeof limit === "number" && limit > 0
          ? Math.min(100, (window.used / limit) * 100)
          : null,
      percentRemaining:
        typeof window.used === "number" && typeof limit === "number" && limit > 0
          ? Math.max(0, 100 - (window.used / limit) * 100)
          : null,
    }));
}

export async function fetchOpenRouterSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = input.config ?? {};
  const apiKey = typeof config.apiKey === "string" ? config.apiKey : undefined;
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : "https://openrouter.ai";
  const sourceUrl = typeof config.sourceUrl === "string" ? config.sourceUrl : `${baseUrl.replace(/\/$/, "")}/activity`;

  if (!apiKey) {
    return createResult({
      providerId: "openrouter",
      providerName: "OpenRouter",
      sourceUrl,
      status: "login_required",
      capturedAt: now,
      summary: "Missing OpenRouter API key",
      windows: [],
      metrics: {},
      meta: {},
    });
  }

  const request = new Request(new URL("/api/v1/auth/key", baseUrl), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": "ApiMonitor/0.1",
    },
  });

  const response = await fetchImpl(request);
  if (!response.ok) {
    const status = response.status === 401 ? "login_required" : "error";
    return createResult({
      providerId: "openrouter",
      providerName: "OpenRouter",
      sourceUrl,
      status,
      capturedAt: now,
      summary: `OpenRouter API returned HTTP ${response.status}`,
      windows: [],
      metrics: {
        httpStatus: response.status,
      },
      meta: {},
    });
  }

  const payload = (await response.json()) as OpenRouterResponse;
  const data = payload.data ?? payload;
  const limit = clampNumber(data.limit);
  const usage = clampNumber(data.usage);
  const windows = buildWindows(data);

  return createResult({
    providerId: "openrouter",
    providerName: "OpenRouter",
    sourceUrl,
    status: windows.length > 0 ? "ready" : "partial",
    capturedAt: now,
    summary:
      windows.length > 0
        ? "OpenRouter usage snapshot loaded"
        : "OpenRouter snapshot loaded but no usage windows were found",
    windows,
    metrics: {
      usage,
      usageDaily: clampNumber(data.usage_daily),
      usageWeekly: clampNumber(data.usage_weekly),
      usageMonthly: clampNumber(data.usage_monthly),
      limit,
      remaining: clampNumber(data.limit_remaining),
      isFreeTier: Boolean(data.is_free_tier),
      rateLimitRequests: clampNumber(data.rate_limit_requests),
      rateLimitInterval: clampNumber(data.rate_limit_interval),
    },
    meta: {
      label: typeof data.label === "string" ? data.label : "OpenRouter",
    },
  });
}

export const openrouter: ProviderDefinition = {
  id: "openrouter",
  name: "OpenRouter",
  sourceUrl: "https://openrouter.ai/activity",
  description: "OpenRouter account usage and limit snapshot",
  fetchSnapshot: fetchOpenRouterSnapshot,
};
