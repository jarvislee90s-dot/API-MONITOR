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
  const accountId = typeof snapshot.meta.accountId === "string"
    ? snapshot.meta.accountId
    : `${snapshot.providerId}:default`;
  const accountLabel = typeof snapshot.meta.accountLabel === "string"
    ? snapshot.meta.accountLabel
    : "默认账号";
  const trend = snapshot.windows.map((window) => ({ ...window }));
  const windows = snapshot.windows.map((window) => ({ ...window }));
  const metrics = { ...snapshot.metrics };
  const meta = { ...snapshot.meta };

  return {
    providerId: snapshot.providerId,
    providerName: snapshot.providerName,
    sourceUrl: snapshot.sourceUrl,
    status: snapshot.status,
    summary: snapshot.summary,
    capturedAt: snapshot.capturedAt,
    trend,
    windows,
    metrics,
    meta,
    selectedAccountId: accountId,
    accounts: [
      {
        accountId,
        accountLabel,
        sourceUrl: snapshot.sourceUrl,
        status: snapshot.status,
        summary: snapshot.summary,
        capturedAt: snapshot.capturedAt,
        trend: trend.map((window) => ({ ...window })),
        windows: windows.map((window) => ({ ...window })),
        metrics: { ...metrics },
        meta: { ...meta },
      },
    ],
  };
}

function mergeCards(cards: UsageProviderCard[]): UsageProviderCard[] {
  const grouped = new Map<UsageProviderCard["providerId"], UsageProviderCard>();

  for (const card of cards) {
    const existing = grouped.get(card.providerId);
    if (!existing) {
      grouped.set(card.providerId, card);
      continue;
    }

    existing.accounts.push(...card.accounts);
    existing.status = mergeStatus(existing.status, card.status);
    existing.capturedAt = existing.capturedAt > card.capturedAt ? existing.capturedAt : card.capturedAt;
  }

  return [...grouped.values()];
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
    .reduce<UsageProviderCard[]>((acc, card) => mergeCards([...acc, card]), [])
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
