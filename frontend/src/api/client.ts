export type PlatformStatus = "healthy" | "warning" | "partial" | "login_required";

export type LinkTone = "neutral" | "brand" | "warning";

// 与 Worker 共用 shared/openai-api.ts 的契约常量与类型，避免两端口径漂移。
// 前端对外仍以以下名称重导出，映射层另做防御式运行时校验，
// 保证缺失或非法 meta.openaiApi 时落到安全空态而不是崩溃。
import {
  OPENAI_API_BUDGET_USD,
  OPENAI_API_PROVIDER_ID,
  OPENAI_API_SOURCE_URL,
  type OpenAiApiData as OpenAiApiCardData,
  type OpenAiApiErrorCode as OpenAiErrorCode,
  type OpenAiApiPeriod,
  type OpenAiApiResourceStatus as OpenAiResourceStatus,
  type OpenAiApiSection,
  type OpenAiApiTopModel,
  type OpenAiApiUsageValue,
} from "../../../shared/openai-api";

export {
  OPENAI_API_BUDGET_USD,
  OPENAI_API_PROVIDER_ID,
  OPENAI_API_PROVIDER_NAME,
  OPENAI_API_SOURCE_URL,
} from "../../../shared/openai-api";
export type {
  OpenAiApiData as OpenAiApiCardData,
  OpenAiApiErrorCode as OpenAiErrorCode,
  OpenAiApiPeriod,
  OpenAiApiResourceStatus as OpenAiResourceStatus,
  OpenAiApiSection,
  OpenAiApiTopModel,
  OpenAiApiUsageValue,
} from "../../../shared/openai-api";

// 卡片具体两区类型的语义别名（openai-api-sections 直接消费）
export type OpenAiApiCosts = OpenAiApiSection<number>;
export type OpenAiApiUsage = OpenAiApiSection<OpenAiApiUsageValue>;

export interface ApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  headers?: HeadersInit;
  authTokenProvider?: () => Promise<string | null>;
}

export interface AuthConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
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
  percentUsed?: number | null;
  resetAt: string;
  status: PlatformStatus;
  // 额度桶归属（ChatGPT：codex 编码额度 / web 网页对话额度，两桶独立计量）
  bucket?: string | null;
  // 无数据桶的占位说明：渲染为灰色说明行，不画进度条
  note?: string;
}

export type DetailMetric = {
  label: string;
  value: string;
};

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
  detailMetrics: DetailMetric[];
  trend: TrendPoint[];
  modelSpends: ModelSpendRow[];
  links: RawLinkItem[];
  selectedAccountId: string | null;
  accounts: PlatformAccountSnapshot[];
  // OpenAI 组织卡专属结构化数据；其余供应商卡片不携带此字段
  openaiApi?: OpenAiApiCardData;
}

