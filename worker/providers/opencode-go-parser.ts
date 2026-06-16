import type { ProviderWindow } from "../types";

export type OpenCodeGoWindowKey = "rolling" | "weekly" | "monthly";

const WINDOW_KEYS: OpenCodeGoWindowKey[] = ["rolling", "weekly", "monthly"];

function toBeijingOffsetIso(date: Date): string {
  const beijingDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return beijingDate.toISOString().replace(/\.\d{3}Z$/, "+08:00");
}

function parseWindow(html: string, key: OpenCodeGoWindowKey): { used: number; resetInSec?: number } | null {
  const pattern = new RegExp(`${key}Usage:\\$R\\[\\d+\\]=\\{([^}]*)\\}`, "i");
  const match = html.match(pattern);
  if (!match?.[1]) return null;

  const body = match[1];
  const usedMatch = body.match(/usagePercent:([0-9]+(?:\.[0-9]+)?)/i);
  const resetMatch = body.match(/resetInSec:([0-9]+(?:\.[0-9]+)?)/i);
  const used = usedMatch ? Number(usedMatch[1]) : Number.NaN;
  if (!Number.isFinite(used)) return null;

  return {
    used,
    resetInSec: resetMatch ? Number(resetMatch[1]) : undefined,
  };
}

export function parseOpenCodeGoWindows(html: string, now: Date): ProviderWindow[] {
  return WINDOW_KEYS.flatMap((key) => {
    const parsed = parseWindow(html, key);
    if (!parsed) return [];

    return [{
      key,
      label: key === "rolling" ? "5h" : key === "weekly" ? "Weekly" : "Monthly",
      used: parsed.used,
      limit: 100,
      remaining: Math.max(0, 100 - parsed.used),
      percentUsed: Math.min(100, parsed.used),
      percentRemaining: Math.max(0, 100 - parsed.used),
      resetAt: parsed.resetInSec
        ? toBeijingOffsetIso(new Date(now.getTime() + parsed.resetInSec * 1000))
        : null,
    }];
  });
}
