import { errorResponse, jsonResponse, readJsonBody, successResponse, toIsoString } from "./http";
import { buildUsageDashboard } from "./dashboard";
import { createLiveLoginSession } from "./browser/live-login";
import { listProviders, getProvider, isProviderId } from "./providers/registry";
import { RefreshSessionDurableObject } from "./durable-object/refresh-session";
import { handleSettingsRequest } from "./settings/routes";
import { getActiveProviderAccountConfig } from "./settings/repository";
import type {
  ProviderFetchInput,
  ProviderSnapshot,
  RefreshDecision,
  WorkerEnv,
  UsageDashboard,
} from "./types";

type RefreshRequest = {
  providerId?: string;
  sessionKey?: string;
  accountId?: string;
  persist?: boolean;
};

type LiveLoginRequest = {
  provider?: string;
  loginUrl?: string;
};

function createSessionKey(providerId: string, accountId?: string): string {
  return accountId ? `${providerId}:${accountId}` : providerId;
}

function buildProviderConfig(env: WorkerEnv, providerId: string): Record<string, unknown> {
  if (providerId === "openrouter") {
    return {
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: env.OPENROUTER_BASE_URL,
    };
  }

  if (providerId === "opencode-go") {
    return {
      workspaceId: env.OPENCODE_GO_WORKSPACE_ID,
      authCookie: env.OPENCODE_GO_AUTH_COOKIE,
      baseUrl: env.OPENCODE_GO_BASE_URL,
    };
  }

  return {
    pageUrl: env.XFYUN_MAAS_PAGE_URL,
    apiUrl: env.XFYUN_MAAS_API_URL,
    authCookie: env.XFYUN_MAAS_AUTH_COOKIE,
  };
}

async function buildProviderConfigs(env: WorkerEnv, fetchImpl: typeof fetch): Promise<Array<{ providerId: string; config: Record<string, unknown> }>> {
  const configs: Array<{ providerId: string; config: Record<string, unknown> }> = [];
  
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_USER_ID) {
    // 回退到 env 配置
    for (const provider of listProviders()) {
      configs.push({ providerId: provider.id, config: buildProviderConfig(env, provider.id) });
    }
    return configs;
  }

  // 尝试从 Supabase 读取配置
  for (const provider of listProviders()) {
    try {
      const dbConfig = await getActiveProviderAccountConfig(env, provider.id, fetchImpl);
      if (dbConfig) {
        configs.push({ providerId: provider.id, config: dbConfig });
      } else {
        configs.push({ providerId: provider.id, config: buildProviderConfig(env, provider.id) });
      }
    } catch {
      configs.push({ providerId: provider.id, config: buildProviderConfig(env, provider.id) });
    }
  }

  return configs;
}

function createErrorSnapshot(providerId: string, providerName: string, sourceUrl: string, now: Date, error: string): ProviderSnapshot {
  return {
    providerId: providerId as ProviderSnapshot["providerId"],
    providerName,
    sourceUrl,
    status: "error",
    capturedAt: toIsoString(now),
    summary: error,
    windows: [],
    metrics: {
      error,
    },
    meta: {},
  };
}

function withFallbackSummary(summary: string): string {
  const marker = "（使用最近成功快照）";
  return `${summary.replaceAll(marker, "")}${marker}`;
}

async function fetchProviderSnapshot(env: WorkerEnv, providerId: string, configOverride?: Record<string, unknown>): Promise<ProviderSnapshot> {
  const provider = getProvider(providerId);
  if (!provider) {
    return createErrorSnapshot(providerId, providerId, "", new Date(), `Unknown provider: ${providerId}`);
  }

  const now = new Date();
  const fetchInput: ProviderFetchInput = {
    now,
    fetchImpl: fetch,
    config: configOverride ?? buildProviderConfig(env, providerId),
  };
  if (providerId === "opencode-go") {
    fetchInput.requestTimeoutMs = 15_000;
  }

  try {
    const result = await provider.fetchSnapshot(fetchInput);
    return result.snapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown provider error";
    return createErrorSnapshot(provider.id, provider.name, provider.sourceUrl, now, message);
  }
}

