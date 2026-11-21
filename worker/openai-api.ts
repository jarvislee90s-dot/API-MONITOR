import {
  OPENAI_API_PROVIDER_ID,
  OPENAI_API_PROVIDER_NAME,
  OPENAI_API_SOURCE_URL,
  deriveOpenAiCardStatus,
  type OpenAiApiData,
  type OpenAiApiErrorCode,
  type OpenAiApiPeriod,
  type OpenAiApiSection,
  type OpenAiApiTopModel,
  type OpenAiApiUsageValue,
} from "../shared/openai-api";
import { fetchOpenAiApiData, type OpenAiApiFetchResult } from "./providers/openai-api";
import type { UsageProviderCard } from "./types";

const RESOURCE_COSTS = "costs";
const RESOURCE_USAGE = "usage";

type SnapshotEnv = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  OPENAI_API_OWNER_USER_ID?: string;
  OPENAI_ADMIN_API_KEY?: string;
};

type SnapshotRow = {
  captured_at?: string;
  created_at?: string;
  status?: string;
  payload?: {
    resource?: unknown;
    periodStart?: unknown;
    error?: unknown;
    value?: unknown;
  };
};

type StoredResult = {
  value: unknown;
  capturedAt: string;
  error?: OpenAiApiErrorCode;
};

export type OpenAiApiSnapshotView = {
  latest: StoredResult | null;
  latestSuccess: StoredResult | null;
  // POST/GET 快照读取传输失败时置位，用于上报独立的 storage_failed 状态。
  readFailed?: boolean;
};

function supabaseHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Accept: "application/json",
  };
}

function isErrorCode(value: unknown): value is OpenAiApiErrorCode {
  return (
    value === "not_configured" ||
    value === "timeout" ||
    value === "upstream_failed" ||
    value === "invalid_data" ||
    value === "storage_failed"
  );
}

function isValidTopModel(value: unknown): value is OpenAiApiTopModel {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.model === "string" &&
    Number.isSafeInteger(row.requests) &&
    Number.isSafeInteger(row.tokens) &&
    typeof row.share === "number" &&
    Number.isFinite(row.share)
  );
}

function isValidUsage(value: unknown): value is OpenAiApiUsageValue {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(row.requests) &&
    Number.isSafeInteger(row.inputTokens) &&
    Number.isSafeInteger(row.outputTokens) &&
    Array.isArray(row.topModels) &&
    row.topModels.every(isValidTopModel)
  );
}

