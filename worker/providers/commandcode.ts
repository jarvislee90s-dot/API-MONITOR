import { parseHeadersCookie, toIsoString } from "../http";
import type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult, ProviderSnapshot } from "../types";
import { createResult } from "./types";
import {
  parseCommandCodeTopModels,
  parseCommandCodeWindows,
  type CommandCodeByModel,
  type CommandCodeCredits,
  type CommandCodeSummary,
} from "./commandcode-parser";

type CommandCodeConfig = {
  // __Secure-commandcode_prod_.session_token 的值（不要带 cookie 名）
  sessionCookie?: string;
  // commandcode.ai 路径里的账号 slug，例如 jarvislee90s-dot
  account?: string;
  apiBaseUrl?: string;
  // Supabase Edge Function 兜底（Cloudflare 出口被 commandcode 拒绝时使用）
  edgeProxyUrl?: string;
  edgeProxyKey?: string;
};

const SESSION_COOKIE_NAME = "__Secure-commandcode_prod_.session_token";
const defaultApiBaseUrl = "https://api.commandcode.ai";
const defaultSiteOrigin = "https://commandcode.ai";

const browserUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

type SnapshotBase = Pick<ProviderSnapshot, "providerId" | "providerName" | "sourceUrl" | "capturedAt">;
type FetchMethod = "api" | "edge_function";

type CommandCodeBundle = {
  summary: CommandCodeSummary | null;
  byModel: CommandCodeByModel | null;
  credits: CommandCodeCredits | null;
};

function getApiBaseUrl(config: CommandCodeConfig): string {
  return (config.apiBaseUrl?.replace(/\/$/, "") || defaultApiBaseUrl);
}

function getSourceUrl(config: CommandCodeConfig): string {
  const account = config.account?.trim();
  return account ? `${defaultSiteOrigin}/${encodeURIComponent(account)}/settings/usage` : `${defaultSiteOrigin}/settings/usage`;
}

function normalizeCookie(rawCookie: string | undefined): string | undefined {
  const trimmed = parseHeadersCookie(rawCookie);
  if (!trimmed) return undefined;
  const parts = trimmed.split(";").map((part) => part.trim()).filter((part) => part.length > 0);
  const sessionPart = parts.find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (sessionPart) return sessionPart.slice(SESSION_COOKIE_NAME.length + 1);
  if (trimmed.includes("=")) return trimmed.replace(/^cookie:\s*/i, "");
  return trimmed;
}

async function requestJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ status: number; text: string }> {
  const response = await fetchImpl(url, { headers, redirect: "manual" });
  return { status: response.status, text: await response.text() };
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function buildSnapshot(base: SnapshotBase, bundle: CommandCodeBundle, fetchMethod: FetchMethod): ProviderFetchResult {
  const windows = parseCommandCodeWindows(bundle.credits, bundle.summary);
  const totalTokens = Number(bundle.summary?.totalTokens);
  const topModels = parseCommandCodeTopModels(bundle.byModel, totalTokens);
  const metrics: ProviderSnapshot["metrics"] = {
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : null,
    totalRequests: Number.isFinite(Number(bundle.summary?.totalCount)) ? Number(bundle.summary?.totalCount) : null,
    totalCost: Number.isFinite(Number(bundle.summary?.totalCost)) ? Number(bundle.summary?.totalCost) : null,
    periodStart: bundle.summary?.periodStart ?? null,
    monthlyCreditsGranted: Number.isFinite(Number(bundle.credits?.credits?.monthlyCreditsGranted))
      ? Number(bundle.credits?.credits?.monthlyCreditsGranted)
      : null,
    monthlyCreditsRemaining: Number.isFinite(Number(bundle.credits?.credits?.monthlyCredits))
      ? Number(bundle.credits?.credits?.monthlyCredits)
      : null,
    topModels: JSON.stringify(topModels),
  };

  if (windows.length === 0) {
    return createResult({
      ...base,
      status: "partial",
      summary: "已登录 Command Code，但没有解析到额度窗口（接口字段可能变化）",
      windows: [],
      metrics,
      meta: { fetchMethod },
    });
  }

  return createResult({
    ...base,
    status: "ready",
    summary: `Command Code 用量已解析（${topModels.length} 个模型）`,
    windows,
    metrics,
    meta: { fetchMethod },
  });
}

async function fetchBundleDirect(
  config: CommandCodeConfig,
  sessionCookie: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; bundle: CommandCodeBundle } | { ok: false; status: number; summary: string }> {
  const apiBase = getApiBaseUrl(config);
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": browserUserAgent,
    cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
    origin: defaultSiteOrigin,
    referer: getSourceUrl(config),
  };

  const [summaryResult, byModelResult, creditsResult] = await Promise.all([
    requestJson(`${apiBase}/internal/usage/summary`, headers, fetchImpl),
    requestJson(`${apiBase}/internal/usage/by-model`, headers, fetchImpl),
    requestJson(`${apiBase}/internal/billing/credits`, headers, fetchImpl),
  ]);

  const statuses = [summaryResult.status, byModelResult.status, creditsResult.status];
  if (statuses.some((status) => status === 401 || status === 403)) {
    return {
      ok: false,
      status: statuses.find((status) => status === 401 || status === 403) ?? 401,
      summary: "Command Code 登录态无效或已过期，请重新运行 scripts/refresh-commandcode-usage.ts",
    };
  }
  if (statuses.some((status) => status !== 200)) {
    const failed = statuses.find((status) => status !== 200) ?? 500;
    return { ok: false, status: failed, summary: `Command Code 用量接口返回 HTTP ${failed}` };
  }

  return {
    ok: true,
    bundle: {
      summary: parseJson<CommandCodeSummary>(summaryResult.text),
      byModel: parseJson<CommandCodeByModel>(byModelResult.text),
      credits: parseJson<CommandCodeCredits>(creditsResult.text),
    },
  };
}

