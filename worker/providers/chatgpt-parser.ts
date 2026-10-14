import { clampNumber } from "../http";
import type { ProviderWindow } from "../types";

// chatgpt 纯解析与取值工具（从 chatgpt.ts 拆出，先例：opencode-go-parser.ts）。
// 此模块不发起网络请求、不触碰凭据，仅做 payload → ProviderWindow 的宽容解析。

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

// used/limit 数量形态 → 百分比（一位小数）；任一缺失或 limit<=0 时返回 null。
// codex 窗口、网页分组窗口与 message_cap 旧形态三处共用，收敛各自手写的换算
function percentFromUsage(
  source: Record<string, unknown>,
  usedKeys: string[],
  limitKeys: string[],
): number | null {
  const used = pickNumber(source, usedKeys);
  const limit = pickNumber(source, limitKeys);
  if (used === null || limit === null || limit <= 0) return null;
  return Math.round((used / limit) * 1000) / 10;
}

// 重置时间：优先 ISO 字段，其次"剩余秒数 + now"推算。
// 实测 codex/usage 的 reset_at 是 Unix 秒时间戳（数字），一并兼容（>1e12 视为毫秒）
function pickResetAt(source: Record<string, unknown>, now: Date): string | null {
  for (const key of ["reset_at", "resets_at", "resetAt", "resetsAt", "reset_time"]) {
    const raw = source[key];
    if (typeof raw === "string" && raw.length > 0) {
      const date = new Date(raw);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 1e9) {
      const ms = raw > 1e12 ? raw : raw * 1000;
      return new Date(ms).toISOString();
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

// 按窗口时长推 label：免费档主窗口实测为 30 天（limit_window_seconds=2592000），
// Plus/Pro 为 5 小时 + 周；不写死「5小时/每周」避免档位错标
function codexWindowLabel(source: Record<string, unknown>, isFiveHour: boolean): string {
  const seconds = pickNumber(source, ["limit_window_seconds", "window_seconds", "window_limit_seconds"]);
  if (seconds !== null && seconds > 0) {
    if (seconds <= 6 * 3600) return "Codex 5小时";
    if (seconds >= 20 * 86400) return "Codex 30天";
    return "Codex 每周";
  }
  return isFiveHour ? "Codex 5小时" : "Codex 每周";
}

// 提取 codex/usage 顶层的 plan_type（实测免费档返回 "free"，省去单独订阅端点调用）
export function parseCodexPlan(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const plan = (payload as { plan_type?: unknown }).plan_type;
  return typeof plan === "string" && plan.length > 0 ? plan.toLowerCase() : null;
}

// 宽容解析 codex 用量：根对象、rate_limits 或 rate_limit（实测单数）键下，
// 键名含 5h/primary/session → codex_5h，含 week/secondary/7d → codex_weekly（spec §2）
export function parseCodexWindows(payload: unknown, now: Date): ProviderWindow[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const withWrapper = payload as { rate_limits?: unknown; rate_limit?: unknown };
  const container = (withWrapper.rate_limits ?? withWrapper.rate_limit ?? payload) as Record<
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

    const percentUsed =
      toPercentValue(
        pickNumber(source, [
          "used_percent",
          "used_pct",
          "usage_percent",
          "usagePercent",
          "percent_used",
          "percentUsed",
          "usage",
        ]),
      ) ??
      percentFromUsage(
        source,
        ["used", "used_requests", "requests_used", "count"],
        ["limit", "total", "max", "capacity"],
      );
    const resetAt = pickResetAt(source, now);
    if (percentUsed === null && resetAt === null) continue;

    windows.push(
      buildPercentWindow({
        key,
        label: codexWindowLabel(source, isFiveHour),
        percentUsed,
        resetAt,
      }),
    );
  }
  return windows;
}

// 已知包装键：值可为对象或数组，命中则剥一层再递归解析，防一层包装导致静默 0 窗口
const WEB_WRAPPER_KEYS = ["rate_limits", "groups", "limits"];

// 网页对话额度宽容解析：旧 message_cap 键值形态 + 新分组形态（数组或对象），组名透传不枚举（spec §2）
export function parseWebRateLimitWindows(payload: unknown, now: Date): ProviderWindow[] {
  const windows: ProviderWindow[] = [];
  const seenKeys = new Set<string>();

  // slug 统一小写归一，避免 GPT_5X 与 gpt_5x 产出重复窗口
  const pushGroupWindow = (params: { slug: string; source: Record<string, unknown> }) => {
    const slug = params.slug.toLowerCase();
    const key = `web_5h_${slug}`;
    if (seenKeys.has(key)) return;
    const percentUsed =
      toPercentValue(
        pickNumber(params.source, [
          "used_percent",
          "used_pct",
          "percent_used",
          "percentUsed",
          "usage",
        ]),
      ) ??
      percentFromUsage(
        params.source,
        ["used", "used_messages", "requests"],
        ["max_cap", "limit", "total", "window_limit"],
      );
    const resetAt = pickResetAt(params.source, now);
    if (percentUsed === null && resetAt === null) return;
    seenKeys.add(key);
    windows.push(
      buildPercentWindow({
        key,
        label: `对话 5小时·${slug}`,
        percentUsed,
        resetAt,
      }),
    );
  };

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;

    // wrapper 解包：{ rate_limits: {...} } / { groups: [...] } / { limits: {...} } 先剥一层递归；
    // 解包后无窗口则继续按原对象处理，不改变旧形态行为
    for (const wrapperKey of WEB_WRAPPER_KEYS) {
      const wrapped = record[wrapperKey];
      if (wrapped && typeof wrapped === "object") {
        const unwrapped = parseWebRateLimitWindows(wrapped, now);
        if (unwrapped.length > 0) return unwrapped;
      }
    }

    for (const [key, value] of Object.entries(record)) {
      // 旧形态：[<slug>_]message_cap = { max_cap, remaining_cap, reset_at }；裸 message_cap 即 default 桶
      const messageCapMatch = /^(?:([a-z0-9_]+)_)?message_cap$/i.exec(key);
      if (messageCapMatch && value && typeof value === "object") {
        const source = value as Record<string, unknown>;
        const max = pickNumber(source, ["max_cap", "max", "limit"]);
        const remaining = pickNumber(source, ["remaining_cap", "remaining", "remaining_messages"]);
        if (max === null || max <= 0) continue;
        const used = remaining !== null ? Math.max(0, max - remaining) : null;
        const percentUsed = percentFromUsage({ used, limit: max }, ["used"], ["limit"]);
        const resetAt = pickResetAt(source, now);
        if (percentUsed === null && resetAt === null) continue;
        const slug = (messageCapMatch[1] ?? "default").toLowerCase();
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
    for (const [key, value] of Object.entries(record)) {
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
