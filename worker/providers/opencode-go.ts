import { parseHeadersCookie, toIsoString } from "../http";
import type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult, ProviderSnapshot } from "../types";
import { createResult } from "./types";
import { parseOpenCodeGoStatus, type OpenCodeGoStatusPayload } from "./opencode-go-parser";

type OpenCodeGoConfig = {
  workspaceId?: string;
  // 新版控制台的会话 cookie（__Host-console_session），推荐字段
  sessionCookie?: string;
  // 旧字段：历史配置里是 `auth` cookie，新版接口只认 __Host-console_session
  authCookie?: string;
  apiKey?: string;
  baseUrl?: string;
  // Supabase Edge Function 兜底：Cloudflare 出口被 opencode 拒绝（401）时，
  // 改从 Supabase（Deno Deploy / AWS）出口取数。
  edgeProxyUrl?: string;
  edgeProxyKey?: string;
};

// opencode 新版控制台用 __Host- 前缀的 host-only cookie 维持登录态
const SESSION_COOKIE_NAME = "__Host-console_session";

function getOrigin(config: OpenCodeGoConfig): string {
  return config.baseUrl?.replace(/\/$/, "") ?? "https://opencode.ai";
}

function getDashboardUrl(config: OpenCodeGoConfig): string {
  const origin = getOrigin(config);
  if (!config.workspaceId) return `${origin}/console`;
  return `${origin}/console/${encodeURIComponent(config.workspaceId)}/go`;
}

// 归一化 cookie：兼容三种输入——完整 cookie 串、单条 `name=value`、裸值
function normalizeSessionCookie(rawCookie: string | undefined): string | undefined {
  const trimmed = parseHeadersCookie(rawCookie);
  if (!trimmed) return undefined;

  const parts = trimmed
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const sessionPart = parts.find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (sessionPart) return sessionPart;
  if (trimmed.includes("=")) {
    // 旧配置（如 `auth=...`）原样带出：新版接口会返回 401，由调用方提示重新登录
    return trimmed.replace(/^cookie:\s*/i, "");
  }
  return `${SESSION_COOKIE_NAME}=${trimmed}`;
}

type SnapshotBase = Pick<ProviderSnapshot, "providerId" | "providerName" | "sourceUrl" | "capturedAt">;
type FetchMethod = "api" | "edge_function";

async function requestText(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ status: number; text: string }> {
  const response = await fetchImpl(url, { headers, redirect: "manual" });
  return { status: response.status, text: await response.text() };
}

function resultFromPayload(
  base: SnapshotBase,
  payload: OpenCodeGoStatusPayload,
  httpStatus: number,
  fetchMethod: FetchMethod,
): ProviderFetchResult {
  const windows = parseOpenCodeGoStatus(payload);
  if (windows.length === 0) {
    return createResult({
      ...base,
      status: "partial",
      summary: "登录成功，但未找到 Go 订阅用量窗口（可能未订阅或额度接口变更）",
      windows: [],
      metrics: {
        httpStatus,
        product: payload.product ?? null,
        endsAt: payload.access?.endsAt ?? null,
      },
      meta: { fetchMethod },
    });
  }

  return createResult({
    ...base,
    status: "ready",
    summary: "OpenCode Go 用量窗口已解析",
    windows,
    metrics: {
      httpStatus,
      product: payload.product ?? null,
      endsAt: payload.access?.endsAt ?? null,
      hasRolling: windows.some((window) => window.key === "rolling"),
      hasWeekly: windows.some((window) => window.key === "weekly"),
      hasMonthly: windows.some((window) => window.key === "monthly"),
    },
    meta: { fetchMethod },
  });
}

function loginRequired(base: SnapshotBase, summary: string, metrics: Record<string, number | string | boolean | null>): ProviderFetchResult {
  return createResult({
    ...base,
    status: "login_required",
    summary,
    windows: [],
    metrics,
    meta: { fetchMethod: "api" },
  });
}