async function collectUsageSnapshots(env: WorkerEnv, providerId?: string): Promise<ProviderSnapshot[]> {
  const configs = await buildProviderConfigs(env, fetch);
  const configMap = new Map(configs.map((c) => [c.providerId, c.config]));
  
  const providers = providerId
    ? listProviders().filter((provider) => provider.id === providerId)
    : listProviders();
  const snapshots: ProviderSnapshot[] = [];
  for (const provider of providers) {
    const config = configMap.get(provider.id);
    snapshots.push(await fetchProviderSnapshot(env, provider.id, config));
  }
  return snapshots;
}

async function fetchLatestReadySnapshots(env: WorkerEnv): Promise<Map<string, ProviderSnapshot>> {
  const snapshots = new Map<string, ProviderSnapshot>();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_USER_ID) {
    return snapshots;
  }

  const url = new URL("/rest/v1/usage_snapshots", env.SUPABASE_URL);
  url.searchParams.set("select", "provider_key,payload,created_at");
  url.searchParams.set("user_id", `eq.${env.SUPABASE_USER_ID}`);
  url.searchParams.set("status", "eq.ready");
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "20");

  const response = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    return snapshots;
  }

  const rows = (await response.json().catch(() => [])) as Array<{
    provider_key?: string;
    payload?: ProviderSnapshot;
  }>;
  for (const row of rows) {
    if (!row.provider_key || snapshots.has(row.provider_key)) continue;
    if (row.payload?.status === "ready") {
      snapshots.set(row.provider_key, row.payload);
    }
  }

  return snapshots;
}

async function applyLatestReadyFallback(env: WorkerEnv, snapshots: ProviderSnapshot[]): Promise<ProviderSnapshot[]> {
  if (snapshots.every((snapshot) => snapshot.status === "ready" && snapshot.windows.length > 0)) {
    return snapshots;
  }

  const latestReadySnapshots = await fetchLatestReadySnapshots(env);
  if (latestReadySnapshots.size === 0) {
    return snapshots;
  }

  return snapshots.map((snapshot) => {
    const fallback = latestReadySnapshots.get(snapshot.providerId);
    if (!fallback) return snapshot;
    if (snapshot.status === "ready" && snapshot.windows.length > 0) return snapshot;
    return {
      ...fallback,
      summary: withFallbackSummary(fallback.summary),
      meta: {
        ...fallback.meta,
        fallbackFrom: snapshot.summary,
      },
    };
  });
}

async function persistSnapshot(env: WorkerEnv, snapshot: ProviderSnapshot, decision: RefreshDecision | null): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_USER_ID) return;

  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };
  const upsertHeaders = {
    ...headers,
    Prefer: "resolution=merge-duplicates,return=minimal",
  };

  const providerAccountsRow = {
    user_id: env.SUPABASE_USER_ID,
    provider_key: snapshot.providerId,
    display_name: snapshot.providerName,
    source_url: snapshot.sourceUrl,
    auth_mode: snapshot.status,
    status: snapshot.status,
    status_message: snapshot.summary,
    config: snapshot.meta,
    last_refresh_at: snapshot.capturedAt,
  };

  const usageSnapshotsRow = {
    user_id: env.SUPABASE_USER_ID,
    provider_key: snapshot.providerId,
    captured_at: snapshot.capturedAt,
    status: snapshot.status,
    summary: snapshot.summary,
    source_url: snapshot.sourceUrl,
    payload: snapshot,
  };

  const quotaWindowRows = snapshot.windows.map((window) => ({
    user_id: env.SUPABASE_USER_ID,
    provider_key: snapshot.providerId,
    window_key: window.key,
    window_label: window.label,
    used_value: window.used ?? null,
    limit_value: window.limit ?? null,
    remaining_value: window.remaining ?? null,
    percent_used: window.percentUsed ?? null,
    percent_remaining: window.percentRemaining ?? null,
    reset_at: window.resetAt ?? null,
  }));

  if (decision) {
    const refreshEventsRow = {
      user_id: env.SUPABASE_USER_ID,
      provider_key: snapshot.providerId,
      session_key: decision.session.sessionKey,
      event_type: decision.allowed ? "refresh_allowed" : "refresh_blocked",
      status: decision.reason,
      message: snapshot.summary,
      details: {
        nextAllowedAt: decision.nextAllowedAt,
      },
      requested_at: snapshot.capturedAt,
      started_at: snapshot.capturedAt,
      finished_at: snapshot.capturedAt,
    };

    await fetch(new URL("/rest/v1/refresh_events", env.SUPABASE_URL), {
      method: "POST",
      headers,
      body: JSON.stringify(refreshEventsRow),
    });
  }

  await Promise.all([
    fetch(
      new URL(
        "/rest/v1/provider_accounts?on_conflict=user_id%2Cprovider_key%2Csource_url",
        env.SUPABASE_URL,
      ),
      {
      method: "POST",
      headers: upsertHeaders,
      body: JSON.stringify(providerAccountsRow),
      },
    ),
    fetch(new URL("/rest/v1/usage_snapshots", env.SUPABASE_URL), {
      method: "POST",
      headers,
      body: JSON.stringify(usageSnapshotsRow),
    }),
    ...(quotaWindowRows.length > 0
      ? [
          fetch(new URL("/rest/v1/quota_windows", env.SUPABASE_URL), {
            method: "POST",
            headers,
            body: JSON.stringify(quotaWindowRows),
          }),
        ]
      : []),
  ]);
}

