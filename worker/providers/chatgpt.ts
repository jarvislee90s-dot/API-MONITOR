import { clampNumber, toIsoString } from "../http";
import type {
  ProviderDefinition,
  ProviderFetchInput,
  ProviderFetchResult,
  ProviderSnapshot,
  ProviderStatus,
  ProviderWindow,
} from "../types";
import { createResult } from "./types";

type ChatgptConfig = {
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
  sessionToken?: string;
  codexClientId?: string;
};

const defaultSourceUrl = "https://chatgpt.com";
const codexRateLimitsUrl = "https://chatgpt.com/backend-api/codex/rate_limits";
const codexTokenUrl = "https://auth.openai.com/oauth/token";
const webSessionUrl = "https://chatgpt.com/api/auth/session";
const webRateLimitsUrl = "https://chatgpt.com/backend-api/rate_limits";
const subscriptionCheckUrl = "https://chatgpt.com/backend-api/accounts/check";
// codex CLI 公开 client_id；实现期与 scripts/probe-chatgpt-endpoints.ts 探测输出核对，
// 若不符以探测结果修正此常量并同步更新 providers.test.ts 刷新测试的 client_id 断言
const defaultCodexClientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const defaultRequestTimeoutMs = 15_000;
const webUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 域名白名单：凭据只允许发往 chatgpt.com 系与 auth.openai.com（spec §4）
export function isTrustedChatgptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    return (
      url.hostname === "chatgpt.com" ||
      url.hostname.endsWith(".chatgpt.com") ||
      url.hostname === "auth.openai.com"
    );
  } catch {
    return false;
  }
}

// CF 质询识别：403 且响应头 cf-mitigated: challenge（spec §6）
export function isCloudflareChallenge(response: Response): boolean {
  if (response.status !== 403) return false;
  return response.headers.get("cf-mitigated")?.toLowerCase() === "challenge";
}

// 单链路网络超时（spec §6：15s）。workerd 支持 AbortSignal.timeout；
// 测试环境（happy-dom）未实现该静态方法，缺失时退化为无超时信号
function buildTimeoutSignal(requestTimeoutMs?: number): AbortSignal | undefined {
  const abortSignalCtor = globalThis.AbortSignal as unknown as
    | { timeout?: (ms: number) => AbortSignal }
    | undefined;
  if (typeof abortSignalCtor?.timeout !== "function") return undefined;
  return abortSignalCtor.timeout(requestTimeoutMs ?? defaultRequestTimeoutMs);
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = clampNumber(source[key]);
    if (value !== null) return value;
  }
  return null;
}

// 小数（0~1）按百分比放大，其余视为已是百分比值
function toPercentValue(value: number | null): number | null {
  if (value === null) return null;
  const percent = value > 0 && value <= 1 ? value * 100 : value;
  return Math.round(percent * 10) / 10;
}

