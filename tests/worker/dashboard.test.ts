import { describe, expect, it } from "vitest";
import { buildUsageDashboard } from "../../worker/dashboard";
import type { ProviderSnapshot } from "../../worker/types";

function createSnapshot(providerId: string, accountId?: string): ProviderSnapshot {
  return {
    providerId: providerId as ProviderSnapshot["providerId"],
    providerName: providerId,
    sourceUrl: `https://example.com/${providerId}`,
    status: "ready",
    capturedAt: "2026-06-13T00:00:00.000Z",
    summary: "OK",
    windows: [{ key: "monthly", label: "Monthly", used: 10, limit: 100, resetAt: null }],
    metrics: {},
    meta: accountId ? { accountId, accountLabel: `Account ${accountId}` } : {},
  };
}

describe("buildUsageDashboard selectedAccountId", () => {
  it("uses activeProviderAccountId from preference when available", () => {
    const snapshots = [
      createSnapshot("openrouter", "acc-1"),
      createSnapshot("openrouter", "acc-2"),
    ];

    const dashboard = buildUsageDashboard(snapshots, {
      providerPreferences: [
        {
          providerKey: "openrouter",
          enabled: true,
          displayOrder: 1,
          activeProviderAccountId: "acc-2",
        },
      ],
    });

    expect(dashboard.cards[0].selectedAccountId).toBe("acc-2");
    expect(dashboard.cards[0].accounts.length).toBe(2);
  });

  it("falls back to snapshot accountId when no preference activeProviderAccountId", () => {
    const snapshots = [createSnapshot("openrouter", "acc-1")];

    const dashboard = buildUsageDashboard(snapshots, {
      providerPreferences: [
        {
          providerKey: "openrouter",
          enabled: true,
          displayOrder: 1,
          activeProviderAccountId: null,
        },
      ],
    });

    expect(dashboard.cards[0].selectedAccountId).toBe("acc-1");
  });

  it("uses first snapshot accountId when no preference at all", () => {
    const snapshots = [
      createSnapshot("openrouter", "acc-1"),
      createSnapshot("openrouter", "acc-2"),
    ];

    const dashboard = buildUsageDashboard(snapshots);

    const openrouterCard = dashboard.cards.find((c) => c.providerId === "openrouter");
    // mergeCards 保留第一张卡的 selectedAccountId
    expect(openrouterCard?.selectedAccountId).toBe("acc-1");
    expect(openrouterCard?.accounts.length).toBe(2);
  });
});
