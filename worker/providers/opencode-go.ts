import { parseHeadersCookie, toIsoString } from "../http";
import type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult } from "../types";
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

export async function fetchOpenCodeGoSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = (input.config ?? {}) as OpenCodeGoConfig;
  const sourceUrl = getDashboardUrl(config);
  const base = {
    providerId: "opencode-go" as const,
    providerName: "OpenCode Go",
    sourceUrl,
    capturedAt: now,
  };

  if (!config.workspaceId) {
    return createResult({
      ...base,
      status: "login_required",
      summary: "Missing workspaceId",
      windows: [],
      metrics: { hasWorkspaceId: false },
      meta: { fetchMethod: "api" },
    });
  }

  const sessionCookie = normalizeSessionCookie(config.sessionCookie ?? config.authCookie);
  if (!sessionCookie && !config.apiKey) {
    return createResult({
      ...base,
      status: "login_required",
      summary: "Missing session cookie",
      windows: [],
      metrics: { hasWorkspaceId: true, hasSessionCookie: false },
      meta: { fetchMethod: "api" },
    });
  }

  const requestHeaders: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApiMonitor/0.1",
    // 新版控制台接口必须带 x-org-id，缺失会返回 400 org_required
    "x-org-id": config.workspaceId,
  };
  if (sessionCookie) {
    requestHeaders.Cookie = sessionCookie;
  }
  if (config.apiKey) {
    requestHeaders.Authorization = `Bearer ${config.apiKey}`;
  }

  const apiUrl = `${getOrigin(config)}/console/api/go/status`;
  try {
    const response = await fetchImpl(apiUrl, { headers: requestHeaders, redirect: "manual" });
    const bodyText = await response.text();

    if (response.status === 401) {
      return createResult({
        ...base,
        status: "login_required",
        summary: "OpenCode session 无效或已过期，请重新登录 opencode 控制台",
        windows: [],
        metrics: { httpStatus: response.status },
        meta: { fetchMethod: "api" },
      });
    }

    if (response.status === 403) {
      return createResult({
        ...base,
        status: "login_required",
        summary: "该 session 无权访问此 workspace（可能登录了其它账号）",
        windows: [],
        metrics: { httpStatus: response.status },
        meta: { fetchMethod: "api" },
      });
    }

    if (!response.ok) {
      return createResult({
        ...base,
        status: "error",
        summary: `OpenCode Go 用量接口返回 HTTP ${response.status}`,
        windows: [],
        metrics: { httpStatus: response.status },
        meta: { fetchMethod: "api" },
      });
    }

    let payload: OpenCodeGoStatusPayload;
    try {
      payload = JSON.parse(bodyText) as OpenCodeGoStatusPayload;
    } catch {
      return createResult({
        ...base,
        status: "error",
        summary: "OpenCode Go 用量接口返回了非 JSON 内容",
        windows: [],
        metrics: { httpStatus: response.status },
        meta: { fetchMethod: "api" },
      });
    }

    const windows = parseOpenCodeGoStatus(payload);
    if (windows.length === 0) {
      return createResult({
        ...base,
        status: "partial",
        summary: "登录成功，但未找到 Go 订阅用量窗口（可能未订阅或额度接口变更）",
        windows: [],
        metrics: {
          httpStatus: response.status,
          product: payload.product ?? null,
          endsAt: payload.access?.endsAt ?? null,
        },
        meta: { fetchMethod: "api" },
      });
    }

    return createResult({
      ...base,
      status: "ready",
      summary: "OpenCode Go 用量窗口已解析",
      windows,
      metrics: {
        httpStatus: response.status,
        product: payload.product ?? null,
        endsAt: payload.access?.endsAt ?? null,
        hasRolling: windows.some((window) => window.key === "rolling"),
        hasWeekly: windows.some((window) => window.key === "weekly"),
        hasMonthly: windows.some((window) => window.key === "monthly"),
      },
      meta: { fetchMethod: "api" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenCode Go 用量接口请求失败";
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

export const opencodeGo: ProviderDefinition = {
  id: "opencode-go",
  name: "OpenCode Go",
  sourceUrl: "https://opencode.ai/console/{workspaceId}/go",
  description: "OpenCode Go 控制台用量快照（/console/api/go/status）",
  fetchSnapshot: fetchOpenCodeGoSnapshot,
};
