import { clampNumber, toIsoString } from "../http";
import type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult, ProviderSnapshot } from "../types";
import { createResult } from "./types";

type OllamaConfig = {
  apiKey?: string;
  apiUrl?: string;
  pageUrl?: string;
};

type OllamaModelUsage = {
  name?: unknown;
  request_count?: unknown;
};

type OllamaLimitWindow = {
  usage?: unknown;
  models?: OllamaModelUsage[];
};

type OllamaUsagePayload = {
  limits?: {
    session?: OllamaLimitWindow;
    weekly?: OllamaLimitWindow;
  };
};

const defaultPageUrl = "https://ollama.com/settings";
const defaultApiUrl = "https://ollama.com/v1";

// API 域名白名单，防止凭据被发往非预期地址
function isTrustedOllamaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "ollama.com" || url.hostname.endsWith(".ollama.com"));
  } catch {
    return false;
  }
}

// 把 /api/usage 的 usage 小数（0~1）转成百分比数值
function toPercent(value: unknown): number | null {
  const number = clampNumber(value);
  if (typeof number !== "number") return null;
  return Math.round(number * 1000) / 10;
}

// Ollama 官方规则（pricing 页）：session 每 5 小时重置（对齐 UTC 5 的倍数整点），weekly 每 7 天重置（对齐周一 00:00 UTC）
function nextSessionReset(now: Date): string {
  const nextHour = (Math.floor(now.getUTCHours() / 5) + 1) * 5;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), nextHour)).toISOString();
}

function nextWeeklyReset(now: Date): string {
  // 今天已是周一则指向下周一，保证返回时间在未来
  let daysUntilMonday = (8 - now.getUTCDay()) % 7;
  if (daysUntilMonday === 0) daysUntilMonday = 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday, 0)).toISOString();
}

// models 归一化为 {name, requests}，按请求数降序
function normalizeModels(window?: OllamaLimitWindow): Array<{ name: string; requests: number }> {
  if (!window?.models?.length) return [];
  return window.models
    .map((item) => {
      const name = typeof item.name === "string" && item.name.length > 0 ? item.name : null;
      const requests = clampNumber(item.request_count);
      if (!name || typeof requests !== "number") return null;
      return { name, requests };
    })
    .filter((item): item is { name: string; requests: number } => item !== null)
    .sort((a, b) => b.requests - a.requests);
}

export async function fetchOllamaSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = (input.config ?? {}) as OllamaConfig;
  const sourceUrl = config.pageUrl?.trim() || defaultPageUrl;

  if (!config.apiKey) {
    return createResult({
      providerId: "ollama",
      providerName: "Ollama Pro",
      sourceUrl,
      status: "login_required",
      capturedAt: now,
      summary: "Ollama 需要 API Key",
      windows: [],
      metrics: { hasApiKey: false },
      meta: { entryUrl: sourceUrl },
    });
  }

  const apiBase = (config.apiUrl?.trim() || defaultApiUrl).replace(/\/+$/, "");
  if (!isTrustedOllamaUrl(apiBase)) {
    return createResult({
      providerId: "ollama",
      providerName: "Ollama Pro",
      sourceUrl,
      status: "error",
      capturedAt: now,
      summary: "Ollama API URL 不安全，已拒绝发送请求",
      windows: [],
      metrics: {},
      meta: { entryUrl: sourceUrl },
    });
  }

  // /v1 是 OpenAI 兼容端点；用量接口固定在 /api/usage
  const usageUrl = apiBase.replace(/\/v1$/, "") + "/api/usage";
  const response = await fetchImpl(usageUrl, {
    method: "GET",
    redirect: "manual",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApiMonitor/0.1",
    },
  });

  if (response.status === 401 || response.status === 403) {
    return createResult({
      providerId: "ollama",
      providerName: "Ollama Pro",
      sourceUrl,
      status: "login_required",
      capturedAt: now,
      summary: `Ollama 返回 HTTP ${response.status}，API Key 可能已失效`,
      windows: [],
      metrics: { httpStatus: response.status },
      meta: { entryUrl: sourceUrl },
    });
  }

  if (!response.ok) {
    return createResult({
      providerId: "ollama",
      providerName: "Ollama Pro",
      sourceUrl,
      status: "error",
      capturedAt: now,
      summary: `Ollama 返回 HTTP ${response.status}`,
      windows: [],
      metrics: { httpStatus: response.status },
      meta: { entryUrl: sourceUrl },
    });
  }

  let payload: OllamaUsagePayload;
  try {
    payload = (await response.json()) as OllamaUsagePayload;
  } catch {
    return createResult({
      providerId: "ollama",
      providerName: "Ollama Pro",
      sourceUrl,
      status: "partial",
      capturedAt: now,
      summary: "Ollama 用量响应解析失败",
      windows: [],
      metrics: {},
      meta: { entryUrl: sourceUrl },
    });
  }

  const session = payload.limits?.session;
  const weekly = payload.limits?.weekly;
  const sessionPercent = toPercent(session?.usage);
  const weeklyPercent = toPercent(weekly?.usage);
  const sessionModels = normalizeModels(session);
  const weeklyModels = normalizeModels(weekly);

  const windows: ProviderSnapshot["windows"] = [];
  if (sessionPercent !== null) {
    windows.push({
      key: "rp5h",
      label: "5小时",
      used: sessionPercent,
      limit: 100,
      remaining: Math.max(0, 100 - sessionPercent),
      percentUsed: sessionPercent,
      percentRemaining: Math.max(0, 100 - sessionPercent),
      resetAt: nextSessionReset(input.now)
    });
  }
  if (weeklyPercent !== null) {
    windows.push({
      key: "weekly",
      label: "每周",
      used: weeklyPercent,
      limit: 100,
      remaining: Math.max(0, 100 - weeklyPercent),
      percentUsed: weeklyPercent,
      percentRemaining: Math.max(0, 100 - weeklyPercent),
      resetAt: nextWeeklyReset(input.now)
    });
  }

  if (windows.length === 0 && weeklyModels.length === 0) {
    return createResult({
      providerId: "ollama",
      providerName: "Ollama Pro",
      sourceUrl,
      status: "partial",
      capturedAt: now,
      summary: "Ollama 用量接口未返回可用数据",
      windows: [],
      metrics: {},
      meta: { entryUrl: sourceUrl },
    });
  }

  return createResult({
    providerId: "ollama",
    providerName: "Ollama Pro",
    sourceUrl,
    status: "ready",
    capturedAt: now,
    summary: "Ollama Pro 用量已解析",
    windows,
    metrics: {
      sessionUsagePercent: sessionPercent,
      weeklyUsagePercent: weeklyPercent,
      sessionRequestCount: sessionModels.reduce((sum, m) => sum + m.requests, 0),
      weeklyRequestCount: weeklyModels.reduce((sum, m) => sum + m.requests, 0),
      weeklyModelCount: weeklyModels.length,
      weeklyModels: JSON.stringify(weeklyModels),
    },
    meta: { entryUrl: sourceUrl },
  });
}

export const ollama: ProviderDefinition = {
  id: "ollama",
  name: "Ollama Pro",
  sourceUrl: defaultPageUrl,
  description: "Ollama Pro 用量（5小时/周额度 + 本周模型请求数）",
  fetchSnapshot: fetchOllamaSnapshot,
};
