import { toIsoString } from "../http";
import type {
  ProviderDefinition,
  ProviderFetchInput,
  ProviderFetchResult,
  ProviderSnapshot,
  ProviderStatus,
  ProviderWindow,
} from "../types";
import { createResult } from "./types";
import {
  parseCodexWindows,
  parseSubscriptionPayload,
  parseWebRateLimitWindows,
} from "./chatgpt-parser";

// 纯解析函数已拆至 chatgpt-parser.ts；re-export 维持 tests/worker/providers.test.ts 既有导入路径
export { parseCodexWindows, parseSubscriptionPayload, parseWebRateLimitWindows } from "./chatgpt-parser";

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
// skipTokenRefresh（GET 调试端点）：跳过「刷新 → 重试」，401/403 直接按 loginRequired 桶降级，
// 避免轮换出的新 refresh token 因调用方不写回而烧毁存储凭据
async function fetchCodexWindows(input: {
  config: ChatgptConfig;
  now: Date;
  fetchImpl: typeof fetch;
  requestTimeoutMs?: number;
  skipTokenRefresh?: boolean;
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
    !input.skipTokenRefresh &&
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
    // 抓取方式三态：web 桶未尝试（未配置 sessionToken）→ unconfigured；
    // 尝试过且有窗口 → direct；尝试过但没取到（CF 质询等）→ snapshot_fallback
    webFetchMethod: !input.web.attempted
      ? "unconfigured"
      : input.web.windows.length > 0
        ? "direct"
        : "snapshot_fallback",
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
        skipTokenRefresh: input.skipTokenRefresh,
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
