// OpenAI API 组织用量跨端契约：Worker 与前端共用，避免口径漂移。

export const OPENAI_API_PROVIDER_ID = "openai-api";
export const OPENAI_API_PROVIDER_NAME = "OpenAI API";
export const OPENAI_API_SOURCE_URL =
  "https://platform.openai.com/settings/organization/analytics/overview";
export const OPENAI_API_BUDGET_USD = 100;

// 固定错误码：不向前端暴露上游细节
export type OpenAiApiErrorCode =
  | "not_configured"
  | "timeout"
  | "upstream_failed"
  | "invalid_data"
  | "storage_failed";

export type OpenAiApiResourceStatus = "ready" | "stale" | "unavailable";

export type OpenAiApiTopModel = {
  model: string;
  requests: number;
  tokens: number;
  share: number;
};

export type OpenAiApiUsageValue = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  topModels: OpenAiApiTopModel[];
};

export type OpenAiApiPeriod = { start: string; end: string };

export type OpenAiApiSection<T> = {
  status: OpenAiApiResourceStatus;
  updatedAt: string | null;
  value: T | null;
  error?: OpenAiApiErrorCode;
};

export type OpenAiApiData = {
  period: OpenAiApiPeriod;
  costs: OpenAiApiSection<number>;
  usage: OpenAiApiSection<OpenAiApiUsageValue>;
};

// UTC 每月 15 日 00:00 换期：1–14 日从上月 15 日起，15 日及以后从本月 15 日起。
export function deriveOpenAiPeriod(now: Date): OpenAiApiPeriod {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  let startYear = year;
  let startMonth = month;
  if (day < 15) {
    startMonth -= 1;
    if (startMonth < 0) {
      startMonth = 11;
      startYear -= 1;
    }
  }
  const start = new Date(Date.UTC(startYear, startMonth, 15, 0, 0, 0, 0));
  const endYear = startMonth === 11 ? startYear + 1 : startYear;
  const end = new Date(Date.UTC(endYear, (startMonth + 1) % 12, 15, 0, 0, 0, 0));
  return { start: start.toISOString(), end: end.toISOString() };
}

// 采集时刻是否产生有效查询区间：周期首秒 end<=start 时无有效范围。
export function hasValidOpenAiQueryRange(now: Date, period: OpenAiApiPeriod): boolean {
  const endSeconds = Math.min(Math.floor(Date.parse(period.end) / 1000), Math.floor(now.getTime() / 1000));
  const startSeconds = Math.floor(Date.parse(period.start) / 1000);
  return endSeconds > startSeconds;
}

// 卡片状态：两区 ready 才 ready；至少一区有可显示数值为 partial；否则 error。
export function deriveOpenAiCardStatus(
  data: OpenAiApiData,
): "ready" | "partial" | "error" {
  if (data.costs.status === "ready" && data.usage.status === "ready") return "ready";
  if (data.costs.value !== null || data.usage.value !== null) return "partial";
  return "error";
}