export interface PlatformAccountSnapshot {
  id: string;
  label: string;
  summary: string;
  status: PlatformStatus;
  loginState: string;
  liveStatus?: string;
  sourceUrl: string;
  sourceLabel: string;
  primaryMetricValue: string;
  lastRefreshedAt: string;
  quotaWindows: QuotaWindow[];
  trend: TrendPoint[];
  links: RawLinkItem[];
  // 账户级汇总与模型数据：必须来自该账户自己的 metrics，不能回填平台首账号
  detailMetrics?: DetailMetric[];
  modelSpends?: ModelSpendRow[];
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
  id?: string;
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
  meta?: Record<string, unknown>;
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

function resolveLoginState(status: ServerProviderStatus, meta?: Record<string, unknown>): string {
  if (meta?.isFallback === true) {
    // 本机推送是 ChatGPT 的既定数据通道（云端出口被 403 封锁）：按正常同步措辞，而非「使用缓存数据」
    return meta.fetchMethod === "local_ingest" ? "本机推送同步" : "使用缓存数据";
  }
  if (meta?.fetchMethod === "browser_rendered") return "云端浏览器同步";
  if (status === "login_required") return "需要登录";
  if (status === "error") return "抓取失败";
  if (status === "partial") return "部分可用";
  return "已连接";
}

function mapStatus(status: ServerProviderStatus, meta?: Record<string, unknown>): PlatformStatus {
  if (meta?.isFallback === true) {
    // 本机推送的 ready 快照：数据来自既定通道且是最近一次成功抓取，不挂常驻警告徽标
    if (meta.fetchMethod === "local_ingest" && status === "ready") return "healthy";
    const liveStatus = typeof meta.liveStatus === "string" ? (meta.liveStatus as ServerProviderStatus) : null;
    if (liveStatus === "login_required" || liveStatus === "error" || liveStatus === "disabled") {
      return "warning";
    }
    if (liveStatus === "partial") {
      return "partial";
    }
    return "warning";
  }
  if (status === "ready") return "healthy";
  if (status === "login_required") return "warning";
  if (status === "error" || status === "disabled") return "warning";
  return "partial";
}

function resolveAccent(providerId: string): string {
  if (providerId === "xfyun-maas") return "#2563eb";
  if (providerId === "opencode-go") return "#0f766e";
  if (providerId === "commandcode") return "#ea580c";
  if (providerId === "aliyun-bailian") return "#7c3aed";
  if (providerId === "volc-ark") return "#dc2626";
  if (providerId === "deepseek") return "#0369a1";
  if (providerId === "zhipu") return "#0ea5e9";
  if (providerId === "ollama") return "#7c3aed";
  if (providerId === "chatgpt") return "#10a37f";
  return "#b45309";
}

function resolveTagline(providerId: string): string {
  if (providerId === OPENAI_API_PROVIDER_ID) return "组织费用与文本模型用量";
  if (providerId === "xfyun-maas") return "原网页入口 / 登录状态";
  if (providerId === "opencode-go") return "workspaceId + auth cookie";
  if (providerId === "commandcode") return "5h / 周 / 月额度 + 模型用量";
  if (providerId === "aliyun-bailian") return "Coding Plan / 百炼控制台";
  if (providerId === "volc-ark") return "Coding Plan 用量 / 5小时周月";
  if (providerId === "deepseek") return "API 余额 / 近30天用量";
  if (providerId === "zhipu") return "Coding Plan 用量 / 5小时周配额";
  if (providerId === "ollama") return "Ollama Pro 用量 / 5小时周额度";
  if (providerId === "chatgpt") return "Codex / 对话额度 / 订阅状态";
  return "Activity 聚合 / 花费拆分";
}

function resolvePrimaryMetricLabel(providerId: string, windows: ServerProviderWindow[]): string {
  if (providerId === "xfyun-maas") return "当前套餐";
  if (providerId === "opencode-go") return "活跃窗口";
  if (providerId === "commandcode") return "5小时额度";
  if (providerId === "openrouter") return "本周期花费";
  if (providerId === "aliyun-bailian") return "当前套餐";
  if (providerId === "deepseek") return "充值余额";
  if (providerId === "zhipu") return "5小时配额";
  if (providerId === "ollama") return "5小时额度";
  if (providerId === "chatgpt") return windows[0]?.label ?? "Codex 编码额度";
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

// Ollama/ChatGPT 无重置时间字段，显示"滚动窗口"；其他 provider 走既有逻辑
function formatOllamaResetAt(providerId: string, value: string | null | undefined): string {
  if (providerId !== "ollama" && providerId !== "chatgpt") return formatResetAt(value);
  return value ? formatResetAt(value) : "滚动窗口";
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

// 续费日期 null（免费档/未知档位）显示"订阅前无数据"（spec §7.2）
function formatChatgptPlanRenewAt(value: unknown): string {
  if (typeof value !== "string" || !value) return "订阅前无数据";
  return formatResetAt(value);
}

// 额度桶标题：ChatGPT 两个桶独立计量（spec §2），窗口上带 meta.bucket 时用它做 scope 标注
function bucketTitle(bucket: string | null): string | null {
  if (bucket === "codex") return "Codex 编码额度";
  if (bucket === "web") return "网页对话额度";
  return null;
}

function toQuotaWindow(providerId: string, status: PlatformStatus, window: ServerProviderWindow): QuotaWindow {
  // worker 桶级补齐的历史窗口打 stale 标记，label 加后缀提示
  const stale = window.meta?.stale === true;
  // 桶归属优先取 worker 写入的 meta.bucket；旧快照无该字段时按既定 key 前缀兜底
  // （codex_5h / codex_weekly / web_5h_<slug>，见 spec §2 映射表）
  const bucket =
    typeof window.meta?.bucket === "string"
      ? window.meta.bucket
      : window.key.startsWith("codex_")
        ? "codex"
        : window.key.startsWith("web_")
          ? "web"
          : null;
  const title = bucketTitle(bucket);
  return {
    label: stale ? `${window.label}（历史）` : window.label,
    // 分桶窗口用桶名作 scope（原来等于 label，重复且看不出归属）；其它供应商维持原样
    scope: title ?? window.label,
    bucket,
    used: window.used ?? 0,
    limit: window.limit ?? 0,
    percentUsed: window.percentUsed ?? null,
    resetAt: formatOllamaResetAt(providerId, window.resetAt),
    status,
  };
}

// ChatGPT 两个额度桶独立计量：网页对话额度在免费档没有数据源（rate_limits 返回 404），
// 显式占位说明，避免把「Codex 编码额度用尽」误读成「ChatGPT 整体没额度、不能聊天了」
function withChatgptBucketNote(
  providerId: string,
  windows: QuotaWindow[],
  status: PlatformStatus,
): QuotaWindow[] {
  if (providerId !== "chatgpt") return windows;
  // 完全没有窗口时（未配置凭据 / 全链路失败）保持通用空态文案，不叠加桶说明
  if (windows.length === 0) return windows;
  if (windows.some((window) => window.bucket === "web")) return windows;
  return [
    ...windows,
    {
      label: "网页对话额度",
      scope: "网页对话额度",
      bucket: "web",
      note: "与 Codex 编码额度独立计量，Codex 用尽不影响网页聊天；该额度接口未对外提供（免费与 Plus 档实测均返回 404）",
      used: 0,
      limit: 0,
      percentUsed: null,
      resetAt: "",
      status,
    },
  ];
}

// 数值转"万"单位（>=1 万时），如 12000 -> 1.2万
function formatWan(value: number): string {
  if (value >= 10000) {
    return `${(value / 10000).toFixed(1)}万`;
  }
  return new Intl.NumberFormat("zh-CN").format(value);
}

// 30 天 Token 数转"亿"（两位小数）
function formatYi(value: number): string {
  return `${(value / 1e8).toFixed(2)}亿`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

// Command Code：Token 数按 M/K 缩写，计费周期显示为 10/30 - 11/30
function formatTokenCount(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatBillingPeriod(periodStart: string): string {
  const start = new Date(periodStart);
  if (Number.isNaN(start.getTime())) return periodStart;
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const fmt = (date: Date) => `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
  return `${fmt(start)} - ${fmt(end)}`;
}

// OpenCode Go 本期 Activity 过期判断：优先用订阅精确结束时间 metrics.endsAt，
// 旧快照缺 endsAt 时退回额度月窗 resetAt。找不到可靠时间时不做判断（仍展示）。
function isOpenCodeActivityExpired(
  metrics: Record<string, unknown>,
  windows: ServerProviderWindow[],
  now: number,
): boolean {
  const endsAt = parseTimestampOrNull(metrics.endsAt);
  if (endsAt) return new Date(endsAt).getTime() <= now;

  return windows.some((window) => {
    if (window.key !== "monthly" || typeof window.resetAt !== "string" || !window.resetAt) return false;
    const resetAt = new Date(window.resetAt).getTime();
    return !Number.isNaN(resetAt) && resetAt <= now;
  });
}

// metrics.topModels 是后端写入且已按请求数降序的 JSON 字符串 [{ model, requests, share }]。
// 严格分母契约：totalRequests > 0 且数组整体合法才映射；share 一律按 requests/totalRequests
// 计算，不采信行内 share；任一行非法或 requests 超过总量时整表为空。
function parseOpenCodeTopModels(raw: unknown, totalRequests: number | null): ModelSpendRow[] {
  if (totalRequests === null || totalRequests <= 0 || typeof raw !== "string") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const rows: ModelSpendRow[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const model = typeof row.model === "string" ? row.model.trim() : "";
    const requests = parseNonNegativeInt(row.requests);
    if (!model || requests === null || requests > totalRequests) return [];
    rows.push({
      model,
      requests,
      tokens: 0,
      spendUsd: 0,
      share: requests / totalRequests,
    });
  }

  // Worker 已排序，这里只截断，不做二次排序
  return rows.slice(0, 5);
}

// OpenCode Activity 视图：账户级调用时必须传该账户自己的 metrics/windows，
// 不能借用平台首账号的数据。
function buildOpenCodeActivity(
  metrics: Record<string, unknown>,
  windows: ServerProviderWindow[],
  now: number,
): { detailMetrics: DetailMetric[]; modelSpends: ModelSpendRow[] } {
  if (isOpenCodeActivityExpired(metrics, windows, now)) {
    return { detailMetrics: [], modelSpends: [] };
  }

  const items: DetailMetric[] = [];
  const totalRequests = typeof metrics.totalRequests === "number" && Number.isFinite(metrics.totalRequests)
    ? metrics.totalRequests
    : null;
  const totalTokens = typeof metrics.totalTokens === "number" && Number.isFinite(metrics.totalTokens)
    ? metrics.totalTokens
    : null;
  if (totalRequests !== null) {
    items.push({ label: "总请求数", value: new Intl.NumberFormat("zh-CN").format(totalRequests) });
  }
  if (totalTokens !== null) {
    items.push({ label: "总 Token", value: formatTokenCount(totalTokens) });
  }
  // 活动起点可选：只用于补充说明汇总所属周期，不参与配额
  const activityStartsAt = parseTimestampOrNull(metrics.activityStartsAt);
  if (activityStartsAt && (totalRequests !== null || totalTokens !== null)) {
    items.push({ label: "本期起点", value: formatResetAt(activityStartsAt) });
  }

  return {
    detailMetrics: items,
    modelSpends: parseOpenCodeTopModels(metrics.topModels, totalRequests),
  };
}

// 智谱卡 3×3 九宫格指标：
// 第1行 [5小时窗口(已用/额度), 登录状态, 最近同步]
// 第2行 [7天 Cache 命中率, 7天积分消耗, 7天 Tokens]
// 第3行 [30天 Cache 命中率, 30天积分总数, 30天 Tokens]
// Ollama 模型请求数列表（由 metrics.weeklyModels JSON 推导，按请求数降序）
function resolveModelSpends(providerId: string, metrics: Record<string, unknown>, windows: ServerProviderWindow[]): ModelSpendRow[] {
  if (providerId === "opencode-go") {
    // 请求数占比口径：分母为同账号同周期总请求数，模型行在 Worker 端已排序
    return buildOpenCodeActivity(metrics, windows, Date.now()).modelSpends;
  }
  if (providerId === "commandcode") {
    const raw = typeof metrics.topModels === "string" ? metrics.topModels : "[]";
    let rows: Array<{ model: string; requests: number; tokens: number; share: number }> = [];
    try {
      rows = JSON.parse(raw);
    } catch {
      rows = [];
    }
    return rows.slice(0, 5).map((row) => ({
      model: row.model,
      requests: row.requests,
      tokens: row.tokens,
      spendUsd: 0,
      share: row.share,
    }));
  }
  if (providerId !== "ollama") return [];
  const raw = typeof metrics.weeklyModels === "string" ? metrics.weeklyModels : "[]";
  let models: Array<{ name: string; requests: number }> = [];
  try {
    models = JSON.parse(raw);
  } catch {
    models = [];
  }
  const total = models.reduce((sum, m) => sum + m.requests, 0);
  return models.map((m) => ({
    model: m.name,
    requests: m.requests,
    tokens: 0,
    spendUsd: 0,
    share: total > 0 ? m.requests / total : 0,
  }));
}

function buildDetailMetrics(
  providerId: string,
  card: ServerUsageCard,
  loginState: string,
  capturedAt: string,
): DetailMetric[] {
  const metrics = card.metrics;
  const items: DetailMetric[] = [];
  const push = (label: string, value: unknown, formatter?: (n: number) => string) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    items.push({
      label,
      value: formatter
        ? formatter(value)
        : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value),
    });
  };

  if (providerId === "ollama") {
    // 5小时预计总请求 = 5小时总请求 / 已用百分比（usage 为小数时按 0~1，percent 为 0~100）
    const requests5h = typeof metrics.sessionRequestCount === "number" ? metrics.sessionRequestCount : null;
    const percent5h = typeof metrics.sessionUsagePercent === "number" ? metrics.sessionUsagePercent : null;
    const estimated5h =
      requests5h !== null && percent5h !== null && percent5h > 0
        ? Math.round(requests5h / (percent5h / 100))
        : null;
    push("5小时请求数", requests5h, (n) => new Intl.NumberFormat("zh-CN").format(n));
    push("本周请求数", metrics.weeklyRequestCount, (n) => new Intl.NumberFormat("zh-CN").format(n));
    push("5小时预计总请求", estimated5h, (n) => new Intl.NumberFormat("zh-CN").format(n));
    return items;
  }
  if (providerId === "opencode-go") {
    // OpenCode 模型接口只提供请求数：汇总展示总请求数/总 Token，模型表由 Activity 映射
    items.push(...buildOpenCodeActivity(metrics, card.windows, Date.now()).detailMetrics);
    return items;
  }
  if (providerId === "commandcode") {
    push("总 Token", metrics.totalTokens, (n) => formatTokenCount(n));
    push("总请求数", metrics.totalRequests, (n) => new Intl.NumberFormat("zh-CN").format(n));
    push("计费月花费", metrics.totalCost, (n) => `$${n.toFixed(2)}`);
    const periodStart = typeof metrics.periodStart === "string" ? metrics.periodStart : null;
    if (periodStart) {
      items.push({ label: "计费周期", value: formatBillingPeriod(periodStart) });
    }
    return items;
  }
  if (providerId === "chatgpt") {
    items.push({
      label: "订阅档位",
      value: typeof metrics.plan === "string" && metrics.plan ? metrics.plan : "未知",
    });
    items.push({ label: "续费日期", value: formatChatgptPlanRenewAt(metrics.planRenewAt) });
    items.push({ label: "Token 刷新", value: metrics.codexTokenRefreshed === true ? "本轮已刷新" : "未刷新" });
    // 云端出口被 chatgpt.com 403 整体拒绝（实测），数据由本机脚本推送 → 明确标注来源
    const chatgptFetchMethod = typeof card.meta?.fetchMethod === "string" ? card.meta.fetchMethod : null;
    items.push({
      label: "抓取方式",
      value:
        chatgptFetchMethod === "local_ingest"
          ? "本机推送"
          : metrics.webFetchMethod === "snapshot_fallback"
            ? "快照回退"
            : metrics.webFetchMethod === "unconfigured"
              ? "未配置"
              : "云端直连",
    });
    // 本机推送通道下，推送时间即数据新鲜度（云端无法刷新，卡片其余指标不体现时间）
    if (chatgptFetchMethod === "local_ingest" && capturedAt) {
      items.push({
        label: "推送时间",
        value: new Intl.DateTimeFormat("zh-CN", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(capturedAt)),
      });
    }
    return items;
  }
  if (providerId !== "zhipu") return [];

  // 5小时窗口：已用 / 额度（万单位）
  const rp5h = card.windows.find((w) => w.key === "rp5h") ?? card.windows[0];
  if (rp5h && typeof rp5h.used === "number" && typeof rp5h.limit === "number" && rp5h.limit > 0) {
    items.push({ label: "5小时", value: formatWan(rp5h.used) + " / " + formatWan(rp5h.limit) });
  }
  items.push({ label: "登录状态", value: loginState || "待登录" });
  items.push({
    label: "最近同步",
    value: capturedAt
      ? new Intl.DateTimeFormat("zh-CN", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(capturedAt))
      : "待同步",
  });

  push("7天 Cache 命中率", typeof metrics.cacheHitRate7d === "number" ? metrics.cacheHitRate7d * 100 : null, formatPercent);
  push("7天积分消耗", metrics.totalCredits7d);
  push("7天 Tokens", metrics.totalTokens7d, formatYi);
  push("30天 Cache 命中率", typeof metrics.cacheHitRate30d === "number" ? metrics.cacheHitRate30d * 100 : null, formatPercent);
  push("30天积分总数", metrics.totalCredits30d);
  push("30天 Tokens", metrics.totalTokens30d, formatYi);
  return items;
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

function toLinks(providerId: string, sourceUrl: string): RawLinkItem[] {
  // OpenAI 组织卡的原网页按钮文案与普通平台不同
  if (providerId === OPENAI_API_PROVIDER_ID) {
    return [{ label: "打开原网页", href: sourceUrl, tone: "brand" }];
  }
  return [{ label: "打开看板", href: sourceUrl, tone: "brand" }];
}

const OPENAI_RESOURCE_STATUSES: OpenAiResourceStatus[] = ["ready", "stale", "unavailable"];
const OPENAI_ERROR_CODES: OpenAiErrorCode[] = [
  "not_configured",
  "timeout",
  "upstream_failed",
  "invalid_data",
  "storage_failed",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseIsoString(value: unknown): string {
  if (typeof value === "string" && value && !Number.isNaN(new Date(value).getTime())) {
    return value;
  }
  return "";
}

function parseTimestampOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

function parseStatus(value: unknown): OpenAiResourceStatus {
  return OPENAI_RESOURCE_STATUSES.find((status) => status === value) ?? "unavailable";
}

function parseError(value: unknown): OpenAiErrorCode | undefined {
  return OPENAI_ERROR_CODES.find((code) => code === value);
}

function parseNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// 将服务端 meta.openaiApi 解析为前端结构化数据；任何非法结构都退化为安全空态。
// 把非法区块降级为 unavailable + invalid_data，避免 ready/stale + null 伪装成成功空
function invalidSection(): { status: "unavailable"; updatedAt: null; value: null; error: "invalid_data" } {
  return { status: "unavailable", updatedAt: null, value: null, error: "invalid_data" };
}

function parseOpenAiApi(meta: Record<string, unknown>): OpenAiApiCardData {
  const empty: OpenAiApiCardData = {
    period: { start: "", end: "" },
    costs: { status: "unavailable", updatedAt: null, value: null },
    usage: { status: "unavailable", updatedAt: null, value: null },
  };
  const raw = asRecord(meta.openaiApi);
  if (!raw) return empty;

  const rawPeriod = asRecord(raw.period);
  const period: OpenAiApiPeriod = {
    start: parseIsoString(rawPeriod?.start),
    end: parseIsoString(rawPeriod?.end),
  };

  // 费用区：ready/stale 必须有合法有限数值，否则视为无效数据
  const rawCosts = asRecord(raw.costs);
  const costsStatus = parseStatus(rawCosts?.status);
  let costs: OpenAiApiCosts;
  if (costsStatus === "unavailable") {
    costs = { status: "unavailable", updatedAt: parseTimestampOrNull(rawCosts?.updatedAt), value: null };
  } else {
    const costValue = rawCosts?.value;
    if (typeof costValue !== "number" || !Number.isFinite(costValue)) {
      costs = invalidSection();
    } else {
      costs = {
        status: costsStatus,
        updatedAt: parseTimestampOrNull(rawCosts?.updatedAt),
        value: costValue,
      };
    }
  }
  const costError = parseError(rawCosts?.error);
  if (costError) costs.error = costError;

  // 用量区：ready/stale 必须有合法数值且 topModels 为数组（[] 是合法空），
  // 缺 topModels 或字段非法都降级为 invalid_data，不能伪装成「本期暂无用量」
  const rawUsage = asRecord(raw.usage);
  const usageStatus = parseStatus(rawUsage?.status);
  let usage: OpenAiApiUsage;
  if (usageStatus === "unavailable") {
    usage = { status: "unavailable", updatedAt: parseTimestampOrNull(rawUsage?.updatedAt), value: null };
  } else {
    const rawUsageValue = asRecord(rawUsage?.value);
    const requests = rawUsageValue ? parseNonNegativeInt(rawUsageValue.requests) : null;
    const inputTokens = rawUsageValue ? parseNonNegativeInt(rawUsageValue.inputTokens) : null;
    const outputTokens = rawUsageValue ? parseNonNegativeInt(rawUsageValue.outputTokens) : null;
    const rawTopModels = rawUsageValue?.topModels;
    // topModels 必须是数组（合法空数组为 []）；缺失/非法 → 无效数据
    if (
      requests === null ||
      inputTokens === null ||
      outputTokens === null ||
      !Array.isArray(rawTopModels)
    ) {
      usage = invalidSection();
    } else {
      const topModels: OpenAiApiTopModel[] = [];
      let hasInvalidRow = false;
      for (const item of rawTopModels as unknown[]) {
        const row = asRecord(item);
        if (!row || typeof row.model !== "string" || !row.model) {
          hasInvalidRow = true;
          continue;
        }
        const rowRequests = parseNonNegativeInt(row.requests);
        const rowTokens = parseNonNegativeInt(row.tokens);
        // share 必须是 0..1 的有限数值；非法值（含缺失）与同区其它字段非法一样
        // 让整区块降级 invalid_data，而不是被钳制成 0 伪装成合法空占比
        const share =
          typeof row.share === "number" && Number.isFinite(row.share) && row.share >= 0 && row.share <= 1
            ? row.share
            : null;
        if (rowRequests === null || rowTokens === null || share === null) {
          hasInvalidRow = true;
          continue;
        }
        topModels.push({ model: row.model, requests: rowRequests, tokens: rowTokens, share });
      }
      if (hasInvalidRow) {
        // 任一行非法 → 整区块无效，避免部分数据被当作完整快照
        usage = invalidSection();
      } else {
        usage = {
          status: usageStatus,
          updatedAt: parseTimestampOrNull(rawUsage?.updatedAt),
          value: { requests, inputTokens, outputTokens, topModels },
        };
      }
    }
  }
  const usageError = parseError(rawUsage?.error);
  if (usageError) usage.error = usageError;

  return { period, costs, usage };
}

function mapServerDashboard(server: ServerUsageDashboard): DashboardSnapshot {
  const platforms = server.cards.map((card) => {
    const status = mapStatus(card.status, card.meta);
    const sourceLabel = toSourceLabel(card.sourceUrl);
    const windows = card.windows.map((window) => toQuotaWindow(card.providerId, status, window));
    const trend =
      card.trend.length > 0
        ? card.trend.map(toTrendPoint)
        : windows.map(toTrendPointFromQuotaWindow);
    const primaryWindow = card.windows[0];

    const accounts = (card.accounts ?? []).map((account) => {
      const accountStatus = mapStatus(account.status, account.meta);
      const accountWindows = account.windows.map((window) => toQuotaWindow(card.providerId, accountStatus, window));
      const isFallback = account.meta?.isFallback === true;
      const liveStatus = typeof account.meta?.liveStatus === "string" ? account.meta.liveStatus : null;
      // OpenCode 的汇总与模型必须来自该账户自己的 metrics，不能回填平台首账号
      const activity = card.providerId === "opencode-go"
        ? buildOpenCodeActivity(account.metrics, account.windows, Date.now())
        : null;
      return {
        id: account.accountId,
        label: account.accountLabel,
        summary: account.summary,
        status: accountStatus,
        loginState: resolveLoginState(account.status, account.meta),
        ...(isFallback && liveStatus ? { liveStatus } : {}),
        sourceUrl: account.sourceUrl,
        sourceLabel: toSourceLabel(account.sourceUrl),
        primaryMetricValue: account.windows[0]
          ? formatWindowValue(account.windows[0])
          : account.summary,
        lastRefreshedAt: account.capturedAt,
        quotaWindows: withChatgptBucketNote(card.providerId, accountWindows, accountStatus),
        trend:
          account.trend.length > 0
            ? account.trend.map(toTrendPoint)
            : accountWindows.map(toTrendPointFromQuotaWindow),
        links: toLinks(card.providerId, account.sourceUrl),
        ...(activity
          ? { detailMetrics: activity.detailMetrics, modelSpends: activity.modelSpends }
          : {}),
      };
    });

    // OpenAI 组织卡：金额只进卡片自己的额度区，modelSpends 保持为空，
    // 避免混入首页「总花费」；原网页入口由 toLinks 使用专用文案。
    const isOpenAi = card.providerId === OPENAI_API_PROVIDER_ID;
    const openaiApi = isOpenAi ? parseOpenAiApi(card.meta ?? {}) : undefined;
    const sourceUrl =
      isOpenAi && !card.sourceUrl ? OPENAI_API_SOURCE_URL : card.sourceUrl;

    return {
      id: card.providerId,
      name: card.providerName,
      tagline: resolveTagline(card.providerId),
      summary: card.summary,
      status,
      loginState: resolveLoginState(card.status, card.meta),
      sourceUrl,
      // OpenAI 卡头右侧只显示短标签，避免窄屏把「OpenAI API」标题挤成两行；
      // sourceUrl 仍保留完整原网址，入口按钮照常跳转
      sourceLabel: isOpenAi
        ? "组织分析"
        : sourceUrl === card.sourceUrl
          ? sourceLabel
          : toSourceLabel(sourceUrl),
      primaryMetricLabel: resolvePrimaryMetricLabel(card.providerId, card.windows),
      primaryMetricValue: primaryWindow ? formatWindowValue(primaryWindow) : card.summary,
      lastRefreshedAt: card.capturedAt,
      accent: resolveAccent(card.providerId),
      // 占位说明行加在 trend 计算之后（trend 只取真实窗口，不受占位行影响）
      quotaWindows: withChatgptBucketNote(card.providerId, windows, status),
      detailMetrics: buildDetailMetrics(
        card.providerId,
        card,
        resolveLoginState(card.status, card.meta),
        card.capturedAt,
      ),
      trend,
      modelSpends: isOpenAi ? [] : resolveModelSpends(card.providerId, card.metrics, card.windows),
      links: toLinks(card.providerId, sourceUrl),
      selectedAccountId: card.selectedAccountId ?? accounts[0]?.id ?? null,
      accounts,
      ...(openaiApi ? { openaiApi } : {}),
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

  async function createRequestHeaders(): Promise<HeadersInit> {
    const token = options.authTokenProvider ? await options.authTokenProvider() : null;
    if (!token) return headers;

    return {
      ...headers,
      Authorization: `Bearer ${token}`,
    };
  }

  return {
    async getAuthConfig(): Promise<AuthConfig> {
      const payload = await requestJson<AuthConfig | ApiEnvelope<AuthConfig>>(
        fetcher,
        buildUrl(options.baseUrl, "/api/auth/config"),
        {
          method: "GET",
          credentials: "include",
          headers,
        },
      );

      return unwrapEnvelope(payload);
    },

    async getUsageDashboard(): Promise<DashboardSnapshot> {
      const payload = await requestJson<ServerUsageDashboard | ApiEnvelope<ServerUsageDashboard>>(
        fetcher,
        buildUrl(options.baseUrl, "/api/usage"),
        {
          method: "GET",
          credentials: "include",
          headers: await createRequestHeaders(),
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
          headers: await createRequestHeaders(),
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

    async getProviderSettings(): Promise<ProviderSettingsPayload> {
      const payload = await requestJson<ProviderSettingsPayload | ApiEnvelope<ProviderSettingsPayload>>(
        fetcher,
        buildUrl(options.baseUrl, "/api/settings/providers"),
        {
          method: "GET",
          credentials: "include",
          headers: await createRequestHeaders(),
        },
      );

      return unwrapEnvelope(payload);
    },

    async saveProviderPreferences(
      preferences: ProviderPreference[],
    ): Promise<ProviderPreference[]> {
      const payload = await requestJson<ProviderPreference[] | ApiEnvelope<ProviderPreference[]>>(
        fetcher,
        buildUrl(options.baseUrl, "/api/settings/providers"),
        {
          method: "PUT",
          credentials: "include",
          headers: await createRequestHeaders(),
          body: JSON.stringify({ providers: preferences }),
        },
      );

      return unwrapEnvelope(payload);
    },

    async saveProviderAccount(
      account: ProviderAccountInput,
    ): Promise<{ id: string }> {
      const payload = await requestJson<{ id: string } | ApiEnvelope<{ id: string }>>(
        fetcher,
        buildUrl(options.baseUrl, "/api/settings/accounts"),
        {
          method: "POST",
          credentials: "include",
          headers: await createRequestHeaders(),
          body: JSON.stringify(account),
        },
      );

      return unwrapEnvelope(payload);
    },

    async updateProviderAccount(
      accountId: string,
      account: ProviderAccountInput,
    ): Promise<{ id: string }> {
      const payload = await requestJson<{ id: string } | ApiEnvelope<{ id: string }>>(
        fetcher,
        buildUrl(options.baseUrl, `/api/settings/accounts/${encodeURIComponent(accountId)}`),
        {
          method: "PATCH",
          credentials: "include",
          headers: await createRequestHeaders(),
          body: JSON.stringify(account),
        },
      );

      return unwrapEnvelope(payload);
    },

    async deleteProviderAccount(accountId: string): Promise<{ id: string }> {
      const payload = await requestJson<{ id: string } | ApiEnvelope<{ id: string }>>(
        fetcher,
        buildUrl(options.baseUrl, `/api/settings/accounts/${encodeURIComponent(accountId)}`),
        {
          method: "DELETE",
          credentials: "include",
          headers: await createRequestHeaders(),
        },
      );

      return unwrapEnvelope(payload);
    },

    async testProviderAccount(
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
          headers: await createRequestHeaders(),
        },
      );

      return unwrapEnvelope(payload);
    },

    async updateProviderAccountDisplay(
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
          headers: await createRequestHeaders(),
          body: JSON.stringify(input),
        },
      );

      return unwrapEnvelope(payload);
    },
  };
}