// 重置时间：优先 ISO 字段，其次"剩余秒数 + now"推算
function pickResetAt(source: Record<string, unknown>, now: Date): string | null {
  for (const key of ["reset_at", "resets_at", "resetAt", "resetsAt", "reset_time"]) {
    const raw = source[key];
    if (typeof raw === "string" && raw.length > 0) {
      const date = new Date(raw);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  const seconds = pickNumber(source, [
    "resets_in_seconds",
    "reset_in_seconds",
    "seconds_until_reset",
    "reset_after_seconds",
  ]);
  if (seconds !== null && seconds >= 0) {
    return new Date(now.getTime() + seconds * 1000).toISOString();
  }
  return null;
}

function buildPercentWindow(params: {
  key: string;
  label: string;
  percentUsed: number | null;
  resetAt: string | null;
}): ProviderWindow {
  return {
    key: params.key,
    label: params.label,
    used: params.percentUsed ?? undefined,
    limit: params.percentUsed !== null ? 100 : undefined,
    remaining: params.percentUsed !== null ? Math.max(0, 100 - params.percentUsed) : undefined,
    percentUsed: params.percentUsed,
    percentRemaining: params.percentUsed !== null ? Math.max(0, 100 - params.percentUsed) : undefined,
    resetAt: params.resetAt,
  };
}

// 宽容解析 codex rate_limits：根对象或 rate_limits 键下，
// 键名含 5h/primary/session → codex_5h，含 week/secondary/7d → codex_weekly（spec §2）
export function parseCodexWindows(payload: unknown, now: Date): ProviderWindow[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const container = ((payload as { rate_limits?: unknown }).rate_limits ?? payload) as Record<
    string,
    unknown
  >;
  if (!container || typeof container !== "object") return [];

  const windows: ProviderWindow[] = [];
  for (const [rawKey, rawValue] of Object.entries(container)) {
    if (!rawValue || typeof rawValue !== "object") continue;
    const source = rawValue as Record<string, unknown>;
    const isFiveHour = /5h|primary|session/i.test(rawKey);
    const isWeekly = /week|secondary|7d/i.test(rawKey);
    if (!isFiveHour && !isWeekly) continue;
    const key = isFiveHour ? "codex_5h" : "codex_weekly";
    if (windows.some((window) => window.key === key)) continue;

    let percentUsed = toPercentValue(
      pickNumber(source, [
        "used_percent",
        "used_pct",
        "usage_percent",
        "usagePercent",
        "percent_used",
        "percentUsed",
        "usage",
      ]),
    );
    if (percentUsed === null) {
      const used = pickNumber(source, ["used", "used_requests", "requests_used", "count"]);
      const limit = pickNumber(source, ["limit", "total", "max", "capacity"]);
      if (used !== null && limit !== null && limit > 0) {
        percentUsed = Math.round((used / limit) * 1000) / 10;
      }
    }
    const resetAt = pickResetAt(source, now);
    if (percentUsed === null && resetAt === null) continue;

    windows.push(
      buildPercentWindow({
        key,
        label: isFiveHour ? "Codex 5小时" : "Codex 每周",
        percentUsed,
        resetAt,
      }),
    );
  }
  return windows;
}

// 用 refresh token 纯 HTTP 刷新 access token；失败返回 null，由调用方按桶降级（spec §2）
async function refreshCodexToken(input: {
  refreshToken: string;
  clientId: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<{ accessToken: string; refreshToken: string } | null> {
  try {
    const response = await input.fetchImpl(codexTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: input.clientId,
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
      }),
      signal: buildTimeoutSignal(input.requestTimeoutMs),
    });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      refresh_token?: unknown;
    } | null;
    if (!payload || typeof payload.access_token !== "string" || payload.access_token.length === 0) {
      return null;
    }
    return {
      accessToken: payload.access_token,
      // 部分实现不回传新 refresh token，沿用旧值
      refreshToken:
        typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
          ? payload.refresh_token
          : input.refreshToken,
    };
  } catch {
    return null;
  }
}

// 三桶统一结果形态（网页/订阅链路在 Task 4 复用）
export type ChatgptBucketOutcome = {
  attempted: boolean;
  windows: ProviderWindow[];
  loginRequired: boolean;
  cfChallenge: boolean;
  fetchFailed: boolean;
};

function notConfiguredBucket(): ChatgptBucketOutcome {
  return { attempted: false, windows: [], loginRequired: false, cfChallenge: false, fetchFailed: false };
}

