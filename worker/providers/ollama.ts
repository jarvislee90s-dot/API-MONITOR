import { clampNumber, parseHeadersCookie, toIsoString } from "../http";
import type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult, ProviderSnapshot } from "../types";
import { createResult } from "./types";

type OllamaConfig = {
  apiKey?: string;
  apiUrl?: string;
  pageUrl?: string;
  authCookie?: string;
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

// settings 页是网页登录态（cookie）才能看到的服务端渲染页面，需用浏览器 UA
const settingsUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
// 仅在网页 HTML 未给出 data-time 时作为兜底
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

// ---------------------------------------------------------------------------
// settings 页 HTML 解析（网页登录态路径）
// 页面为服务端渲染：额度百分比在 data-usage-track 的 aria-label 上，
// 重置时间是 local-time 节点的 data-time，模型请求数在 data-usage-segment / weekly-usage-models 区块。
// ---------------------------------------------------------------------------

export type OllamaSettingsUsage = {
  sessionPercent: number | null;
  weeklyPercent: number | null;
  sessionResetAt: string | null;
  weeklyResetAt: string | null;
  sessionModels: Array<{ name: string; requests: number }>;
  weeklyModels: Array<{ name: string; requests: number }>;
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// 取 [startAnchor, endAnchor) 之间的片段；锚点缺失时返回空串（不误取后续区块）
function sliceBetween(html: string, startAnchor: string, endAnchor: string): string {
  const start = html.indexOf(startAnchor);
  if (start < 0) return "";
  const end = html.indexOf(endAnchor, start + startAnchor.length);
  return end > start ? html.slice(start, end) : "";
}

// 从片段中第一个 data-time 提取重置时间
function parseFirstResetAt(block: string): string | null {
  const match = block.match(/data-time="([^"]+)"/);
  if (!match?.[1]) return null;
  const date = new Date(match[1]);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseUsagePercent(html: string, label: "Session usage" | "Weekly usage"): number | null {
  const match = html.match(new RegExp(`aria-label="${label} ([\\d.]+)% used"`));
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

// 5 小时窗口的模型明细来自进度条分段：data-usage-segment data-model="x" data-requests="N"
// 逐个解析 button 标签后再取属性，避免属性间换行/顺序变化导致失配
function parseSegmentedModels(block: string): Array<{ name: string; requests: number }> {
  const models: Array<{ name: string; requests: number }> = [];
  for (const tag of block.matchAll(/<button[^>]*data-usage-segment[^>]*>/g)) {
    const name = decodeHtmlEntities(/data-model="([^"]*)"/.exec(tag[0])?.[1] ?? "");
    const requestsRaw = /data-requests="(\d+)"/.exec(tag[0])?.[1];
    const requests = requestsRaw ? Number(requestsRaw) : Number.NaN;
    if (name && Number.isFinite(requests)) models.push({ name, requests });
  }
  return models.sort((a, b) => b.requests - a.requests);
}

// 每周模型明细列表：title="模型名" ... N requests
function parseWeeklyModelList(block: string): Array<{ name: string; requests: number }> {
  const models: Array<{ name: string; requests: number }> = [];
  const pattern = /title="([^"]+)"[^>]*>[^<]*<\/span>\s*<span[^>]*>\s*([\d,]+)\s*requests\s*<\/span>/g;
  for (const match of block.matchAll(pattern)) {
    const name = decodeHtmlEntities(match[1]);
    const requests = Number(match[2].replace(/,/g, ""));
    if (name && Number.isFinite(requests)) models.push({ name, requests });
  }
  return models.sort((a, b) => b.requests - a.requests);
}

export function parseOllamaSettingsHtml(html: string): OllamaSettingsUsage {
  const sessionBlock = sliceBetween(html, 'aria-label="Session usage', 'aria-label="Weekly usage');
  const weeklyBlock = sliceBetween(html, 'aria-label="Weekly usage', 'id="weekly-usage-models"');
  const weeklyModelsBlock = sliceBetween(html, 'id="weekly-usage-models"', '<form method="POST" action="/settings"');

  return {
    sessionPercent: parseUsagePercent(html, "Session usage"),
    weeklyPercent: parseUsagePercent(html, "Weekly usage"),
    sessionResetAt: parseFirstResetAt(sessionBlock),
    weeklyResetAt: parseFirstResetAt(weeklyBlock),
    sessionModels: parseSegmentedModels(sessionBlock),
    weeklyModels: parseWeeklyModelList(weeklyModelsBlock),
  };
}

