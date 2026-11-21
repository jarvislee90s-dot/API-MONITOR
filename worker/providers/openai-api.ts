import {
  deriveOpenAiPeriod,
  type OpenAiApiData,
  type OpenAiApiErrorCode,
  type OpenAiApiPeriod,
  type OpenAiApiTopModel,
  type OpenAiApiUsageValue,
} from "../../shared/openai-api";

// 固定官方端点，不接受外部覆盖；不跟随跨域跳转。
const COSTS_ENDPOINT = "https://api.openai.com/v1/organization/costs";
const USAGE_ENDPOINT = "https://api.openai.com/v1/organization/usage/completions";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PAGES = 20;
const UNKNOWN_MODEL = "未知模型";

export type OpenAiApiFetchInput = {
  now: Date;
  fetchImpl?: typeof fetch;
  adminKey?: string;
  requestTimeoutMs?: number;
  maxPages?: number;
};

export type OpenAiApiResourceResult<T> = {
  value: T | null;
  error?: OpenAiApiErrorCode;
  // false 表示本轮未发起上游请求（例如周期首秒），编排层应保留缓存
  attempted: boolean;
};

export type OpenAiApiFetchResult = {
  capturedAt: string;
  period: OpenAiApiPeriod;
  costs: OpenAiApiResourceResult<number>;
  usage: OpenAiApiResourceResult<OpenAiApiUsageValue>;
};

type PageEnvelope = {
  data?: unknown;
  has_more?: unknown;
  next_page?: unknown;
};

function toUnixSeconds(value: string): number {
  return Math.floor(Date.parse(value) / 1000);
}

// 查询截至采集时刻且排他，同时不超过本周期终点。
function resolveEndUnixSeconds(now: Date, period: OpenAiApiPeriod): number {
  return Math.min(toUnixSeconds(period.end), Math.floor(now.getTime() / 1000));
}

function classifyFetchError(aborted: boolean): OpenAiApiErrorCode {
  return aborted ? "timeout" : "upstream_failed";
}