async function requestCodexRateLimits(input: {
  accessToken: string;
  accountId: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<Response> {
  return input.fetchImpl(codexRateLimitsUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${input.accessToken}`,
      "chatgpt-account-id": input.accountId,
      "User-Agent": webUserAgent,
    },
    signal: buildTimeoutSignal(input.requestTimeoutMs),
  });
}

// codex 链路：Bearer + chatgpt-account-id；401/403（非质询）→ 刷新 → 重试一次 → credentialUpdate 带出（spec §6）
async function fetchCodexWindows(input: {
  config: ChatgptConfig;
  now: Date;
  fetchImpl: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<{ outcome: ChatgptBucketOutcome; credentialUpdate: Record<string, string> | null }> {
  if (!isTrustedChatgptUrl(codexRateLimitsUrl) || !isTrustedChatgptUrl(codexTokenUrl)) {
    return { outcome: { ...notConfiguredBucket(), fetchFailed: true }, credentialUpdate: null };
  }

  const accessToken = input.config.accessToken ?? "";
  const accountId = input.config.accountId ?? "";

  let response: Response;
  try {
    response = await requestCodexRateLimits({
      accessToken,
      accountId,
      fetchImpl: input.fetchImpl,
      requestTimeoutMs: input.requestTimeoutMs,
    });
  } catch {
    return { outcome: { ...notConfiguredBucket(), attempted: true, fetchFailed: true }, credentialUpdate: null };
  }

  let credentialUpdate: Record<string, string> | null = null;
  // CF 质询（403 + cf-mitigated: challenge）是 IP 拦截而非凭据失效，不消耗 token 刷新
  if (
    (response.status === 401 || (response.status === 403 && !isCloudflareChallenge(response))) &&
    input.config.refreshToken
  ) {
    const refreshed = await refreshCodexToken({
      refreshToken: input.config.refreshToken,
      clientId: input.config.codexClientId?.trim() || defaultCodexClientId,
      fetchImpl: input.fetchImpl,
      requestTimeoutMs: input.requestTimeoutMs,
    });
    if (refreshed) {
      // 即使重试仍失败也要带出新 token：refresh token 轮换后旧值可能已作废
      credentialUpdate = { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken };
      try {
        response = await requestCodexRateLimits({
          accessToken: refreshed.accessToken,
          accountId,
          fetchImpl: input.fetchImpl,
          requestTimeoutMs: input.requestTimeoutMs,
        });
      } catch {
        return {
          outcome: { ...notConfiguredBucket(), attempted: true, fetchFailed: true },
          credentialUpdate,
        };
      }
    }
  }

  if (isCloudflareChallenge(response)) {
    return { outcome: { ...notConfiguredBucket(), attempted: true, cfChallenge: true }, credentialUpdate };
  }
  if (response.status === 401 || response.status === 403) {
    return { outcome: { ...notConfiguredBucket(), attempted: true, loginRequired: true }, credentialUpdate };
  }
  if (!response.ok) {
    return { outcome: { ...notConfiguredBucket(), attempted: true, fetchFailed: true }, credentialUpdate };
  }

  const payload = await response.json().catch(() => null);
  return {
    outcome: { ...notConfiguredBucket(), attempted: true, windows: parseCodexWindows(payload, input.now) },
    credentialUpdate,
  };
}

// 订阅桶结果形态（Task 4 填充真实链路；notFound=true 表示 404/空 → 免费档，不降级）
export type ChatgptSubscriptionOutcome = {
  attempted: boolean;
  plan: string | null;
  planRenewAt: string | null;
  notFound: boolean;
};

function notConfiguredSubscription(): ChatgptSubscriptionOutcome {
  return { attempted: false, plan: null, planRenewAt: null, notFound: false };
}

// 深度查找字符串键，兼容订阅端点响应结构漂移
function deepFindString(value: unknown, keyPattern: RegExp): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindString(item, keyPattern);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (keyPattern.test(key) && typeof entry === "string" && entry.length > 0) return entry;
      const found = deepFindString(entry, keyPattern);
      if (found) return found;
    }
  }
  return null;
}

// 订阅信息：plan 取 plan_type/plan 等键，续费时间取 renewal/current_period_end 等键
export function parseSubscriptionPayload(
  payload: unknown,
): { plan: string; planRenewAt: string | null } | null {
  const plan = deepFindString(payload, /^(plan_type|plantype|plan|subscription_plan)$/i);
  if (!plan) return null;
  const renewRaw = deepFindString(
    payload,
    /(next_renewal|renewal_date|plan_renewal|current_period_end|renews_at)/i,
  );
  let planRenewAt: string | null = null;
  if (renewRaw) {
    const date = new Date(renewRaw);
    planRenewAt = Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return { plan: plan.toLowerCase(), planRenewAt };
}

// 网页对话额度宽容解析：旧 message_cap 键值形态 + 新分组形态（数组或对象），组名透传不枚举（spec §2）
export function parseWebRateLimitWindows(payload: unknown, now: Date): ProviderWindow[] {
  const windows: ProviderWindow[] = [];
  const seenKeys = new Set<string>();

  const pushGroupWindow = (params: { slug: string; source: Record<string, unknown> }) => {
    const key = `web_5h_${params.slug}`;
    if (seenKeys.has(key)) return;
    let percentUsed = toPercentValue(
      pickNumber(params.source, [
        "used_percent",
        "used_pct",
        "percent_used",
        "percentUsed",
        "usage",
      ]),
    );
    if (percentUsed === null) {
      const used = pickNumber(params.source, ["used", "used_messages", "requests"]);
      const limit = pickNumber(params.source, ["max_cap", "limit", "total", "window_limit"]);
      if (used !== null && limit !== null && limit > 0) {
        percentUsed = Math.round((used / limit) * 1000) / 10;
      }
    }
    const resetAt = pickResetAt(params.source, now);
    if (percentUsed === null && resetAt === null) return;
    seenKeys.add(key);
    windows.push(
      buildPercentWindow({
        key,
        label: `对话 5小时·${params.slug}`,
        percentUsed,
        resetAt,
      }),
    );
  };

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      // 旧形态：[<slug>_]message_cap = { max_cap, remaining_cap, reset_at }；裸 message_cap 即 default 桶
      const messageCapMatch = /^(?:([a-z0-9_]+)_)?message_cap$/i.exec(key);
      if (messageCapMatch && value && typeof value === "object") {
        const source = value as Record<string, unknown>;
        const max = pickNumber(source, ["max_cap", "max", "limit"]);
        const remaining = pickNumber(source, ["remaining_cap", "remaining", "remaining_messages"]);
        if (max === null || max <= 0) continue;
        const used = remaining !== null ? Math.max(0, max - remaining) : null;
        const percentUsed = used !== null ? Math.round((used / max) * 1000) / 10 : null;
        const resetAt = pickResetAt(source, now);
        if (percentUsed === null && resetAt === null) continue;
        const slug = messageCapMatch[1] ?? "default";
        const windowKey = `web_5h_${slug}`;
        if (seenKeys.has(windowKey)) continue;
        seenKeys.add(windowKey);
        windows.push(
          buildPercentWindow({ key: windowKey, label: `对话 5小时·${slug}`, percentUsed, resetAt }),
        );
      }
    }
    if (windows.length > 0) return windows;

    // 新形态（对象分组）：值对象里带百分比/用量字段
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      pushGroupWindow({ slug: key.length > 0 ? key : "default", source: value as Record<string, unknown> });
    }
    return windows;
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (!item || typeof item !== "object") continue;
      const source = item as Record<string, unknown>;
      const slugRaw = source.slug ?? source.group ?? source.model_family ?? source.name;
      const slug = typeof slugRaw === "string" && slugRaw.length > 0 ? slugRaw : "default";
      pushGroupWindow({ slug, source });
    }
  }
  return windows;
}

function withCredentialUpdate(
  result: ProviderFetchResult,
  credentialUpdate: Record<string, string> | null,
): ProviderFetchResult {
  if (!credentialUpdate) return result;
  return { ...result, credentialUpdate };
}

// session cookie → accessToken（约 10 天有效）；网页与订阅两条链路共用（spec §2）
type WebSessionResult =
  | { kind: "ok"; accessToken: string }
  | { kind: "cf_challenge" }
  | { kind: "login_required" }
  | { kind: "failed" };

async function fetchWebAccessToken(input: {
  sessionToken: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<WebSessionResult> {
  if (!isTrustedChatgptUrl(webSessionUrl)) return { kind: "failed" };
  try {
    const response = await input.fetchImpl(webSessionUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: `__Secure-next-auth.session-token=${input.sessionToken}`,
        "User-Agent": webUserAgent,
      },
      signal: buildTimeoutSignal(input.requestTimeoutMs),
    });
    if (isCloudflareChallenge(response)) return { kind: "cf_challenge" };
    if (response.status === 401 || response.status === 403) return { kind: "login_required" };
    if (!response.ok) return { kind: "failed" };
    const payload = (await response.json().catch(() => null)) as { accessToken?: unknown } | null;
    // 200 但无 accessToken：视为登录态失效
    if (!payload || typeof payload.accessToken !== "string" || payload.accessToken.length === 0) {
      return { kind: "login_required" };
    }
    return { kind: "ok", accessToken: payload.accessToken };
  } catch {
    return { kind: "failed" };
  }
}

async function fetchWebRateLimits(input: {
  accessToken: string;
  now: Date;
  fetchImpl: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<ChatgptBucketOutcome> {
  if (!isTrustedChatgptUrl(webRateLimitsUrl)) {
    return { ...notConfiguredBucket(), fetchFailed: true };
  }
  try {
    const response = await input.fetchImpl(webRateLimitsUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.accessToken}`,
        "User-Agent": webUserAgent,
      },
      signal: buildTimeoutSignal(input.requestTimeoutMs),
    });
    if (isCloudflareChallenge(response)) {
      return { attempted: true, windows: [], loginRequired: false, cfChallenge: true, fetchFailed: false };
    }
    if (response.status === 401 || response.status === 403) {
      return { attempted: true, windows: [], loginRequired: true, cfChallenge: false, fetchFailed: false };
    }
    if (!response.ok) {
      return { attempted: true, windows: [], loginRequired: false, cfChallenge: false, fetchFailed: true };
    }
    const payload = await response.json().catch(() => null);
    return {
      attempted: true,
      windows: parseWebRateLimitWindows(payload, input.now),
      loginRequired: false,
      cfChallenge: false,
      fetchFailed: false,
    };
  } catch {
    return { attempted: true, windows: [], loginRequired: false, cfChallenge: false, fetchFailed: true };
  }
}