// 由解析结果组装就绪快照（网页路径与 API 路径共用）
function buildReadyResult(input: {
  sourceUrl: string;
  capturedAt: string;
  sessionPercent: number | null;
  weeklyPercent: number | null;
  sessionResetAt: string | null;
  weeklyResetAt: string | null;
  sessionModels: Array<{ name: string; requests: number }>;
  weeklyModels: Array<{ name: string; requests: number }>;
  fetchMethod: string;
  fallbackResetBase: Date;
}): ProviderFetchResult {
  const windows: ProviderSnapshot["windows"] = [];
  if (input.sessionPercent !== null) {
    windows.push({
      key: "rp5h",
      label: "5小时",
      used: input.sessionPercent,
      limit: 100,
      remaining: Math.max(0, 100 - input.sessionPercent),
      percentUsed: input.sessionPercent,
      percentRemaining: Math.max(0, 100 - input.sessionPercent),
      resetAt: input.sessionResetAt ?? nextSessionReset(input.fallbackResetBase),
    });
  }
  if (input.weeklyPercent !== null) {
    windows.push({
      key: "weekly",
      label: "每周",
      used: input.weeklyPercent,
      limit: 100,
      remaining: Math.max(0, 100 - input.weeklyPercent),
      percentUsed: input.weeklyPercent,
      percentRemaining: Math.max(0, 100 - input.weeklyPercent),
      resetAt: input.weeklyResetAt ?? nextWeeklyReset(input.fallbackResetBase),
    });
  }

  return createResult({
    providerId: "ollama",
    providerName: "Ollama Pro",
    sourceUrl: input.sourceUrl,
    status: "ready",
    capturedAt: input.capturedAt,
    summary: "Ollama Pro 用量已解析",
    windows,
    metrics: {
      sessionUsagePercent: input.sessionPercent,
      weeklyUsagePercent: input.weeklyPercent,
      sessionRequestCount: input.sessionModels.reduce((sum, m) => sum + m.requests, 0),
      weeklyRequestCount: input.weeklyModels.reduce((sum, m) => sum + m.requests, 0),
      weeklyModelCount: input.weeklyModels.length,
      weeklyModels: JSON.stringify(input.weeklyModels),
      fetchMethod: input.fetchMethod,
    },
    meta: { entryUrl: input.sourceUrl },
  });
}

export async function fetchOllamaSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = (input.config ?? {}) as OllamaConfig;
  const sourceUrl = config.pageUrl?.trim() || defaultPageUrl;
  const hasCookie = Boolean(config.authCookie);
  const hasApiKey = Boolean(config.apiKey);

  if (!hasCookie && !hasApiKey) {
    return createResult({
      providerId: "ollama",
      providerName: "Ollama Pro",
      sourceUrl,
      status: "login_required",
      capturedAt: now,
      summary: "Ollama 需要登录态 cookie 或 API Key",
      windows: [],
      metrics: { hasAuthCookie: false, hasApiKey: false },
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

  // 1) 优先走网页登录态：settings 页 HTML 内含 Session/Weekly 额度与模型请求明细
  let cookieStatus: number | null = null;
  let cookiePageUnparsed = false;
  if (hasCookie && isTrustedOllamaUrl(sourceUrl)) {
    try {
      const pageResponse = await fetchImpl(sourceUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "text/html",
          Cookie: parseHeadersCookie(config.authCookie) ?? "",
          "User-Agent": settingsUserAgent,
        },
      });
      cookieStatus = pageResponse.status;

      if (pageResponse.ok) {
        const html = await pageResponse.text();
        const parsed = parseOllamaSettingsHtml(html);
        const hasData =
          parsed.sessionPercent !== null ||
          parsed.weeklyPercent !== null ||
          parsed.weeklyModels.length > 0;
        if (hasData) {
          return buildReadyResult({
            sourceUrl,
            capturedAt: now,
            sessionPercent: parsed.sessionPercent,
            weeklyPercent: parsed.weeklyPercent,
            sessionResetAt: parsed.sessionResetAt,
            weeklyResetAt: parsed.weeklyResetAt,
            sessionModels: parsed.sessionModels,
            weeklyModels: parsed.weeklyModels,
            fetchMethod: "cookie",
            fallbackResetBase: input.now,
          });
        }
        cookiePageUnparsed = true;
      }
    } catch {
      cookieStatus = null;
    }
  }

  // 2) 回退 API Key（官方 /api/usage，仅提供请求数统计，可能无额度百分比）
  if (hasApiKey) {
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
        summary: `Ollama 返回 HTTP ${response.status}，登录态可能已失效；请重新运行 scripts/refresh-ollama-cookie.ts`,
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

    const sessionPercent = toPercent(payload.limits?.session?.usage);
    const weeklyPercent = toPercent(payload.limits?.weekly?.usage);
    const sessionModels = normalizeModels(payload.limits?.session);
    const weeklyModels = normalizeModels(payload.limits?.weekly);

    if (sessionPercent === null && weeklyPercent === null && weeklyModels.length === 0) {
      return createResult({
        providerId: "ollama",
        providerName: "Ollama Pro",
        sourceUrl,
        status: "partial",
        capturedAt: now,
        summary:
          "Ollama API Key 通道未返回额度数据（官方接口已变更，仅提供请求数）；请配置网页登录态 cookie",
        windows: [],
        metrics: { fetchMethod: "apiKey" },
        meta: { entryUrl: sourceUrl },
      });
    }

    return buildReadyResult({
      sourceUrl,
      capturedAt: now,
      sessionPercent,
      weeklyPercent,
      sessionResetAt: null,
      weeklyResetAt: null,
      sessionModels,
      weeklyModels,
      fetchMethod: "apiKey",
      fallbackResetBase: input.now,
    });
  }

  // 3) 只有 cookie 且网页路径未取到数据
  const expired = cookieStatus === 401 || cookieStatus === 403;
  return createResult({
    providerId: "ollama",
    providerName: "Ollama Pro",
    sourceUrl,
    status: expired ? "login_required" : "partial",
    capturedAt: now,
    summary: expired
      ? `Ollama 网页登录态已过期（HTTP ${cookieStatus}），请重新运行 scripts/refresh-ollama-cookie.ts`
      : cookiePageUnparsed
        ? "Ollama settings 页结构变化，未能解析出额度数据"
        : `Ollama settings 页请求失败${cookieStatus ? `（HTTP ${cookieStatus}）` : ""}，请检查网络或重新运行 scripts/refresh-ollama-cookie.ts`,
    windows: [],
    metrics: { httpStatus: cookieStatus, fetchMethod: "cookie" },
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