async function handleProviders(): Promise<Response> {
  return successResponse(
    listProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      sourceUrl: provider.sourceUrl,
      description: provider.description,
    })),
  );
}

async function handleProviderSnapshot(request: Request, providerId: string, env: WorkerEnv): Promise<Response> {
  const provider = getProvider(providerId);
  if (!provider) {
    return errorResponse(404, "provider_not_found", `Unknown provider: ${providerId}`);
  }

  const now = new Date();
  const fetchInput: ProviderFetchInput = {
    now,
    fetchImpl: fetch,
    config: buildProviderConfig(env, providerId),
  };
  if (providerId === "opencode-go") {
    fetchInput.requestTimeoutMs = 15_000;
  }
  const snapshot = await provider.fetchSnapshot(fetchInput);

  if (request.headers.get("x-api-monitor-persist") === "1") {
    await persistSnapshot(env, snapshot.snapshot, null);
  }

  return successResponse(snapshot);
}

async function handleUsage(env: WorkerEnv): Promise<Response> {
  const snapshots = await applyLatestReadyFallback(env, await collectUsageSnapshots(env));
  const dashboard = buildUsageDashboard(snapshots);
  return successResponse(dashboard);
}

async function handleDashboardRefresh(request: Request, env: WorkerEnv, body: RefreshRequest): Promise<Response> {
  const sessionKey = body.sessionKey ?? "dashboard";
  const sessionId = env.REFRESH_SESSION.idFromName(sessionKey);
  const sessionStub = env.REFRESH_SESSION.get(sessionId);
  const decisionResponse = await sessionStub.fetch(
    new Request(`https://refresh-session.local/decide?sessionKey=${encodeURIComponent(sessionKey)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionKey }),
    }),
  );
  const decisionPayload = (await decisionResponse.json()) as { ok: boolean; data?: RefreshDecision };
  const decision = decisionPayload.data ?? null;
  const shouldPersist = body.persist !== false && Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && env.SUPABASE_USER_ID);
  const snapshots = await applyLatestReadyFallback(env, await collectUsageSnapshots(env));

  if (shouldPersist && decision?.allowed) {
    for (const snapshot of snapshots) {
      await persistSnapshot(env, snapshot, decision);
    }
  }

  const dashboard = buildUsageDashboard(snapshots, {
    refresh: {
      scope: "all",
      sessionKey,
      refreshed: Boolean(decision?.allowed),
      reason: decision?.reason,
      nextAllowedAt: decision?.nextAllowedAt,
    },
  });

  return successResponse(dashboard);
}

async function handleRefresh(request: Request, env: WorkerEnv): Promise<Response> {
  const body = await readJsonBody<RefreshRequest>(request).catch(() => ({} as RefreshRequest));

  if (!body.providerId) {
    return handleDashboardRefresh(request, env, body);
  }

  if (!isProviderId(body.providerId)) {
    return errorResponse(404, "provider_not_found", `Unknown provider: ${body.providerId}`);
  }

  const provider = getProvider(body.providerId);
  if (!provider) {
    return errorResponse(404, "provider_not_found", `Unknown provider: ${body.providerId}`);
  }

  const sessionKey = body.sessionKey ?? createSessionKey(body.providerId, body.accountId);
  const sessionId = env.REFRESH_SESSION.idFromName(sessionKey);
  const sessionStub = env.REFRESH_SESSION.get(sessionId);
  const decisionResponse = await sessionStub.fetch(
    new Request(`https://refresh-session.local/decide?sessionKey=${encodeURIComponent(sessionKey)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionKey }),
    }),
  );
  const decisionPayload = (await decisionResponse.json()) as { ok: boolean; data?: RefreshDecision };
  const decision = decisionPayload.data ?? null;

  if (!decision?.allowed) {
    return successResponse({
      providerId: body.providerId,
      sessionKey,
      refreshed: false,
      decision,
      snapshot: null,
    });
  }

  const fetchInput: ProviderFetchInput = {
    now: new Date(),
    fetchImpl: fetch,
    config: buildProviderConfig(env, body.providerId),
  };
  if (body.providerId === "opencode-go") {
    fetchInput.requestTimeoutMs = 15_000;
  }
  const snapshotResult = await provider.fetchSnapshot(fetchInput);

  if (body.persist !== false) {
    await persistSnapshot(env, snapshotResult.snapshot, decision);
  }

  return successResponse({
    providerId: body.providerId,
    sessionKey,
    refreshed: true,
    decision,
    snapshot: snapshotResult,
  });
}

