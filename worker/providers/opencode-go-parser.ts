import type { ProviderWindow } from "../types";

export type OpenCodeGoWindowKey = "rolling" | "weekly" | "monthly";

// opencode 新版控制台（/console/<workspaceId>/go）的用量接口返回结构。
// 只声明用到的字段，其余字段忽略。
export type OpenCodeGoMeter = {
  startsAt?: string | null;
  resetsAt?: string | null;
  limitMicroCents?: string | number | null;
  usedMicroCents?: string | number | null;
};

export type OpenCodeGoStatusPayload = {
  product?: string;
  access?: {
    startsAt?: string | null;
    endsAt?: string | null;
    meters?: {
      fiveHour?: OpenCodeGoMeter | null;
      week?: OpenCodeGoMeter | null;
      month?: OpenCodeGoMeter | null;
    } | null;
  } | null;
};

// /console/api/activity/go（2026-11-22 实测，顶层 startsAt + daily + models）。
// 数值字段在接口里是十进制字符串，避免超过 Number 精度的场景由调用方统一校验。
export type OpenCodeGoDailyRow = {
  date?: string | null;
  totalCostMicroCents?: string | number | null;
  totalTokens?: string | number | null;
  totalRequests?: string | number | null;
};

export type OpenCodeGoModelRow = {
  provider?: string | null;
  model?: string | null;
  totalRequests?: string | number | null;
};

export type OpenCodeGoActivityPayload = {
  startsAt?: string | null;
  daily?: OpenCodeGoDailyRow[] | null;
  models?: OpenCodeGoModelRow[] | null;
};

export type OpenCodeGoTopModel = {
  model: string;
  requests: number;
  share: number;
};

export type OpenCodeGoActivity = {
  startsAt: string | null;
  // daily 汇总：字段缺失或任一行非法导致无法给出精确总量时为 null（与真实 0 区分）
  totalRequests: number | null;
  totalTokens: number | null;
  // 模型明细：缺失/任一行非法/超过日汇总请求数时整体为 null，不输出残缺 Top5
  topModels: OpenCodeGoTopModel[] | null;
  dailyDays: number;
};

export type OpenCodeGoActivityResolution = {
  activity: OpenCodeGoActivity | null;
  warning: string | null;
};

function toBeijingOffsetIso(date: Date): string {
  const beijingDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return beijingDate.toISOString().replace(/\.\d{3}Z$/, "+08:00");
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toWindow(
  key: OpenCodeGoWindowKey,
  label: string,
  meter: OpenCodeGoMeter | null | undefined,
): ProviderWindow | null {
  const limit = Number(meter?.limitMicroCents);
  const used = Number(meter?.usedMicroCents);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) {
    return null;
  }

  // 接口给的是 microCents（1e-6 美元），这里换算成百分比，
  // 与旧窗口语义保持一致（used=百分比、limit=100），前端无需改动。
  const percentUsed = round2(Math.min(100, Math.max(0, (used / limit) * 100)));
  const percentRemaining = round2(100 - percentUsed);
  const resetsAt = typeof meter?.resetsAt === "string" ? new Date(meter.resetsAt) : null;

  return {
    key,
    label,
    used: percentUsed,
    limit: 100,
    remaining: percentRemaining,
    percentUsed,
    percentRemaining,
    resetAt: resetsAt && !Number.isNaN(resetsAt.getTime()) ? toBeijingOffsetIso(resetsAt) : null,
  };
}