function isValidCosts(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidValue(resource: string, value: unknown): boolean {
  return resource === RESOURCE_COSTS ? isValidCosts(value) : isValidUsage(value);
}

function canUseSnapshots(env: SnapshotEnv): boolean {
  return Boolean(
    env.OPENAI_API_OWNER_USER_ID && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

type SupabaseSnapshotEnv = SnapshotEnv & {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  OPENAI_API_OWNER_USER_ID: string;
};

function snapshotUrl(
  env: SupabaseSnapshotEnv,
  periodStart: string,
  resource: string,
  onlySuccess: boolean,
): URL {
  const url = new URL("/rest/v1/usage_snapshots", env.SUPABASE_URL);
  url.searchParams.set("select", "captured_at,payload");
  url.searchParams.set("user_id", `eq.${env.OPENAI_API_OWNER_USER_ID}`);
  url.searchParams.set("provider_key", `eq.${OPENAI_API_PROVIDER_ID}`);
  url.searchParams.set("provider_account_id", "is.null");
  // PostgREST 文本比较必须用 ->>，-> 返回 jsonb 无法与字符串精确匹配。
  url.searchParams.set("payload->>resource", `eq.${resource}`);
  url.searchParams.set("payload->>periodStart", `eq.${periodStart}`);
  if (onlySuccess) {
    url.searchParams.set("status", "eq.ready");
  }
  // 仅取需要的 1 条；排序兼顾采集时间与插入时间，避免失败记录遮蔽本期成功。
  url.searchParams.set("order", "captured_at.desc,created_at.desc");
  url.searchParams.set("limit", "1");
  return url;
}

function mapRow(row: SnapshotRow, resource: string, periodStart: string, onlySuccess: boolean): StoredResult | null {
  if (!row.payload || typeof row.payload !== "object") return null;
  if (row.payload.resource !== resource) return null;
  // 客户端再校验一次周期：PostgREST 过滤在 mock 或旧数据下可能被忽略。
  if (row.payload.periodStart !== periodStart) return null;
  if (typeof row.captured_at !== "string") return null;
  const failed = row.status === "error" || isErrorCode(row.payload.error);
  if (onlySuccess && failed) return null;
  if (failed) {
    return {
      value: null,
      capturedAt: row.captured_at,
      error: isErrorCode(row.payload.error) ? row.payload.error : "upstream_failed",
    };
  }
  const value = row.payload.value;
  return isValidValue(resource, value) ? { value, capturedAt: row.captured_at } : null;
}

// 读取某资源的最新一次尝试与最近一次成功（分别 limit 1），由调用方组合 ready/stale/unavailable。
async function readSnapshotView(
  env: SupabaseSnapshotEnv,
  periodStart: string,
  resource: string,
  fetchImpl: typeof fetch,
): Promise<OpenAiApiSnapshotView> {
  let readFailed = false;

  async function fetchFirst(onlySuccess: boolean): Promise<StoredResult | null> {
    try {
      const response = await fetchImpl(snapshotUrl(env, periodStart, resource, onlySuccess), {
        headers: supabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY),
      });
      if (!response.ok) {
        readFailed = true;
        return null;
      }
      const json = await response.json().catch(() => null);
      if (!Array.isArray(json)) {
        readFailed = true;
        return null;
      }
      const rows = json as SnapshotRow[];
      // 客户端按时间倒序，保证「最新一次」和「最近一次成功」口径稳定。
      const sorted = [...rows].sort((left, right) =>
        (right.captured_at ?? "").localeCompare(left.captured_at ?? "") ||
        (right.created_at ?? "").localeCompare(left.created_at ?? ""),
      );
      for (const row of sorted) {
        const mapped = mapRow(row, resource, periodStart, onlySuccess);
        if (mapped) return mapped;
      }
    } catch {
      // 单侧传输异常只影响该资源，另一侧继续正常返回
      readFailed = true;
    }
    return null;
  }

  const [latest, latestSuccess] = await Promise.all([
    fetchFirst(false),
    fetchFirst(true),
  ]);
  return { latest, latestSuccess, readFailed };
}

function readySection<T>(value: T, updatedAt: string): OpenAiApiSection<T> {
  return { status: "ready", updatedAt, value };
}

function unavailableSection<T>(error?: OpenAiApiErrorCode): OpenAiApiSection<T> {
  return {
    status: "unavailable",
    updatedAt: null,
    value: null,
    ...(error ? { error } : {}),
  };
}

function staleSection<T>(success: StoredResult, value: T, error?: OpenAiApiErrorCode): OpenAiApiSection<T> {
  return {
    status: "stale",
    updatedAt: success.capturedAt,
    value,
    ...(error ? { error } : {}),
  };
}

function emptyData(period: OpenAiApiPeriod): OpenAiApiData {
  return {
    period,
    costs: unavailableSection(),
    usage: unavailableSection(),
  };
}

function composeSection<T>(
  view: OpenAiApiSnapshotView,
  isValid: (value: unknown) => value is T,
): OpenAiApiSection<T> {
  const { latest, latestSuccess, readFailed } = view;
  // 读取传输失败时尽量保留同周期成功值（优先最新成功，其次 latest 中的成功），标注 storage_failed。
  if (readFailed) {
    if (latestSuccess && isValid(latestSuccess.value)) {
      return staleSection(latestSuccess, latestSuccess.value as T, "storage_failed");
    }
    if (latest && isValid(latest.value)) {
      return staleSection(
        { value: latest.value, capturedAt: latest.capturedAt, error: "storage_failed" },
        latest.value as T,
        "storage_failed",
      );
    }
    return unavailableSection<T>("storage_failed");
  }
  // 最新一次是失败：只要有本周期成功值就 stale（保留成功采集时间与错误码）。
  if (latest?.error) {
    if (latestSuccess && isValid(latestSuccess.value)) {
      return staleSection(latestSuccess, latestSuccess.value as T, latest.error);
    }
    return unavailableSection<T>(latest.error);
  }
  if (latest && isValid(latest.value)) {
    return readySection(latest.value as T, latest.capturedAt);
  }
  if (latestSuccess && isValid(latestSuccess.value)) {
    return staleSection(latestSuccess, latestSuccess.value as T);
  }
  return unavailableSection<T>();
}

// GET /api/usage：只读快照。最新失败与最近成功组合出 stale，并保留原采集时间与错误码。
export async function readOpenAiApiData(
  env: SnapshotEnv,
  period: OpenAiApiPeriod,
  fetchImpl: typeof fetch,
): Promise<OpenAiApiData | null> {
  if (!canUseSnapshots(env)) return null;

  const supabaseEnv = env as SupabaseSnapshotEnv;
  const emptyView: OpenAiApiSnapshotView = { latest: null, latestSuccess: null };
  const [costView, usageView] = await Promise.all([
    readSnapshotView(supabaseEnv, period.start, RESOURCE_COSTS, fetchImpl).catch(() => emptyView),
    readSnapshotView(supabaseEnv, period.start, RESOURCE_USAGE, fetchImpl).catch(() => emptyView),
  ]);
  return {
    period,
    costs: composeSection(costView, isValidCosts),
    usage: composeSection(usageView, isValidUsage),
  };
}

type WriteParams = {
  env: SupabaseSnapshotEnv;
  periodStart: string;
  capturedAt: string;
  resource: string;
  fetchImpl: typeof fetch;
} & ({ value: unknown } | { error: OpenAiApiErrorCode });

async function writeResource(params: WriteParams): Promise<boolean> {
  const { env, periodStart, capturedAt, resource, fetchImpl } = params;
  const failed = "error" in params;
  const row = {
    user_id: env.OPENAI_API_OWNER_USER_ID,
    provider_key: OPENAI_API_PROVIDER_ID,
    provider_account_id: null,
    captured_at: capturedAt,
    status: failed ? "error" : "ready",
    summary: `openai-api ${resource} ${failed ? params.error : "ready"}`,
    source_url: OPENAI_API_SOURCE_URL,
    payload: {
      resource,
      periodStart,
      ...(failed ? { error: params.error } : { value: params.value }),
    },
  };

  try {
    const response = await fetchImpl(new URL("/rest/v1/usage_snapshots", env.SUPABASE_URL), {
      method: "POST",
      headers: {
        ...supabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY),
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export type OpenAiApiRefreshResult = {
  data: OpenAiApiData;
  anyData: boolean;
  refreshed: boolean;
};

// 刷新：并行写两个资源（互不影响），再从快照读回组合状态，保证 GET 与 POST 口径一致。
export async function refreshOpenAiApiData(
  env: SnapshotEnv,
  now: Date,
  fetchImpl: typeof fetch,
): Promise<OpenAiApiRefreshResult | null> {
  if (!canUseSnapshots(env)) return null;

  const fetchResult = await fetchOpenAiApiData({
    now,
    fetchImpl,
    adminKey: env.OPENAI_ADMIN_API_KEY,
  });
  const { period, capturedAt } = fetchResult;
  // 周期首秒无有效区间：不写快照、不访问上游，只返回当前周期状态。
  if (!fetchResult.costs.attempted && !fetchResult.usage.attempted) {
    const stored = await readOpenAiApiData(env, period, fetchImpl);
    return {
      data: stored ?? emptyData(period),
      anyData: false,
      refreshed: false,
    };
  }
  const supabaseEnv = env as SupabaseSnapshotEnv;

  function writeSpec(resource: string): WriteParams {
    const result = resource === RESOURCE_COSTS ? fetchResult.costs : fetchResult.usage;
    const base = {
      env: supabaseEnv,
      periodStart: period.start,
      capturedAt,
      resource,
      fetchImpl,
    };
    if (result.error) return { ...base, error: result.error };
    return { ...base, value: result.value as unknown };
  }

  const [costsWritten, usageWritten] = await Promise.all([
    writeResource(writeSpec(RESOURCE_COSTS)),
    writeResource(writeSpec(RESOURCE_USAGE)),
  ]);

  const stored = await readOpenAiApiData(env, period, fetchImpl);
  // 本轮失败时直接叠加本轮错误码到同周期最近成功值，形成 stale/unavailable；
  // 写入失败叠加 storage_failed 但仍保留可显示值。
  // 尝试过取数但写入失败时优先报 storage_failed；未尝试（首秒/未配置）不计写失败。
  const costsError =
    fetchResult.costs.attempted && !costsWritten
      ? "storage_failed"
      : fetchResult.costs.error;
  const usageError =
    fetchResult.usage.attempted && !usageWritten
      ? "storage_failed"
      : fetchResult.usage.error;
  const data: OpenAiApiData = {
    period,
    costs: combineResult(
      { ...fetchResult.costs, error: costsError },
      stored?.costs,
      capturedAt,
      isValidCosts,
    ),
    usage: combineResult(
      { ...fetchResult.usage, error: usageError },
      stored?.usage,
      capturedAt,
      isValidUsage,
    ),
  };
  return {
    data,
    anyData: data.costs.value !== null || data.usage.value !== null,
    // 缺 Admin Key 时 attempted=true 用于记录 not_configured，但并非真实刷新成功。
    refreshed: Boolean(env.OPENAI_ADMIN_API_KEY) && (fetchResult.costs.attempted || fetchResult.usage.attempted),
  };
}

// 本轮结果与已存同周期结果合成：成功用本轮值，失败叠加到同周期成功值形成 stale。
function combineResult<T>(
  current: { value: T | null; error?: OpenAiApiErrorCode; attempted: boolean },
  stored: OpenAiApiSection<T> | undefined,
  capturedAt: string,
  isValid: (value: unknown) => value is T,
): OpenAiApiSection<T> {
  if (current.attempted && current.error === undefined && isValid(current.value)) {
    return readySection(current.value as T, capturedAt);
  }
  if (current.error) {
    if (stored && isValid(stored.value) && stored.updatedAt) {
      return staleSection(
        { value: stored.value, capturedAt: stored.updatedAt, error: current.error },
        stored.value,
        current.error,
      );
    }
    return unavailableSection<T>(current.error);
  }
  if (stored && isValid(stored.value) && stored.updatedAt) {
    return readySection(stored.value as T, stored.updatedAt);
  }
  return unavailableSection<T>();
}

// 节流未获许可或上游不可用时：只读快照（含 stale），不使用内存伪造 ready。
export async function readOpenAiApiDataWithCache(
  env: SnapshotEnv,
  period: OpenAiApiPeriod,
  fetchImpl: typeof fetch,
): Promise<OpenAiApiData> {
  const read = await readOpenAiApiData(env, period, fetchImpl);
  return read ?? emptyData(period);
}

export function buildOpenAiApiCard(data: OpenAiApiData, now: Date): UsageProviderCard {
  const capturedAt =
    [data.costs.updatedAt, data.usage.updatedAt]
      .filter((value): value is string => typeof value === "string")
      .sort()
      .pop() ?? now.toISOString();
  const status = deriveOpenAiCardStatus(data);
  return {
    providerId: OPENAI_API_PROVIDER_ID,
    providerName: OPENAI_API_PROVIDER_NAME,
    sourceUrl: OPENAI_API_SOURCE_URL,
    status,
    summary: `OpenAI API 组织用量 ${status}`,
    capturedAt,
    trend: [],
    windows: [],
    metrics: {},
    meta: { openaiApi: data },
    selectedAccountId: `${OPENAI_API_PROVIDER_ID}:default`,
    accounts: [],
  };
}
