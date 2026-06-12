import type { ProviderSnapshot, UsageDashboard, UsageProviderCard } from "./types";

type ProviderDashboardPreference = {
  providerKey: string;
  enabled: boolean;
  displayOrder: number;
};

function getStatusRank(status: UsageDashboard["status"]): number {
  if (status === "error") return 4;
  if (status === "login_required") return 3;
  if (status === "partial") return 2;
  if (status === "ready") return 1;
  return 0;
}

function mergeStatus(current: UsageDashboard["status"], next: UsageDashboard["status"]): UsageDashboard["status"] {
  return getStatusRank(next) > getStatusRank(current) ? next : current;
}

function buildSummary(cards: UsageProviderCard[]): string {
  return cards.map((card) => `${card.providerName}: ${card.status}`).join(" | ");
}

function buildCard(snapshot: ProviderSnapshot): UsageProviderCard {
  return {
    providerId: snapshot.providerId,
    providerName: snapshot.providerName,
    sourceUrl: snapshot.sourceUrl,
    status: snapshot.status,
    summary: snapshot.summary,
    capturedAt: snapshot.capturedAt,
    trend: snapshot.windows.map((window) => ({ ...window })),
    windows: snapshot.windows.map((window) => ({ ...window })),
    metrics: { ...snapshot.metrics },
    meta: { ...snapshot.meta },
  };
}

export function buildUsageDashboard(
  snapshots: ProviderSnapshot[],
  options: {
    generatedAt?: string;
    refresh?: UsageDashboard["refresh"];
    providerPreferences?: ProviderDashboardPreference[];
  } = {},
): UsageDashboard {
  const preferenceMap = new Map(options.providerPreferences?.map((item) => [item.providerKey, item]));
  const cards = snapshots
    .map(buildCard)
    .filter((card) => preferenceMap.get(card.providerId)?.enabled ?? true)
    .sort((left, right) => {
      const leftOrder = preferenceMap.get(left.providerId)?.displayOrder ?? 100;
      const rightOrder = preferenceMap.get(right.providerId)?.displayOrder ?? 100;
      return leftOrder - rightOrder;
    });
  const status = cards.reduce<UsageDashboard["status"]>(
    (current, card) => mergeStatus(current, card.status),
    "ready",
  );

  const totals = cards.reduce(
    (acc, card) => {
      acc.providers += 1;
      if (card.status === "ready") acc.ready += 1;
      if (card.status === "partial") acc.partial += 1;
      if (card.status === "login_required") acc.loginRequired += 1;
      if (card.status === "error") acc.error += 1;
      return acc;
    },
    {
      providers: 0,
      ready: 0,
      partial: 0,
      loginRequired: 0,
      error: 0,
    },
  );

  return {
    kind: "usage_dashboard",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    status,
    summary: buildSummary(cards),
    cards,
    modelSpends: [],
    totals,
    ...(options.refresh ? { refresh: options.refresh } : {}),
  };
}