// 订阅链路：候选端点 accounts/check；404/无 plan 结构 → 免费档（正常数据不降级，spec §6）
async function fetchSubscription(input: {
  accessToken: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<ChatgptSubscriptionOutcome> {
  if (!isTrustedChatgptUrl(subscriptionCheckUrl)) {
    return { attempted: false, plan: null, planRenewAt: null, notFound: false };
  }
  const failed: ChatgptSubscriptionOutcome = { attempted: true, plan: null, planRenewAt: null, notFound: false };
  try {
    const response = await input.fetchImpl(subscriptionCheckUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.accessToken}`,
        "User-Agent": webUserAgent,
      },
      signal: buildTimeoutSignal(input.requestTimeoutMs),
    });
    if (response.status === 404) {
      return { attempted: true, plan: "free", planRenewAt: null, notFound: true };
    }
    if (!response.ok) {
      return failed;
    }
    const payload = await response.json().catch(() => null);
    const parsed = parseSubscriptionPayload(payload);
    if (!parsed) {
      return { attempted: true, plan: "free", planRenewAt: null, notFound: true };
    }
    return { attempted: true, plan: parsed.plan, planRenewAt: parsed.planRenewAt, notFound: false };
  } catch {
    return failed;
  }
}

// 三桶状态合并（spec §5 状态机，纯函数）：
// 任一桶有数据即不为 error；codex/web 至少一桶有窗口且无降级 → ready；
// 有数据但 CF 质询或订阅获取失败（免费档 notFound 不算失败）→ partial；
// 无任何凭据、或 OAuth 刷新失败且 session 失效 → login_required；三链路全失败 → error
export function mergeChatgptBuckets(input: {
  codex: ChatgptBucketOutcome;
  web: ChatgptBucketOutcome;
  subscription: ChatgptSubscriptionOutcome;
  hasCodexCredentials: boolean;
  hasSessionToken: boolean;
  capturedAt: string;
  sourceUrl: string;
  credentialUpdate: Record<string, string> | null;
}): ProviderFetchResult {
  const windows = [...input.codex.windows, ...input.web.windows];
  const metrics: Record<string, number | string | boolean | null> = {
    hasCodexCredentials: input.hasCodexCredentials,
    hasSessionToken: input.hasSessionToken,
    codexTokenRefreshed: input.credentialUpdate !== null,
    webFetchMethod: input.web.windows.length > 0 ? "direct" : "snapshot_fallback",
    plan: input.subscription.plan ?? "unknown",
    planRenewAt: input.subscription.planRenewAt,
  };

  const base = {
    providerId: "chatgpt" as const,
    providerName: "ChatGPT",
    sourceUrl: input.sourceUrl,
    capturedAt: input.capturedAt,
    windows,
    metrics,
    meta: { entryUrl: input.sourceUrl },
  };

  const subscriptionHasData = input.subscription.attempted && input.subscription.plan !== null;
  const anyData = windows.length > 0 || subscriptionHasData;

  if (!anyData) {
    const noCredentials = !input.hasCodexCredentials && !input.hasSessionToken;
    const credentialsExhausted =
      (!input.hasCodexCredentials || (input.codex.attempted && input.codex.loginRequired)) &&
      (!input.hasSessionToken || (input.web.attempted && input.web.loginRequired));
    if (noCredentials || credentialsExhausted) {
      // 按 hasSessionToken 分支措辞：未配置 sessionToken 时不指责"网页 session 无效"
      let exhaustedSummary: string;
      if (input.hasCodexCredentials && input.hasSessionToken) {
        exhaustedSummary =
          "ChatGPT 登录态已失效：Codex token 刷新失败且网页 session 无效，请重新运行 scripts/import-chatgpt-credentials.ts";
      } else if (input.hasSessionToken) {
        exhaustedSummary = "ChatGPT 网页 session 已失效，请重新运行 scripts/import-chatgpt-credentials.ts";
      } else {
        exhaustedSummary =
          "ChatGPT Codex 登录态已失效（token 刷新失败），请重新运行 scripts/import-chatgpt-credentials.ts";
      }
      return withCredentialUpdate(
        createResult({
          ...base,
          status: "login_required",
          summary: noCredentials
            ? "ChatGPT 需要 Codex OAuth 凭据（accessToken + accountId）或网页 session cookie"
            : exhaustedSummary,
        } as ProviderSnapshot),
        input.credentialUpdate,
      );
    }
    return withCredentialUpdate(
      createResult({
        ...base,
        status: "error",
        summary: "ChatGPT 三链路本轮均未取到数据：Codex 与网页/订阅链路请求失败（含 Cloudflare 拦截）",
      } as ProviderSnapshot),
      input.credentialUpdate,
    );
  }

  const summaryParts: string[] = [];
  if (input.codex.windows.length > 0) summaryParts.push("Codex 窗口已获取");
  if (input.web.windows.length > 0) summaryParts.push("网页对话额度已获取");
  if (input.subscription.plan) summaryParts.push(`订阅档位 ${input.subscription.plan}`);

  const subscriptionFailed =
    input.subscription.attempted && input.subscription.plan === null && !input.subscription.notFound;
  const degraded = input.codex.cfChallenge || input.web.cfChallenge || subscriptionFailed;

  if (input.codex.cfChallenge || input.web.cfChallenge) {
    summaryParts.push("Cloudflare 拦截，请稍后重试或运行本地脚本（第二期）");
  }
  if (subscriptionFailed) {
    summaryParts.push("订阅信息获取失败");
  }
  if (input.subscription.plan === "free" && input.codex.windows.length === 0) {
    summaryParts.push("当前免费档，无 Codex 窗口数据");
  }

  const hasQuotaWindows = input.codex.windows.length > 0 || input.web.windows.length > 0;
  const status: ProviderStatus = hasQuotaWindows && !degraded ? "ready" : "partial";

  return withCredentialUpdate(
    createResult({ ...base, status, summary: summaryParts.join("；") } as ProviderSnapshot),
    input.credentialUpdate,
  );
}

export async function fetchChatgptSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = (input.config ?? {}) as ChatgptConfig;
  const hasCodexCredentials = Boolean(config.accessToken && config.accountId);
  const hasSessionToken = Boolean(config.sessionToken);

  if (!hasCodexCredentials && !hasSessionToken) {
    return mergeChatgptBuckets({
      codex: notConfiguredBucket(),
      web: notConfiguredBucket(),
      subscription: notConfiguredSubscription(),
      hasCodexCredentials: false,
      hasSessionToken: false,
      capturedAt: now,
      sourceUrl: defaultSourceUrl,
      credentialUpdate: null,
    });
  }

  const codexResult = hasCodexCredentials
    ? await fetchCodexWindows({
        config,
        now: input.now,
        fetchImpl,
        requestTimeoutMs: input.requestTimeoutMs,
      })
    : { outcome: notConfiguredBucket(), credentialUpdate: null };

  // 网页/订阅链路：session cookie 换 accessToken 后串行拉取额度与订阅（spec §2）
  let web = notConfiguredBucket();
  let subscription = notConfiguredSubscription();
  if (hasSessionToken) {
    const session = await fetchWebAccessToken({
      sessionToken: config.sessionToken ?? "",
      fetchImpl,
      requestTimeoutMs: input.requestTimeoutMs,
    });
    if (session.kind === "ok") {
      web = await fetchWebRateLimits({
        accessToken: session.accessToken,
        now: input.now,
        fetchImpl,
        requestTimeoutMs: input.requestTimeoutMs,
      });
      subscription = await fetchSubscription({
        accessToken: session.accessToken,
        fetchImpl,
        requestTimeoutMs: input.requestTimeoutMs,
      });
    } else if (session.kind === "cf_challenge") {
      web = { attempted: true, windows: [], loginRequired: false, cfChallenge: true, fetchFailed: false };
      subscription = { attempted: true, plan: null, planRenewAt: null, notFound: false };
    } else if (session.kind === "login_required") {
      web = { attempted: true, windows: [], loginRequired: true, cfChallenge: false, fetchFailed: false };
      subscription = { attempted: true, plan: null, planRenewAt: null, notFound: false };
    } else {
      web = { attempted: true, windows: [], loginRequired: false, cfChallenge: false, fetchFailed: true };
      subscription = { attempted: true, plan: null, planRenewAt: null, notFound: false };
    }
  }

  return mergeChatgptBuckets({
    codex: codexResult.outcome,
    web,
    subscription,
    hasCodexCredentials,
    hasSessionToken,
    capturedAt: now,
    sourceUrl: defaultSourceUrl,
    credentialUpdate: codexResult.credentialUpdate,
  });
}

export const chatgpt: ProviderDefinition = {
  id: "chatgpt",
  name: "ChatGPT",
  sourceUrl: defaultSourceUrl,
  description: "Codex 编码额度 / 网页对话额度 / 订阅状态",
  fetchSnapshot: fetchChatgptSnapshot,
};
