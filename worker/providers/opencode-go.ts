import { parseHeadersCookie, toIsoString } from "../http";
import type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult, ProviderSnapshot } from "../types";
import { createResult } from "./types";
import {
  parseOpenCodeGoActivity,
  parseOpenCodeGoStatus,
  resolveOpenCodeGoActivity,
  toOpenCodeGoActivityMetrics,
  type OpenCodeGoActivityPayload,
  type OpenCodeGoStatusPayload,
} from "./opencode-go-parser";

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

// Activity 页面与 Go 页面同层：/console/<workspaceId>/activity（不是 /go/activity）
function getActivityPageUrl(config: OpenCodeGoConfig): string {
  const origin = getOrigin(config);
  if (!config.workspaceId) return `${origin}/console/activity`;
  return `${origin}/console/${encodeURIComponent(config.workspaceId)}/activity`;
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
  timeoutMs?: number,
): Promise<{ status: number; text: string }> {
  // 始终禁止跟随重定向：带 cookie/Bearer 的请求不能被带到其它域名
  const init: RequestInit = { headers, redirect: "manual" };
  if (timeoutMs && timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, init);
  return { status: response.status, text: await response.text() };
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// 组装最终快照：额度窗口来自 status，Activity 先做周期对账再并入 metrics。
// Activity 的任何失败都只降级为 warning，绝不影响额度展示与 ready 状态。
function resultFromPayload(
  base: SnapshotBase,
  payload: OpenCodeGoStatusPayload,
  httpStatus: number,
  fetchMethod: FetchMethod,
  activityPayload: OpenCodeGoActivityPayload | null = null,
): ProviderFetchResult {
  const windows = parseOpenCodeGoStatus(payload);
  const parsedActivity = parseOpenCodeGoActivity(activityPayload);
  const resolution = resolveOpenCodeGoActivity(payload, parsedActivity);
  const activityMetrics = toOpenCodeGoActivityMetrics(resolution.activity);
  const warnings: string[] = [];
  if (resolution.warning) warnings.push(resolution.warning);

  const baseMetrics: ProviderSnapshot["metrics"] = {
    httpStatus,
    product: payload.product ?? null,
    endsAt: payload.access?.endsAt ?? null,
    ...activityMetrics,
  };

  if (windows.length === 0) {
    return createResult(
      {
        ...base,
        status: "partial",
        summary: "登录成功，但未找到 Go 订阅用量窗口（可能未订阅或额度接口变更）",
        windows: [],
        metrics: baseMetrics,
        meta: { fetchMethod },
      },
      warnings,
    );
  }

  return createResult(
    {
      ...base,
      status: "ready",
      summary:
        resolution.activity === null
          ? "OpenCode Go 用量窗口已解析"
          : "OpenCode Go 用量窗口与本期 Activity 已解析",
      windows,
      metrics: {
        ...baseMetrics,
        hasRolling: windows.some((window) => window.key === "rolling"),
        hasWeekly: windows.some((window) => window.key === "weekly"),
        hasMonthly: windows.some((window) => window.key === "monthly"),
      },
      meta: { fetchMethod },
    },
    warnings,
  );
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

// Edge 响应可能是新版 wrapper（{ status, activity }）或旧版裸 status JSON。
// 只把「status 字段本身是含 access/product 的对象」视为 wrapper，避免上游 status
// 载荷里恰好带 status 字段时被误判；其余带 access/product 的顶层对象按旧版裸 status 处理。
function unwrapEdgePayload(payload: unknown): { status: OpenCodeGoStatusPayload; activity: OpenCodeGoActivityPayload | null } | null {
  if (!isRecord(payload)) return null;
  const wrapperStatus = payload.status;
  if (isRecord(wrapperStatus) && ("access" in wrapperStatus || "product" in wrapperStatus)) {
    const activity = isRecord(payload.activity) ? (payload.activity as OpenCodeGoActivityPayload) : null;
    return { status: wrapperStatus as OpenCodeGoStatusPayload, activity };
  }
  if ("access" in payload || "product" in payload) {
    return { status: payload as OpenCodeGoStatusPayload, activity: null };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  // 1) 优先走 Supabase Edge Function（Cloudflare 出口被 opencode 拒绝时的唯一可用通道）。
  // x-opencode-activity: 1 让新版 Edge 一并返回 { status, activity }；旧 Edge 忽略该头，仍返回裸 status。
  let edgeFailure: { status: number; text: string } | null = null;
  let edgeError: string | null = null;
  if (hasEdgeProxy) {
    try {
      const edge = await requestText(
        edgeProxyUrl!,
        { Accept: "application/json", "x-proxy-key": edgeProxyKey!, "x-opencode-activity": "1" },
        fetchImpl,
      );
      if (edge.status === 200) {
        const edgePayload = parseJson<unknown>(edge.text);
        if (edgePayload !== null) {
          const bundle = unwrapEdgePayload(edgePayload);
          if (bundle) {
            return resultFromPayload(
              base,
              bundle.status,
              edge.status,
              "edge_function",
              bundle.activity,
            );
          }
          edgeError = "Edge Function 返回结构无法识别";
        } else {
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
        const payload = parseJson<OpenCodeGoStatusPayload>(direct.text);
        if (payload !== null) {
          // Activity 是可选增强：同 headers、同 origin，失败只降级为警告，不影响额度。
          // 独立 8s 预算，避免拖长 status 之外的总耗时；Referer 指向实际 Activity 页面。
          let activity: OpenCodeGoActivityPayload | null = null;
          try {
            const activityHeaders = { ...requestHeaders, Referer: getActivityPageUrl(config) };
            const activityResponse = await requestText(
              `${getOrigin(config)}/console/api/activity/go`,
              activityHeaders,
              fetchImpl,
              8_000,
            );
            if (activityResponse.status === 200) {
              activity = parseJson<OpenCodeGoActivityPayload>(activityResponse.text);
            }
          } catch {
            activity = null;
          }
          return resultFromPayload(base, payload, direct.status, "api", activity);
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
