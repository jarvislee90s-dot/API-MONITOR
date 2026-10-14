import { errorResponse, readJsonBody, successResponse } from "./http";
import { persistSnapshot } from "./index";
import { mergeChatgptBuckets, type ChatgptSubscriptionOutcome } from "./providers/chatgpt";
import { parseCodexPlan, parseCodexWindows, parseSubscriptionPayload, parseWebRateLimitWindows } from "./providers/chatgpt-parser";
import { listProviderSettings } from "./settings/repository";
import type { ProviderId, ProviderSnapshot, ProviderStatus, WorkerEnv } from "./types";

const VALID_STATUSES: ProviderStatus[] = ["ready", "partial", "login_required", "disabled", "error"];

type IngestBody = {
  snapshot?: Partial<ProviderSnapshot>;
};

type IngestDefaults = {
  providerName: string;
  summary: string;
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// 返回非 null 表示鉴权失败，调用方直接返回该响应
function authorizeIngest(request: Request, env: WorkerEnv): Response | null {
  const expectedKey = env.INGEST_API_KEY;
  if (!expectedKey) {
    return errorResponse(503, "ingest_disabled", "Ingest endpoint is not configured");
  }
  const providedKey = request.headers.get("x-ingest-key") ?? "";
  if (!timingSafeEqual(providedKey, expectedKey)) {
    return errorResponse(401, "unauthorized", "Invalid ingest key");
  }
  return null;
}

async function handleProviderIngest(
  request: Request,
  env: WorkerEnv,
  providerId: ProviderId,
  defaults: IngestDefaults,
): Promise<Response> {
  const unauthorized = authorizeIngest(request, env);
  if (unauthorized) return unauthorized;

  let body: IngestBody;
  try {
    body = await readJsonBody<IngestBody>(request);
  } catch {
    return errorResponse(400, "invalid_request", "Request body must be JSON");
  }

  const snapshot = body.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return errorResponse(400, "invalid_request", "Missing snapshot in body");
  }
  if (snapshot.providerId !== providerId) {
    return errorResponse(400, "invalid_provider", `Ingest only accepts ${providerId} snapshots`);
  }
  if (!snapshot.status || !VALID_STATUSES.includes(snapshot.status)) {
    return errorResponse(400, "invalid_request", "Invalid snapshot status");
  }
  if (!Array.isArray(snapshot.windows) || snapshot.windows.length === 0) {
    return errorResponse(400, "invalid_request", "Snapshot must contain at least one window");
  }
  if (!snapshot.capturedAt || typeof snapshot.capturedAt !== "string") {
    return errorResponse(400, "invalid_request", "Snapshot must include capturedAt");
  }

  const normalized: ProviderSnapshot = {
    providerId,
    providerName: snapshot.providerName ?? defaults.providerName,
    sourceUrl: snapshot.sourceUrl ?? "",
    status: snapshot.status,
    capturedAt: snapshot.capturedAt,
    summary: snapshot.summary ?? defaults.summary,
    windows: snapshot.windows,
    metrics: snapshot.metrics ?? {},
    meta: { ...(snapshot.meta ?? {}), fetchMethod: "local_ingest" },
  };

  const userId = env.SUPABASE_USER_ID ?? null;
  await persistSnapshot(env, userId, normalized, null);

  return successResponse({ capturedAt: normalized.capturedAt, providerId: normalized.providerId });
}

export async function handleIngestOpenCodeGo(request: Request, env: WorkerEnv): Promise<Response> {
  return handleProviderIngest(request, env, "opencode-go", {
    providerName: "OpenCode Go",
    summary: "OpenCode Go usage windows parsed",
  });
}

export async function handleIngestDeepSeek(request: Request, env: WorkerEnv): Promise<Response> {
  return handleProviderIngest(request, env, "deepseek", {
    providerName: "DeepSeek",
    summary: "DeepSeek usage windows parsed",
  });
}

export async function handleIngestZhipu(request: Request, env: WorkerEnv): Promise<Response> {
  return handleProviderIngest(request, env, "zhipu", {
    providerName: "智谱 BigModel",
    summary: "智谱 Coding Plan 用量已解析",
  });
}

type ChatgptIngestBody = {
  capturedAt?: string;
  // 本机浏览器会话抓到的原始响应体，解析在 Worker 侧复用 chatgpt-parser，语义与云端链路一致
  codex?: unknown;
  rateLimits?: unknown;
  subscription?: unknown;
};

