export type PlatformStatus = "healthy" | "warning" | "partial" | "login_required";

export type LinkTone = "neutral" | "brand" | "warning";

export interface ApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  headers?: HeadersInit;
}

export interface ApiError extends Error {
  code: "network_error" | "http_error" | "invalid_response";
  status?: number;
  details?: unknown;
}

export interface RawLinkItem {
  label: string;
  href: string;
  tone?: LinkTone;
}

export interface QuotaWindow {
  label: string;
  scope: string;
  used: number;
  limit: number;
  resetAt: string;
  status: PlatformStatus;
}

export interface TrendPoint {
  label: string;
  usage: number;
  spendUsd: number;
}

export interface ModelSpendRow {
  model: string;
  requests: number;
  tokens: number;
  spendUsd: number;
  share: number;
}

export interface PlatformSnapshot {
  id: "xfyun" | "opencode" | "openrouter" | string;
  name: string;
  tagline: string;
  summary: string;
  status: PlatformStatus;
  loginState: string;
  sourceUrl: string;
  sourceLabel: string;
  primaryMetricLabel: string;
  primaryMetricValue: string;
  lastRefreshedAt: string;
  accent: string;
  quotaWindows: QuotaWindow[];
  trend: TrendPoint[];
  modelSpends: ModelSpendRow[];
  links: RawLinkItem[];
  selectedAccountId: string | null;
  accounts: PlatformAccountSnapshot[];
}

export interface PlatformAccountSnapshot {
  id: string;
  label: string;
  summary: string;
  status: PlatformStatus;
  loginState: string;
  sourceUrl: string;
  sourceLabel: string;
  primaryMetricValue: string;
  lastRefreshedAt: string;
  quotaWindows: QuotaWindow[];
  trend: TrendPoint[];
  links: RawLinkItem[];
}

export interface DashboardSnapshot {
  status: "ready" | "partial";
  generatedAt: string;
  refreshedAt: string;
  platforms: PlatformSnapshot[];
}

export interface LiveLoginSession {
  provider: string;
  loginUrl: string;
  liveViewUrl: string;
  expiresAt: string;
  status: "manual_open" | "browser_run_pending";
  message: string;
}

export interface ProviderCatalogItem {
  providerKey: string;
  providerName: string;
  sourceUrl: string;
  description: string;
}

export interface ProviderPreference {
  providerKey: string;
  enabled: boolean;
  displayOrder: number;
  activeProviderAccountId: string | null;
}

export interface SafeProviderAccount {
  id: string;
  providerKey: string;
  accountLabel: string;
  sourceUrl: string;
  status: string;
  statusMessage: string | null;
  credentialHint: Record<string, unknown>;
  homepageEnabled: boolean;
  homepageOrder: number;
  lastTestSummary: string | null;
}

export interface ProviderSettingsPayload {
  catalog: ProviderCatalogItem[];
  preferences: ProviderPreference[];
  accounts: SafeProviderAccount[];
}

export interface ProviderAccountInput {
  providerKey: string;
  accountLabel: string;
  sourceUrl: string;
  credentials?: Record<string, string>;
}

type ApiEnvelope<T> =
  | {
      ok: true;
      data: T;
      message?: string;
    }
  | {
      ok: false;
      error: {
        code?: string;
        message?: string;
        details?: unknown;
      };
    };

type ServerProviderStatus = "ready" | "partial" | "login_required" | "disabled" | "error";

type ServerProviderWindow = {
  key: string;
  label: string;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  percentUsed?: number | null;
  percentRemaining?: number | null;
  resetAt?: string | null;
};

type ServerUsageCard = {
  providerId: string;
  providerName: string;
  sourceUrl: string;
  status: ServerProviderStatus;
  summary: string;
  capturedAt: string;
  trend: ServerProviderWindow[];
  windows: ServerProviderWindow[];
  metrics: Record<string, number | string | boolean | null>;
  meta: Record<string, unknown>;
  selectedAccountId?: string;
  accounts?: ServerUsageAccountCard[];
};

type ServerUsageAccountCard = {
  accountId: string;
  accountLabel: string;
  sourceUrl: string;
  status: ServerProviderStatus;
  summary: string;
  capturedAt: string;
  trend: ServerProviderWindow[];
  windows: ServerProviderWindow[];
  metrics: Record<string, number | string | boolean | null>;
  meta: Record<string, unknown>;
};

