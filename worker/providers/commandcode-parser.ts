import type { ProviderWindow } from "../types";

// Command Code 新版控制台（api.commandcode.ai）用量接口结构（2026-10-30 实测）
export type CommandCodeSummary = {
  totalCount?: number;
  totalCost?: number;
  totalTokens?: number;
  totalTokensIn?: number;
  totalTokensOut?: number;
  totalCredits?: number;
  periodBasis?: string;
  periodStart?: string;
  daily?: Array<{ date?: string; tokens?: number; requests?: number }>;
};

export type CommandCodeModelUsage = {
  model?: string;
  requests?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokensTotal?: number;
  creditsTotal?: number;
};

export type CommandCodeByModel = {
  success?: boolean;
  data?: CommandCodeModelUsage[];
  window?: { from?: string; to?: string; periodBasis?: string };
};

export type CommandCodeCredits = {
  credits?: {
    monthlyCredits?: number;
    monthlyCreditsGranted?: number;
    purchasedCredits?: number;
  };
  windowLimits?: {
    fiveHour?: { used?: number; cap?: number; resetAt?: number };
    weekly?: { used?: number; cap?: number; resetAt?: number };
  };
};

export type CommandCodeTopModel = {
  model: string;
  requests: number;
  tokens: number;
  share: number;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampPercent(value: number): number {
  return round2(Math.min(100, Math.max(0, value)));
}

function toIsoFromMs(value: unknown): string | null {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

// 计费周期结束 = periodStart + 1 个自然月
function nextBillingReset(periodStart: string | undefined): string | null {
  if (!periodStart) return null;
  const start = new Date(periodStart);
  if (Number.isNaN(start.getTime())) return null;
  const next = new Date(start);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString();
}

// 三个额度窗口：5 小时 / 每周来自 windowLimits，每月来自「已授予 - 剩余」占比。
// 与其它供应商保持一致：used=百分比、limit=100，前端直接画进度条。
export function parseCommandCodeWindows(
  credits: CommandCodeCredits | null | undefined,
  summary: CommandCodeSummary | null | undefined,
): ProviderWindow[] {
  const windows: ProviderWindow[] = [];

  const fiveHour = credits?.windowLimits?.fiveHour;
  const fiveHourCap = Number(fiveHour?.cap);
  if (fiveHour && Number.isFinite(fiveHourCap) && fiveHourCap > 0) {
    const percentUsed = clampPercent((Number(fiveHour.used) / fiveHourCap) * 100);
    windows.push({
      key: "rolling",
      label: "5 小时",
      used: percentUsed,
      limit: 100,
      remaining: round2(100 - percentUsed),
      percentUsed,
      percentRemaining: round2(100 - percentUsed),
      resetAt: toIsoFromMs(fiveHour.resetAt),
    });
  }

  const weekly = credits?.windowLimits?.weekly;
  const weeklyCap = Number(weekly?.cap);
  if (weekly && Number.isFinite(weeklyCap) && weeklyCap > 0) {
    const percentUsed = clampPercent((Number(weekly.used) / weeklyCap) * 100);
    windows.push({
      key: "weekly",
      label: "每周",
      used: percentUsed,
      limit: 100,
      remaining: round2(100 - percentUsed),
      percentUsed,
      percentRemaining: round2(100 - percentUsed),
      resetAt: toIsoFromMs(weekly.resetAt),
    });
  }

  const granted = Number(credits?.credits?.monthlyCreditsGranted);
  const remainingCredits = Number(credits?.credits?.monthlyCredits);
  if (Number.isFinite(granted) && granted > 0 && Number.isFinite(remainingCredits)) {
    const usedCredits = Math.max(0, granted - remainingCredits);
    const percentUsed = clampPercent((usedCredits / granted) * 100);
    windows.push({
      key: "monthly",
      label: "每月",
      used: percentUsed,
      limit: 100,
      remaining: round2(100 - percentUsed),
      percentUsed,
      percentRemaining: round2(100 - percentUsed),
      resetAt: nextBillingReset(summary?.periodStart),
    });
  }

  return windows;
}

// Top5 模型：按 tokensTotal 降序，占比 = 模型 tokens / 计费月总 tokens
export function parseCommandCodeTopModels(
  byModel: CommandCodeByModel | null | undefined,
  totalTokens: number | null | undefined,
): CommandCodeTopModel[] {
  const rows = byModel?.data ?? [];
  const total = Number(totalTokens);
  return rows
    .map((row) => {
      const model = typeof row.model === "string" && row.model.trim() !== "" ? row.model : null;
      const requests = Number(row.requests);
      const tokens = Number(row.tokensTotal ?? row.tokensIn ?? 0);
      if (!model || !Number.isFinite(requests)) return null;
      const share = Number.isFinite(total) && total > 0 ? tokens / total : 0;
      return { model, requests, tokens: Number.isFinite(tokens) ? tokens : 0, share: round2(share * 10000) / 10000 };
    })
    .filter((row): row is CommandCodeTopModel => row !== null)
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, 5);
}