// ChatGPT 本机推送（spec 第二期第 2 项）：实测 Cloudflare Worker 出口与 Browser Rendering
// 出口均被 chatgpt.com 以 403 整体拒绝（含 robots.txt），云端无法取数。
// 由 scripts/refresh-chatgpt-usage.ts 在本机浏览器会话内取数后推送原始 payload，
// 本端点用同一套解析器组装快照，避免脚本侧重复实现解析逻辑。
export async function handleIngestChatgpt(request: Request, env: WorkerEnv): Promise<Response> {
  const unauthorized = authorizeIngest(request, env);
  if (unauthorized) return unauthorized;

  let body: ChatgptIngestBody;
  try {
    body = await readJsonBody<ChatgptIngestBody>(request);
  } catch {
    return errorResponse(400, "invalid_request", "Request body must be JSON");
  }

  const hasCodex = body.codex !== undefined && body.codex !== null;
  const hasRateLimits = body.rateLimits !== undefined && body.rateLimits !== null;
  const hasSubscription = body.subscription !== undefined && body.subscription !== null;
  if (!hasCodex && !hasRateLimits && !hasSubscription) {
    return errorResponse(
      400,
      "invalid_request",
      "At least one payload is required (codex / rateLimits / subscription)",
    );
  }

  const now = new Date();
  const capturedAt =
    typeof body.capturedAt === "string" && body.capturedAt.length > 0 ? body.capturedAt : now.toISOString();

  const parsedSubscription = hasSubscription ? parseSubscriptionPayload(body.subscription) : null;
  let subscription: ChatgptSubscriptionOutcome = hasSubscription
    ? {
        attempted: true,
        plan: parsedSubscription?.plan ?? null,
        planRenewAt: parsedSubscription?.planRenewAt ?? null,
        notFound: parsedSubscription === null,
      }
    : { attempted: false, plan: null, planRenewAt: null, notFound: false };

  // 订阅端点未给出档位时用 codex/usage 顶层 plan_type 兜底（与云端链路同一语义）
  const codexPlan = hasCodex ? parseCodexPlan(body.codex) : null;
  if (subscription.plan === null && codexPlan) {
    subscription = { attempted: true, plan: codexPlan, planRenewAt: null, notFound: true };
  }

  const merged = mergeChatgptBuckets({
    codex: {
      attempted: hasCodex,
      windows: hasCodex ? parseCodexWindows(body.codex, now) : [],
      loginRequired: false,
      cfChallenge: false,
      egressBlocked: false,
      fetchFailed: false,
    },
    web: {
      attempted: hasRateLimits,
      windows: hasRateLimits ? parseWebRateLimitWindows(body.rateLimits, now) : [],
      loginRequired: false,
      cfChallenge: false,
      egressBlocked: false,
      fetchFailed: false,
    },
    subscription,
    hasCodexCredentials: hasCodex,
    hasSessionToken: hasRateLimits,
    capturedAt,
    sourceUrl: "https://chatgpt.com",
    credentialUpdate: null,
  });

  const snapshot = merged.snapshot;
  if (snapshot.windows.length === 0 && !(subscription.attempted && subscription.plan !== null)) {
    return errorResponse(400, "invalid_request", "Payloads did not yield any window or subscription plan");
  }

  const userId = env.SUPABASE_USER_ID ?? null;
  // 尽量挂到真实账号行，让看板账号子卡与回退查找走 accountId 口径；定位失败时按 source_url 兜底
  let accountId: string | null = null;
  let accountLabel: string | null = null;
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && userId) {
    try {
      const settings = await listProviderSettings(env, userId, fetch);
      const account = settings.accounts.find((item) => item.providerKey === "chatgpt");
      accountId = account?.id ?? null;
      accountLabel = account?.accountLabel ?? null;
    } catch {
      accountId = null;
      accountLabel = null;
    }
  }

  const normalized: ProviderSnapshot = {
    ...snapshot,
    meta: {
      ...snapshot.meta,
      fetchMethod: "local_ingest",
      ...(accountId ? { accountId } : {}),
      ...(accountLabel ? { accountLabel } : {}),
    },
  };

  await persistSnapshot(env, userId, normalized, null);

  return successResponse({
    providerId: normalized.providerId,
    capturedAt: normalized.capturedAt,
    status: normalized.status,
    windows: normalized.windows.length,
    plan: normalized.metrics.plan,
  });
}
