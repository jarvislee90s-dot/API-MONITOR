import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../frontend/src/api/client";

describe("api client mapping", () => {
  it("formats quota reset time in Beijing time and keeps one dashboard link", async () => {
    const fetcher = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            kind: "usage_dashboard",
            generatedAt: "2026-06-12T02:00:00.000Z",
            status: "ready",
            summary: "ready",
            totals: {
              providers: 1,
              ready: 1,
              partial: 0,
              loginRequired: 0,
              error: 0,
            },
            cards: [
              {
                providerId: "opencode-go",
                providerName: "OpenCode Go",
                sourceUrl: "https://opencode.ai/workspace/wrk_123/go",
                status: "ready",
                summary: "OpenCode Go usage windows parsed",
                capturedAt: "2026-06-12T02:00:00.000Z",
                trend: [],
                windows: [
                  {
                    key: "rolling",
                    label: "5h",
                    used: 1,
                    limit: 100,
                    resetAt: "2026-06-12T02:10:00.000Z",
                  },
                ],
                metrics: {},
                meta: {},
              },
            ],
            modelSpends: [],
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const dashboard = await createApiClient({ fetcher: fetcher as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    expect(platform.quotaWindows[0]?.resetAt).toBe("6月12日 10:10");
    expect(platform.links).toEqual([
      {
        label: "打开看板",
        href: "https://opencode.ai/workspace/wrk_123/go",
        tone: "brand",
      },
    ]);
  });
});
