import { clampNumber, parseHeadersCookie, toIsoString } from "../http";
import type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult } from "../types";
import { createResult } from "./types";

type XfyunConfig = {
  pageUrl?: string;
  apiUrl?: string;
  authCookie?: string;
};

type XfyunPlanRow = {
  name?: unknown;
  expiresAt?: unknown;
  validFrom?: unknown;
  codingPlanUsageDTO?: Record<string, unknown>;
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstCodingPlanRow(payload: Record<string, unknown>): XfyunPlanRow | null {
  const data = asObject(payload.data);
  const rows = Array.isArray(data?.rows) ? data.rows : null;
  const row = rows?.find((item) => Boolean(asObject(item)?.codingPlanUsageDTO));
  return asObject(row) as XfyunPlanRow | null;
}

function buildXfyunListSnapshot(payload: Record<string, unknown>) {
  const row = firstCodingPlanRow(payload);
  const usage = asObject(row?.codingPlanUsageDTO);
  if (!row || !usage) return null;

  const rp5hUsage = clampNumber(usage.rp5hUsage);
  const rp5hLimit = clampNumber(usage.rp5hLimit);
  const rpwUsage = clampNumber(usage.rpwUsage);
  const rpwLimit = clampNumber(usage.rpwLimit);
  const packageUsage = clampNumber(usage.packageUsage);
  const packageLimit = clampNumber(usage.packageLimit);
  const packageLeft = clampNumber(usage.packageLeft);
  const dailyUsage = clampNumber(usage.dailyUsage);
  const dailyLimit = clampNumber(usage.dailyLimit);
  const hasNumber = (value: number | null): value is number => typeof value === "number";

  const windows = [
    hasNumber(dailyUsage) || hasNumber(dailyLimit)
      ? {
          key: "daily",
          label: "每日",
          used: dailyUsage,
          limit: dailyLimit,
          remaining:
            hasNumber(dailyUsage) && hasNumber(dailyLimit) ? Math.max(dailyLimit - dailyUsage, 0) : undefined,
        }
      : null,
    hasNumber(rp5hUsage) || hasNumber(rp5hLimit)
      ? {
          key: "rp5h",
          label: "5小时",
          used: rp5hUsage,
          limit: rp5hLimit,
          remaining:
            hasNumber(rp5hUsage) && hasNumber(rp5hLimit) ? Math.max(rp5hLimit - rp5hUsage, 0) : undefined,
        }
      : null,
    hasNumber(rpwUsage) || hasNumber(rpwLimit)
      ? {
          key: "weekly",
          label: "每周",
          used: rpwUsage,
          limit: rpwLimit,
          remaining: hasNumber(rpwUsage) && hasNumber(rpwLimit) ? Math.max(rpwLimit - rpwUsage, 0) : undefined,
        }
      : null,
    hasNumber(packageUsage) || hasNumber(packageLimit) || hasNumber(packageLeft)
      ? {
          key: "package",
          label: "套餐",
          used: packageUsage,
          limit: packageLimit,
          remaining: packageLeft,
        }
      : null,
  ].filter((window) => window !== null);

  if (windows.length === 0) return null;

  return {
    windows,
    metrics: {
      planName: typeof row.name === "string" ? row.name : null,
      channel: typeof usage.channel === "string" ? usage.channel : null,
      appId: typeof usage.appId === "string" ? usage.appId : null,
      validFrom: typeof row.validFrom === "string" ? row.validFrom : null,
      expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
      dailyUsage,
      dailyLimit,
      rp5hUsage,
      rp5hLimit,
      rpwUsage,
      rpwLimit,
      packageUsage,
      packageLimit,
      packageLeft,
    },
  };
}

function extractJsonLikeScript(html: string): Record<string, unknown> | null {
  const candidates = [
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;<\/script>/i,
    /window\.__NUXT__\s*=\s*(\{[\s\S]*?\})\s*;<\/script>/i,
    /__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})/i,
  ];

  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (!match?.[1]) continue;
    try {
      return JSON.parse(match[1]) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

function normalizeUsage(payload: Record<string, unknown>): {
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
} {
  const used = clampNumber(payload.used ?? payload.usage ?? payload.consumed ?? payload.consume);
  const limit = clampNumber(payload.limit ?? payload.total ?? payload.quota);
  const remaining = clampNumber(payload.remaining ?? payload.left ?? payload.balance);
  return { used, limit, remaining };
}

export async function fetchXfyunMaaSSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = (input.config ?? {}) as XfyunConfig;
  const sourceUrl = config.pageUrl ?? "https://maas.xfyun.cn/packageSubscription";

  if (!config.authCookie && !config.apiUrl) {
    return createResult({
      providerId: "xfyun-maas",
      providerName: "讯飞 MaaS",
      sourceUrl,
      status: "login_required",
      capturedAt: now,
      summary: "讯飞 MaaS 需要云端登录态",
      windows: [],
      metrics: {
        hasApiUrl: Boolean(config.apiUrl),
        hasAuthCookie: Boolean(config.authCookie),
      },
      meta: {
        entryUrl: sourceUrl,
      },
    });
  }

  const targetUrl = config.apiUrl ?? sourceUrl;
  const response = await fetchImpl(targetUrl, {
    headers: {
      Accept: "application/json,text/html,application/xhtml+xml",
      ...(parseHeadersCookie(config.authCookie)
        ? { Cookie: parseHeadersCookie(config.authCookie)! }
        : {}),
      "User-Agent": "ApiMonitor/0.1",
    },
  });

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const loginRequired = /login|sign in|验证码|verification/i.test(text);

  if (!response.ok) {
    return createResult({
      providerId: "xfyun-maas",
      providerName: "讯飞 MaaS",
      sourceUrl,
      status: response.status === 401 || response.status === 403 ? "login_required" : "error",
      capturedAt: now,
      summary: `讯飞 MaaS 返回 HTTP ${response.status}`,
      windows: [],
      metrics: { httpStatus: response.status },
      meta: {
        entryUrl: sourceUrl,
      },
    });
  }

  if (contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(text) as Record<string, unknown>;
      const codingPlanList = buildXfyunListSnapshot(payload);
      if (codingPlanList) {
        return createResult({
          providerId: "xfyun-maas",
          providerName: "讯飞 MaaS",
          sourceUrl,
          status: "ready",
          capturedAt: now,
          summary: "讯飞 MaaS Coding Plan 用量已解析",
          windows: codingPlanList.windows,
          metrics: codingPlanList.metrics,
          meta: {
            entryUrl: sourceUrl,
          },
        });
      }

      const usage = normalizeUsage(payload);
      const hasUsage = Object.values(usage).some((value) => typeof value === "number");
      return createResult({
        providerId: "xfyun-maas",
        providerName: "讯飞 MaaS",
        sourceUrl,
        status: hasUsage ? "ready" : "partial",
        capturedAt: now,
        summary: hasUsage ? "讯飞 MaaS JSON 状态已解析" : "讯飞 MaaS JSON 已加载但未找到用量字段",
        windows: hasUsage
          ? [
              {
                key: "subscription",
                label: "Subscription",
                used: usage.used,
                limit: usage.limit,
                remaining: usage.remaining,
              },
            ]
          : [],
        metrics: usage,
        meta: {
          entryUrl: sourceUrl,
        },
      });
    } catch {
      return createResult({
        providerId: "xfyun-maas",
        providerName: "讯飞 MaaS",
        sourceUrl,
        status: "partial",
        capturedAt: now,
        summary: "讯飞 MaaS JSON 解析失败",
        windows: [],
        metrics: {},
        meta: {
          entryUrl: sourceUrl,
        },
      });
    }
  }

  const embeddedState = extractJsonLikeScript(text);
  if (embeddedState) {
    const usage = normalizeUsage(embeddedState);
    const hasUsage = Object.values(usage).some((value) => typeof value === "number");
    return createResult({
      providerId: "xfyun-maas",
      providerName: "讯飞 MaaS",
      sourceUrl,
      status: loginRequired ? "login_required" : hasUsage ? "ready" : "partial",
      capturedAt: now,
      summary: loginRequired
        ? "讯飞 MaaS 页面提示需要登录"
        : hasUsage
          ? "讯飞 MaaS 页面状态已解析"
          : "讯飞 MaaS 页面已加载但未找到用量字段",
      windows: hasUsage
        ? [
            {
              key: "subscription",
              label: "Subscription",
              used: usage.used,
              limit: usage.limit,
              remaining: usage.remaining,
            },
          ]
        : [],
      metrics: usage,
      meta: {
        entryUrl: sourceUrl,
      },
    });
  }

  return createResult({
    providerId: "xfyun-maas",
    providerName: "讯飞 MaaS",
    sourceUrl,
    status: loginRequired ? "login_required" : "partial",
    capturedAt: now,
    summary: loginRequired ? "讯飞 MaaS 页面提示需要登录" : "讯飞 MaaS 页面加载成功但未提取到稳定用量字段",
    windows: [],
    metrics: {},
    meta: {
      entryUrl: sourceUrl,
    },
  });
}

export const xfyunMaaS: ProviderDefinition = {
  id: "xfyun-maas",
  name: "讯飞 MaaS",
  sourceUrl: "https://maas.xfyun.cn/packageSubscription",
  description: "讯飞 MaaS 用量入口和登录状态提示",
  fetchSnapshot: fetchXfyunMaaSSnapshot,
};