async function fetchAllPages<T>(
  endpoint: string,
  extraParams: Record<string, string>,
  adminKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  maxPages: number,
): Promise<{ pages: T[]; error?: OpenAiApiErrorCode }> {
  const base = new URL(endpoint);
  for (const [key, value] of Object.entries(extraParams)) {
    base.searchParams.set(key, value);
  }

  const pages: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  try {
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const url = new URL(base.toString());
      if (cursor) {
        url.searchParams.set("page", cursor);
      }

      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${adminKey}`,
          Accept: "application/json",
        },
        signal,
        redirect: "manual",
      } as RequestInit);

      if (!response.ok) {
        return { pages: [], error: "upstream_failed" };
      }

      const payload = (await response.json().catch(() => null)) as PageEnvelope | null;
      if (!payload || !Array.isArray(payload.data)) {
        return { pages: [], error: "invalid_data" };
      }
      pages.push(payload.data as T);

      // 官方 has_more 必须是 boolean；缺失视为无更多页。
      if (payload.has_more !== undefined && typeof payload.has_more !== "boolean") {
        return { pages: [], error: "invalid_data" };
      }
      const nextCursor = payload.next_page;
      if (nextCursor != null && typeof nextCursor !== "string") {
        return { pages: [], error: "invalid_data" };
      }
      if (payload.has_more !== true) {
        // 结束页不能同时给出续页游标。
        if (nextCursor) return { pages: [], error: "invalid_data" };
        break;
      }
      if (!nextCursor) {
        return { pages: [], error: "invalid_data" };
      }
      // 任何重复游标（含自环、回环）都视为异常，丢弃整段累计。
      if (seenCursors.has(nextCursor)) {
        return { pages: [], error: "invalid_data" };
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;

      // 页数用尽仍有下一页：数据不完整，丢弃本轮累计。
      if (pageIndex === maxPages - 1) {
        return { pages: [], error: "invalid_data" };
      }
    }
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return { pages: [], error: "timeout" };
    }
    return { pages: [], error: classifyFetchError(false) };
  }

  return { pages };
}

// 官方 bucket 形如 {start_time, end_time, results:[...]}；空 results 合法。
// 严格要求 results 数组：无 results 的裸对象不视为有效桶，避免异常结构被误判为成功。
function expandResults(bucket: unknown): unknown[] | null {
  if (!bucket || typeof bucket !== "object") return null;
  const results = (bucket as { results?: unknown }).results;
  return Array.isArray(results) ? results : null;
}

function sumCosts(pages: unknown[][]): number | null {
  let total = 0;
  for (const page of pages) {
    for (const bucket of page) {
      const results = expandResults(bucket);
      if (!results) return null;
      for (const item of results) {
        if (!item || typeof item !== "object") return null;
        const amount = (item as { amount?: unknown }).amount;
        if (!amount || typeof amount !== "object") return null;
        const { value, currency } = amount as { value?: unknown; currency?: unknown };
        if (typeof currency !== "string" || currency.toLowerCase() !== "usd") return null;
        const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
        if (!Number.isFinite(numeric)) return null;
        total += numeric;
      }
    }
  }
  // 保留原始精度，展示层按 USD 两位格式化
  return Number.isFinite(total) ? total : null;
}

type ModelAggregate = { model: string; requests: number; tokens: number };

function aggregateUsage(pages: unknown[][]): OpenAiApiUsageValue | null {
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const byModel = new Map<string, ModelAggregate>();

  for (const page of pages) {
    for (const bucket of page) {
      const results = expandResults(bucket);
      if (!results) return null;
      for (const item of results) {
        if (!item || typeof item !== "object") return null;
        const row = item as {
          model?: unknown;
          num_model_requests?: unknown;
          input_tokens?: unknown;
          output_tokens?: unknown;
        };
        if (
          !Number.isSafeInteger(row.num_model_requests) ||
          (row.num_model_requests as number) < 0 ||
          !Number.isSafeInteger(row.input_tokens) ||
          (row.input_tokens as number) < 0 ||
          !Number.isSafeInteger(row.output_tokens) ||
          (row.output_tokens as number) < 0
        ) {
          return null;
        }

        const modelName =
          typeof row.model === "string" && row.model.trim().length > 0 ? row.model : UNKNOWN_MODEL;
        const modelRequests = row.num_model_requests as number;
        const modelInput = row.input_tokens as number;
        const modelOutput = row.output_tokens as number;
        // cached_tokens 已包含在 input_tokens 内，不重复计入
        requests += modelRequests;
        inputTokens += modelInput;
        outputTokens += modelOutput;

        const existing = byModel.get(modelName) ?? { model: modelName, requests: 0, tokens: 0 };
        existing.requests += modelRequests;
        existing.tokens += modelInput + modelOutput;
        byModel.set(modelName, existing);
      }
    }
  }

  if (!Number.isSafeInteger(requests) || !Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) {
    return null;
  }

  const totalTokens = inputTokens + outputTokens;
  const topModels: OpenAiApiTopModel[] = [...byModel.values()]
    .sort((left, right) => right.tokens - left.tokens || left.model.localeCompare(right.model))
    .slice(0, 5)
    .map((item) => ({
      model: item.model,
      requests: item.requests,
      tokens: item.tokens,
      share: totalTokens > 0 ? item.tokens / totalTokens : 0,
    }));

  return { requests, inputTokens, outputTokens, topModels };
}

// 一次刷新：固定 capturedAt 与周期，两个逻辑请求并行，分别限时并独立判定成功/失败。
export async function fetchOpenAiApiData(input: OpenAiApiFetchInput): Promise<OpenAiApiFetchResult> {
  const capturedAt = input.now.toISOString();
  const period = deriveOpenAiPeriod(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const adminKey = input.adminKey;
  const timeoutMs = input.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;

  const empty: OpenAiApiFetchResult = {
    capturedAt,
    period,
    costs: { value: null, attempted: false },
    usage: { value: null, attempted: false },
  };

  if (!adminKey) {
    return {
      ...empty,
      costs: { value: null, error: "not_configured", attempted: true },
      usage: { value: null, error: "not_configured", attempted: true },
    };
  }

  const endSeconds = resolveEndUnixSeconds(input.now, period);
  const startSeconds = toUnixSeconds(period.start);
  // 周期首秒 end<=start：跳过上游，编排层保留当前周期缓存；下一秒即可刷新。
  if (endSeconds <= startSeconds) {
    return empty;
  }

  const commonParams = {
    start_time: String(startSeconds),
    end_time: String(endSeconds),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const [costResult, usageResult] = await Promise.all([
      fetchAllPages<unknown[]>(COSTS_ENDPOINT, commonParams, adminKey, fetchImpl, controller.signal, maxPages),
      fetchAllPages<unknown[]>(
        USAGE_ENDPOINT,
        { ...commonParams, group_by: "model" },
        adminKey,
        fetchImpl,
        controller.signal,
        maxPages,
      ),
    ]);

    const costsValue = costResult.error ? null : sumCosts(costResult.pages);
    const usageValue = usageResult.error ? null : aggregateUsage(usageResult.pages);

    return {
      capturedAt,
      period,
      costs: {
        value: costsValue,
        error: costResult.error ?? (costsValue === null ? "invalid_data" : undefined),
        attempted: true,
      },
      usage: {
        value: usageValue,
        error: usageResult.error ?? (usageValue === null ? "invalid_data" : undefined),
        attempted: true,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
