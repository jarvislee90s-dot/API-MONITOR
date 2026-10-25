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
