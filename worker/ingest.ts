import { errorResponse, readJsonBody, successResponse } from "./http";
import { persistSnapshot } from "./index";
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

async function handleProviderIngest(
  request: Request,
  env: WorkerEnv,
  providerId: ProviderId,
  defaults: IngestDefaults,
): Promise<Response> {
  const expectedKey = env.INGEST_API_KEY;
  if (!expectedKey) {
    return errorResponse(503, "ingest_disabled", "Ingest endpoint is not configured");
  }
  const providedKey = request.headers.get("x-ingest-key") ?? "";
  if (!timingSafeEqual(providedKey, expectedKey)) {
    return errorResponse(401, "unauthorized", "Invalid ingest key");
  }

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