async function handleSession(request: Request, env: WorkerEnv, sessionKey: string): Promise<Response> {
  const sessionId = env.REFRESH_SESSION.idFromName(sessionKey);
  const sessionStub = env.REFRESH_SESSION.get(sessionId);
  const path = new URL(request.url).pathname.replace(`/api/session/${sessionKey}`, "");
  const targetPath = path === "" ? "/state" : path;
  const response = await sessionStub.fetch(
    new Request(`https://refresh-session.local${targetPath}?sessionKey=${encodeURIComponent(sessionKey)}`, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.clone().text(),
    }),
  );
  return response;
}

async function handleLiveLogin(request: Request): Promise<Response> {
  const body = await readJsonBody<LiveLoginRequest>(request).catch(
    () => ({} as LiveLoginRequest),
  );
  if (!body.provider || !body.loginUrl) {
    return errorResponse(400, "invalid_request", "provider and loginUrl are required");
  }

  try {
    return successResponse(
      createLiveLoginSession({
        provider: isProviderId(body.provider) ? body.provider : "custom",
        loginUrl: body.loginUrl,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid live login request";
    return errorResponse(400, "invalid_request", message);
  }
}

export async function handleApiRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/settings/")) {
    return handleSettingsRequest(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    return successResponse({
      service: "ApiMonitor",
      status: "ok",
      timestamp: toIsoString(new Date()),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/providers") {
    return handleProviders();
  }

  if (request.method === "GET" && url.pathname === "/api/usage") {
    return handleUsage(env);
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/providers/") && url.pathname.endsWith("/snapshot")) {
    const providerId = url.pathname.split("/")[3] ?? "";
    return handleProviderSnapshot(request, providerId, env);
  }

  if (request.method === "POST" && url.pathname === "/api/refresh") {
    return handleRefresh(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/session/live-login") {
    return handleLiveLogin(request);
  }

  if (url.pathname.startsWith("/api/session/")) {
    const sessionKey = decodeURIComponent(url.pathname.slice("/api/session/".length));
    if (!sessionKey) {
      return errorResponse(400, "invalid_request", "sessionKey is required");
    }
    return handleSession(request, env, sessionKey);
  }

  return errorResponse(404, "not_found", "Unknown API route");
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      return await handleApiRequest(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown worker error";
      return errorResponse(500, "worker_error", message);
    }
  },
};

export { RefreshSessionDurableObject };