// 接口数值是十进制字符串；仅接受 number 或纯数字字符串（不允许空白/符号/小数/科学计数），
// boolean、对象、数组、空串一律非法；结果必须落在非负安全整数内。
function toNonNegativeSafeInt(value: unknown): number | null {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^\d+$/.test(value)) {
    parsed = Number(value);
  } else {
    return null;
  }
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function parseInstant(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 汇总单一 daily 字段：要求每一行都给出非负安全整数，任一缺失/非法即整字段返回 null，
// 避免用不完整行冒充精确总量；空数组是合法的零（周期已开始但尚无请求）。
function sumDailyField(rows: OpenCodeGoDailyRow[], field: "totalRequests" | "totalTokens"): number | null {
  if (rows.length === 0) return 0;
  let sum = 0;
  for (const row of rows) {
    const value = toNonNegativeSafeInt(row?.[field]);
    if (value === null) return null;
    sum += value;
    // 累加溢出安全整数范围后不再是精确值，宁可不报
    if (!Number.isSafeInteger(sum)) return null;
  }
  return sum;
}

// 解析 /console/api/activity/go。
// - daily 不是数组 → 整个 Activity 视为无效（返回 null）
// - 汇总字段独立累计，模型列表与汇总字段解耦：任一模型行非法或模型请求总数
//   超过 daily 请求总数时，模型表整体置 null，绝不输出残缺 Top5 或超 100% 占比
export function parseOpenCodeGoActivity(
  payload: OpenCodeGoActivityPayload | null | undefined,
): OpenCodeGoActivity | null {
  if (!isRecord(payload) || !Array.isArray(payload.daily)) return null;
  // Activity 必须自带有效周期起点，否则无法与额度周期对账，整体视为不可用
  if (parseInstant(payload.startsAt) === null) return null;

  const rows = payload.daily as OpenCodeGoDailyRow[];
  const totalRequests = sumDailyField(rows, "totalRequests");
  const totalTokens = sumDailyField(rows, "totalTokens");

  let topModels: OpenCodeGoTopModel[] | null = null;
  const models = payload.models;
  if (totalRequests !== null && totalRequests > 0 && Array.isArray(models)) {
    const parsed: OpenCodeGoTopModel[] = [];
    let invalid = false;
    for (const raw of models) {
      if (!isRecord(raw)) {
        invalid = true;
        break;
      }
      const model = typeof raw.model === "string" && raw.model.trim() !== "" ? raw.model : null;
      const requests = toNonNegativeSafeInt(raw.totalRequests);
      if (model === null || requests === null) {
        invalid = true;
        break;
      }
      parsed.push({ model, requests, share: requests / totalRequests });
    }
    if (!invalid) {
      const modelSum = parsed.reduce((sum, row) => sum + row.requests, 0);
      // 模型总和可能因上报竞态略小于 daily 总量，但超过即为脏数据，宁可整表省略
      if (modelSum <= totalRequests) {
        topModels = parsed
          .sort((left, right) =>
            right.requests !== left.requests
              ? right.requests - left.requests
              : left.model < right.model
                ? -1
                : left.model > right.model
                  ? 1
                  : 0,
          )
          .slice(0, 5);
      }
    }
  } else if (totalRequests === 0 && Array.isArray(models)) {
    // 明确零请求：空模型表合法；任何非零模型行都与日汇总矛盾，整表省略
    topModels = models.length === 0 ? [] : null;
  }

  return {
    startsAt: typeof payload.startsAt === "string" && parseInstant(payload.startsAt) !== null
      ? payload.startsAt
      : null,
    totalRequests,
    totalTokens,
    topModels,
    dailyDays: rows.length,
  };
}

// 跨期校验：status.access.startsAt 与 activity.startsAt 都可用时按时刻严格比对；
// status 缺失 startsAt 时保留 Activity（不能把「无法校验」误报成「本期为 0」）。
export function resolveOpenCodeGoActivity(
  status: OpenCodeGoStatusPayload | null | undefined,
  activity: OpenCodeGoActivity | null,
): OpenCodeGoActivityResolution {
  if (!activity) return { activity: null, warning: null };

  // 实测 status.access.startsAt 与 Activity startsAt 一致，优先用它；
  // 仅当 access.startsAt 缺失时退回月额度窗口的 startsAt（若接口将来补上该字段）。
  const statusStartMs =
    parseInstant(status?.access?.startsAt) ?? parseInstant(status?.access?.meters?.month?.startsAt);
  const activityStartMs = parseInstant(activity.startsAt);
  // status 未提供周期起点时不丢弃 Activity：无法校验不等于本期为零
  if (statusStartMs !== null && activityStartMs !== null && statusStartMs !== activityStartMs) {
    return {
      activity: null,
      warning: "OpenCode Activity 周期与额度周期不一致，已省略本期统计",
    };
  }
  return { activity, warning: null };
}

// 输出可并入快照 metrics 的 Activity 字段；缺失字段不写入，保证前端能区分零与缺失。
// topModels 序列化为 JSON 字符串（与 Command Code 的 metrics.topModels 口径一致）。
export function toOpenCodeGoActivityMetrics(
  activity: OpenCodeGoActivity | null,
): Record<string, number | string | null> {
  if (!activity) return {};
  const metrics: Record<string, number | string | null> = {};
  if (activity.totalRequests !== null) metrics.totalRequests = activity.totalRequests;
  if (activity.totalTokens !== null) metrics.totalTokens = activity.totalTokens;
  if (activity.topModels !== null) metrics.topModels = JSON.stringify(activity.topModels);
  if (activity.startsAt !== null) metrics.activityStartsAt = activity.startsAt;
  return metrics;
}

// 从 /console/api/go/status 的 JSON 解析三个用量窗口；缺失的窗口直接跳过。
export function parseOpenCodeGoStatus(payload: OpenCodeGoStatusPayload | null | undefined): ProviderWindow[] {
  const meters = payload?.access?.meters;
  if (!meters) return [];

  return [
    toWindow("rolling", "5h", meters.fiveHour),
    toWindow("weekly", "Weekly", meters.week),
    toWindow("monthly", "Monthly", meters.month),
  ].filter((window): window is ProviderWindow => window !== null);
}