async function fetchBundleViaEdge(
  edgeProxyUrl: string,
  edgeProxyKey: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; bundle: CommandCodeBundle } | { ok: false; status: number; summary: string }> {
  const response = await requestJson(edgeProxyUrl, { accept: "application/json", "x-proxy-key": edgeProxyKey }, fetchImpl);
  if (response.status !== 200) {
    return { ok: false, status: response.status, summary: `Command Code Edge Function 返回 HTTP ${response.status}` };
  }
  const payload = parseJson<{
    summary?: CommandCodeSummary | null;
    byModel?: CommandCodeByModel | null;
    credits?: CommandCodeCredits | null;
  }>(response.text);
  if (!payload) {
    return { ok: false, status: response.status, summary: "Command Code Edge Function 返回了非 JSON 内容" };
  }
  return {
    ok: true,
    bundle: { summary: payload.summary ?? null, byModel: payload.byModel ?? null, credits: payload.credits ?? null },
  };
}

export async function fetchCommandCodeSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = (input.config ?? {}) as CommandCodeConfig;
  const base: SnapshotBase = {
    providerId: "commandcode",
    providerName: "Command Code",
    sourceUrl: getSourceUrl(config),
    capturedAt: now,
  };

  const sessionCookie = normalizeCookie(config.sessionCookie);
  const edgeProxyUrl = config.edgeProxyUrl?.trim();
  const edgeProxyKey = config.edgeProxyKey?.trim();
  const hasEdgeProxy = Boolean(edgeProxyUrl && edgeProxyKey);

  if (!sessionCookie && !hasEdgeProxy) {
    return createResult({
      ...base,
      status: "login_required",
      summary: "Missing Command Code session cookie",
      windows: [],
      metrics: { hasSessionCookie: false },
      meta: { fetchMethod: "api" },
    });
  }

  // 1) 直连优先（Cloudflare 出口若未被封，延迟最低）
  if (sessionCookie) {
    try {
      const direct = await fetchBundleDirect(config, sessionCookie, fetchImpl);
      if (direct.ok) {
        return buildSnapshot(base, direct.bundle, "api");
      }
      // 登录态失效：不再尝试 Edge（Edge 读的是同一份 cookie，结果相同）
      if (direct.status === 401 || direct.status === 403) {
        return createResult({
          ...base,
          status: "login_required",
          summary: direct.summary,
          windows: [],
          metrics: { httpStatus: direct.status },
          meta: { fetchMethod: "api" },
        });
      }
      if (!hasEdgeProxy) {
        return createResult({
          ...base,
          status: "error",
          summary: direct.summary,
          windows: [],
          metrics: { httpStatus: direct.status },
          meta: { fetchMethod: "api" },
        });
      }
    } catch (error) {
      if (!hasEdgeProxy) {
        const message = error instanceof Error ? error.message : "Command Code 用量接口请求失败";
        return createResult({
          ...base,
          status: "error",
          summary: `Command Code 用量接口请求失败：${message}`,
          windows: [],
          metrics: {},
          meta: { fetchMethod: "api" },
        });
      }
    }
  }

  // 2) 直连失败 → Supabase Edge Function 兜底
  if (hasEdgeProxy) {
    try {
      const edge = await fetchBundleViaEdge(edgeProxyUrl!, edgeProxyKey!, fetchImpl);
      if (edge.ok) {
        return buildSnapshot(base, edge.bundle, "edge_function");
      }
      return createResult({
        ...base,
        status: edge.status === 401 || edge.status === 403 ? "login_required" : "error",
        summary: edge.summary,
        windows: [],
        metrics: { edgeHttpStatus: edge.status },
        meta: { fetchMethod: "edge_function" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command Code Edge Function 请求失败";
      return createResult({
        ...base,
        status: "error",
        summary: `Command Code Edge Function 请求失败：${message}`,
        windows: [],
        metrics: {},
        meta: { fetchMethod: "edge_function" },
      });
    }
  }

  return createResult({
    ...base,
    status: "login_required",
    summary: "Missing Command Code session cookie",
    windows: [],
    metrics: {},
    meta: { fetchMethod: "api" },
  });
}

export const commandCode: ProviderDefinition = {
  id: "commandcode",
  name: "Command Code",
  sourceUrl: "https://commandcode.ai/{account}/settings/usage",
  description: "Command Code 用量：5h/周/月额度 + Top5 模型（api.commandcode.ai）",
  fetchSnapshot: fetchCommandCodeSnapshot,
};