export async function fetchOpenCodeGoSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = (input.config ?? {}) as OpenCodeGoConfig;
  const base: SnapshotBase = {
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    sourceUrl: getDashboardUrl(config),
    capturedAt: now,
  };

  const edgeProxyUrl = config.edgeProxyUrl?.trim();
  const edgeProxyKey = config.edgeProxyKey?.trim();
  const hasEdgeProxy = Boolean(edgeProxyUrl && edgeProxyKey);

  if (!config.workspaceId && !hasEdgeProxy) {
    return loginRequired(base, "Missing workspaceId", { hasWorkspaceId: false });
  }

  const sessionCookie = normalizeSessionCookie(config.sessionCookie ?? config.authCookie);
  if (!sessionCookie && !config.apiKey && !hasEdgeProxy) {
    return loginRequired(base, "Missing session cookie", {
      hasWorkspaceId: Boolean(config.workspaceId),
      hasSessionCookie: false,
    });
  }

  // 1) 优先走 Supabase Edge Function（Cloudflare 出口被 opencode 拒绝时的唯一可用通道）
  let edgeFailure: { status: number; text: string } | null = null;
  let edgeError: string | null = null;
  if (hasEdgeProxy) {
    try {
      const edge = await requestText(
        edgeProxyUrl!,
        { Accept: "application/json", "x-proxy-key": edgeProxyKey! },
        fetchImpl,
      );
      if (edge.status === 200) {
        try {
          const payload = JSON.parse(edge.text) as OpenCodeGoStatusPayload;
          return resultFromPayload(base, payload, edge.status, "edge_function");
        } catch {
          edgeError = "Edge Function 返回非 JSON";
        }
      } else {
        edgeFailure = edge;
      }
    } catch (error) {
      edgeError = error instanceof Error ? error.message : String(error);
    }
  }

  // 2) 直连 opencode（若本地/云端存有 cookie）；Edge Function 失败时作为兜底
  if (sessionCookie || config.apiKey) {
    const requestHeaders: Record<string, string> = {
      Accept: "application/json",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      // 新版控制台接口必须带 x-org-id，缺失会返回 400 org_required
      "x-org-id": config.workspaceId ?? "",
      // 补齐浏览器上下文：Cloudflare 出口请求若缺这些头，容易被 WAF 判成非浏览器请求
      Origin: getOrigin(config),
      Referer: base.sourceUrl,
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    };
    if (sessionCookie) requestHeaders.Cookie = sessionCookie;
    if (config.apiKey) requestHeaders.Authorization = `Bearer ${config.apiKey}`;

    try {
      const direct = await requestText(`${getOrigin(config)}/console/api/go/status`, requestHeaders, fetchImpl);
      if (direct.status === 200) {
        try {
          const payload = JSON.parse(direct.text) as OpenCodeGoStatusPayload;
          return resultFromPayload(base, payload, direct.status, "api");
        } catch {
          // 落到下方统一错误
        }
      }

      if (direct.status === 401 && !hasEdgeProxy) {
        return loginRequired(base, "OpenCode session 无效或已过期，请重新登录 opencode 控制台", {
          httpStatus: direct.status,
        });
      }
      if (direct.status === 403 && !hasEdgeProxy) {
        return loginRequired(base, "该 session 无权访问此 workspace（可能登录了其它账号）", {
          httpStatus: direct.status,
        });
      }

      if (hasEdgeProxy) {
        return createResult({
          ...base,
          status: "error",
          summary: `云端直连 HTTP ${direct.status}，Edge Function 兜底也失败（${edgeFailure ? `HTTP ${edgeFailure.status}` : edgeError ?? "未知错误"}）`,
          windows: [],
          metrics: {
            httpStatus: direct.status,
            edgeHttpStatus: edgeFailure?.status ?? null,
          },
          meta: { fetchMethod: "api", edgeProxyFailed: true },
        });
      }

      if (!direct.status || direct.status >= 500) {
        return createResult({
          ...base,
          status: "error",
          summary: `OpenCode Go 用量接口返回 HTTP ${direct.status}`,
          windows: [],
          metrics: { httpStatus: direct.status },
          meta: { fetchMethod: "api" },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "OpenCode Go 用量接口请求失败";
      if (!hasEdgeProxy) {
        return createResult({
          ...base,
          status: "error",
          summary: `OpenCode Go 用量接口请求失败：${message}`,
          windows: [],
          metrics: {},
          meta: { fetchMethod: "api" },
        });
      }
    }
  }

  // 3) 只有 Edge Function 通道，且失败
  return createResult({
    ...base,
    status: edgeFailure ? "login_required" : "error",
    summary: edgeFailure
      ? `Edge Function 返回 HTTP ${edgeFailure.status}（session 可能已过期）`
      : `Edge Function 调用失败：${edgeError ?? "未知错误"}`,
    windows: [],
    metrics: { edgeHttpStatus: edgeFailure?.status ?? null },
    meta: { fetchMethod: "edge_function" },
  });
}

export const opencodeGo: ProviderDefinition = {
  id: "opencode-go",
  name: "OpenCode Go",
  sourceUrl: "https://opencode.ai/console/{workspaceId}/go",
  description: "OpenCode Go 控制台用量快照（/console/api/go/status，Supabase Edge Function 兜底）",
  fetchSnapshot: fetchOpenCodeGoSnapshot,
};