type ServerUsageDashboard = {
  kind: "usage_dashboard";
  generatedAt: string;
  status: ServerProviderStatus;
  summary: string;
  cards: ServerUsageCard[];
  modelSpends: Array<Record<string, unknown>>;
  totals: {
    providers: number;
    ready: number;
    partial: number;
    loginRequired: number;
    error: number;
  };
  refresh?: {
    scope: "all" | "single";
    providerId?: string;
    sessionKey?: string;
    refreshed: boolean;
    reason?: string;
    nextAllowedAt?: string | null;
  };
};

const DEFAULT_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

function buildUrl(baseUrl: string | undefined, path: string): string {
  if (!baseUrl) {
    return path;
  }

  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function createApiError(
  message: string,
  code: ApiError["code"],
  extra?: Partial<ApiError>,
): ApiError {
  const error = new Error(message) as ApiError;
  error.code = code;
  error.status = extra?.status;
  error.details = extra?.details;
  return error;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();

  if (!text) {
    return undefined as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw createApiError("响应不是合法 JSON。", "invalid_response", {
      details: text.slice(0, 300),
    });
  }
}

function unwrapEnvelope<T>(payload: T | ApiEnvelope<T>): T {
  if (payload && typeof payload === "object" && "ok" in payload) {
    if ((payload as ApiEnvelope<T>).ok) {
      return (payload as Extract<ApiEnvelope<T>, { ok: true }>).data;
    }

    const envelope = payload as Extract<ApiEnvelope<T>, { ok: false }>;
    throw createApiError(envelope.error.message ?? "请求失败。", "http_error", {
      details: envelope.error.details,
    });
  }

  return payload as T;
}

async function requestJson<T>(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<T> {
  let response: Response;

  try {
    response = await fetcher(url, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : "网络请求失败。";
    throw createApiError(message, "network_error", { details: error });
  }

  if (!response.ok) {
    const payload = await parseJsonResponse<Partial<ApiEnvelope<T>>>(response).catch(
      () => undefined,
    );
    throw createApiError(
      payload && typeof payload === "object" && "error" in payload
        ? payload.error?.message ?? `请求失败 (${response.status})`
        : `请求失败 (${response.status})`,
      "http_error",
      {
        status: response.status,
        details: payload,
      },
    );
  }

  return parseJsonResponse<T>(response);
}

function mapStatus(status: ServerProviderStatus): PlatformStatus {
  if (status === "ready") return "healthy";
  if (status === "login_required") return "warning";
  if (status === "error" || status === "disabled") return "warning";
  return "partial";
}

function resolveAccent(providerId: string): string {
  if (providerId === "xfyun-maas") return "#2563eb";
  if (providerId === "opencode-go") return "#0f766e";
  if (providerId === "aliyun-bailian") return "#7c3aed";
  return "#b45309";
}

function resolveTagline(providerId: string): string {
  if (providerId === "xfyun-maas") return "原网页入口 / 登录状态";
  if (providerId === "opencode-go") return "workspaceId + auth cookie";
  if (providerId === "aliyun-bailian") return "Coding Plan / 百炼控制台";
  return "Activity 聚合 / 花费拆分";
}

function resolvePrimaryMetricLabel(providerId: string, windows: ServerProviderWindow[]): string {
  if (providerId === "xfyun-maas") return "当前套餐";
  if (providerId === "opencode-go") return "活跃窗口";
  if (providerId === "openrouter") return "本周期花费";
  if (providerId === "aliyun-bailian") return "当前套餐";
  return windows[0]?.label ?? "当前状态";
}

function formatWindowValue(window: ServerProviderWindow): string {
  if (typeof window.used === "number" && typeof window.limit === "number" && window.limit > 0) {
    return `${new Intl.NumberFormat("zh-CN").format(window.used)} / ${new Intl.NumberFormat("zh-CN").format(window.limit)}`;
  }

  if (typeof window.used === "number") {
    return new Intl.NumberFormat("zh-CN").format(window.used);
  }

  return "待同步";
}

function formatResetAt(value: string | null | undefined): string {
  if (!value) return "待同步";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function toQuotaWindow(status: PlatformStatus, window: ServerProviderWindow): QuotaWindow {
  return {
    label: window.label,
    scope: window.label,
    used: window.used ?? 0,
    limit: window.limit ?? 0,
    resetAt: formatResetAt(window.resetAt),
    status,
  };
}

function toTrendPoint(window: ServerProviderWindow): TrendPoint {
  return {
    label: window.label,
    usage: window.used ?? 0,
    spendUsd: 0,
  };
}

function toTrendPointFromQuotaWindow(window: QuotaWindow): TrendPoint {
  return {
    label: window.label,
    usage: window.used,
    spendUsd: 0,
  };
}

function toSourceLabel(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    return url.pathname.replace(/^\//, "") || url.hostname;
  } catch {
    return sourceUrl;
  }
}

function toLinks(_providerId: string, sourceUrl: string): RawLinkItem[] {
  return [{ label: "打开看板", href: sourceUrl, tone: "brand" }];
}

function mapServerDashboard(server: ServerUsageDashboard): DashboardSnapshot {
  const platforms = server.cards.map((card) => {
    const status = mapStatus(card.status);
    const sourceLabel = toSourceLabel(card.sourceUrl);
    const windows = card.windows.map((window) => toQuotaWindow(status, window));
    const trend =
      card.trend.length > 0
        ? card.trend.map(toTrendPoint)
        : windows.map(toTrendPointFromQuotaWindow);
    const primaryWindow = card.windows[0];

    const accounts = (card.accounts ?? []).map((account) => {
      const accountStatus = mapStatus(account.status);
      const accountWindows = account.windows.map((window) => toQuotaWindow(accountStatus, window));
      return {
        id: account.accountId,
        label: account.accountLabel,
        summary: account.summary,
        status: accountStatus,
        loginState:
          account.status === "login_required"
            ? "需要登录"
            : account.status === "error"
              ? "抓取失败"
              : account.status === "partial"
                ? "部分可用"
                : "已连接",
        sourceUrl: account.sourceUrl,
        sourceLabel: toSourceLabel(account.sourceUrl),
        primaryMetricValue: account.windows[0]
          ? formatWindowValue(account.windows[0])
          : account.summary,
        lastRefreshedAt: account.capturedAt,
        quotaWindows: accountWindows,
        trend:
          account.trend.length > 0
            ? account.trend.map(toTrendPoint)
            : accountWindows.map(toTrendPointFromQuotaWindow),
        links: toLinks(card.providerId, account.sourceUrl),
      };
    });

    return {
      id: card.providerId,
      name: card.providerName,
      tagline: resolveTagline(card.providerId),
      summary: card.summary,
      status,
      loginState:
        card.status === "login_required"
          ? "需要登录"
          : card.status === "error"
            ? "抓取失败"
            : card.status === "partial"
              ? "部分可用"
              : "已连接",
      sourceUrl: card.sourceUrl,
      sourceLabel,
      primaryMetricLabel: resolvePrimaryMetricLabel(card.providerId, card.windows),
      primaryMetricValue: primaryWindow ? formatWindowValue(primaryWindow) : card.summary,
      lastRefreshedAt: card.capturedAt,
      accent: resolveAccent(card.providerId),
      quotaWindows: windows,
      trend,
      modelSpends: [],
      links: toLinks(card.providerId, card.sourceUrl),
      selectedAccountId: card.selectedAccountId ?? accounts[0]?.id ?? null,
      accounts,
    };
  });

  const refreshedAt =
    platforms.length > 0
      ? platforms.reduce((latest, platform) => {
          return latest > platform.lastRefreshedAt ? latest : platform.lastRefreshedAt;
        }, platforms[0]!.lastRefreshedAt)
      : server.generatedAt;

  return {
    status: server.status === "ready" ? "ready" : "partial",
    generatedAt: server.generatedAt,
    refreshedAt,
    platforms,
  };
}

export function createApiClient(options: ApiClientOptions = {}) {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const headers = {
    ...DEFAULT_HEADERS,
    ...options.headers,
  };

  return {
    async getUsageDashboard(): Promise<DashboardSnapshot> {
      const payload = await requestJson<ServerUsageDashboard | ApiEnvelope<ServerUsageDashboard>>(
        fetcher,
        buildUrl(options.baseUrl, "/api/usage"),
        {
          method: "GET",
          credentials: "include",
          headers,
        },
      );

      return mapServerDashboard(unwrapEnvelope(payload));
    },

    async refreshUsage(): Promise<DashboardSnapshot> {
      const payload = await requestJson<ServerUsageDashboard | ApiEnvelope<ServerUsageDashboard>>(
        fetcher,
        buildUrl(options.baseUrl, "/api/refresh"),
        {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({}),
        },
      );

      return mapServerDashboard(unwrapEnvelope(payload));
    },

    async getSessionState(): Promise<Record<string, unknown>> {
      const payload = await requestJson<Record<string, unknown> | ApiEnvelope<Record<string, unknown>>>(
        fetcher,
        buildUrl(options.baseUrl, "/api/session/status"),
        {
          method: "GET",
          credentials: "include",
          headers,
        },
      );

      return unwrapEnvelope(payload);
    },

    async createLiveLoginSession(input: {
      provider: string;
      loginUrl: string;
    }): Promise<LiveLoginSession> {
      const payload = await requestJson<LiveLoginSession | ApiEnvelope<LiveLoginSession>>(
        fetcher,
        buildUrl(options.baseUrl, "/api/session/live-login"),
        {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify(input),
        },
      );

      return unwrapEnvelope(payload);
    },

    async getProviderSettings(adminToken: string): Promise<ProviderSettingsPayload> {
      const payload = await requestJson<ProviderSettingsPayload | ApiEnvelope<ProviderSettingsPayload>>(
        fetcher,
        buildUrl(options.baseUrl, "/api/settings/providers"),
        {
          method: "GET",
          credentials: "include",
          headers: {
            ...headers,
            "x-api-monitor-admin-token": adminToken,
          },
        },
      );

      return unwrapEnvelope(payload);
    },

    async saveProviderPreferences(
      adminToken: string,
      preferences: ProviderPreference[],
    ): Promise<ProviderPreference[]> {
      const payload = await requestJson<ProviderPreference[] | ApiEnvelope<ProviderPreference[]>>(
        fetcher,
        buildUrl(options.baseUrl, "/api/settings/providers"),
        {
          method: "PUT",
          credentials: "include",
          headers: {
            ...headers,
            "x-api-monitor-admin-token": adminToken,
          },
          body: JSON.stringify({ providers: preferences }),
        },
      );

      return unwrapEnvelope(payload);
    },

    async saveProviderAccount(
      adminToken: string,
      account: ProviderAccountInput,
    ): Promise<{ id: string }> {
      const payload = await requestJson<{ id: string } | ApiEnvelope<{ id: string }>>(
        fetcher,
        buildUrl(options.baseUrl, "/api/settings/accounts"),
        {
          method: "POST",
          credentials: "include",
          headers: {
            ...headers,
            "x-api-monitor-admin-token": adminToken,
          },
          body: JSON.stringify(account),
        },
      );

      return unwrapEnvelope(payload);
    },

    async testProviderAccount(
      adminToken: string,
      accountId: string,
    ): Promise<{ ok: boolean; status: string; summary: string }> {
      const payload = await requestJson<
        { ok: boolean; status: string; summary: string } | ApiEnvelope<{ ok: boolean; status: string; summary: string }>
      >(
        fetcher,
        buildUrl(options.baseUrl, `/api/settings/accounts/${encodeURIComponent(accountId)}/test`),
        {
          method: "POST",
          credentials: "include",
          headers: {
            ...headers,
            "x-api-monitor-admin-token": adminToken,
          },
        },
      );

      return unwrapEnvelope(payload);
    },

    async updateProviderAccountDisplay(
      adminToken: string,
      accountId: string,
      input: { homepageEnabled: boolean; homepageOrder: number },
    ): Promise<{ id: string; homepageEnabled: boolean; homepageOrder: number }> {
      const payload = await requestJson<
        | { id: string; homepageEnabled: boolean; homepageOrder: number }
        | ApiEnvelope<{ id: string; homepageEnabled: boolean; homepageOrder: number }>
      >(
        fetcher,
        buildUrl(options.baseUrl, `/api/settings/accounts/${encodeURIComponent(accountId)}/display`),
        {
          method: "PATCH",
          credentials: "include",
          headers: {
            ...headers,
            "x-api-monitor-admin-token": adminToken,
          },
          body: JSON.stringify(input),
        },
      );

      return unwrapEnvelope(payload);
    },
  };
}
