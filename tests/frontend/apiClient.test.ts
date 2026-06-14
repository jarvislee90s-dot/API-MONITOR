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

  it("loads public auth config from the worker", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            supabaseUrl: "https://project.supabase.co",
            supabaseAnonKey: "anon-public-key",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const api = createApiClient({ fetcher: fetcher as typeof fetch });

    await expect(api.getAuthConfig()).resolves.toEqual({
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon-public-key",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/config",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("sends bearer token when reading and saving provider settings", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/settings/providers") && init?.method === "GET") {
        return new Response(JSON.stringify({ ok: true, data: { catalog: [], preferences: [], accounts: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/api/settings/providers") && init?.method === "PUT") {
        return new Response(JSON.stringify({ ok: true, data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("not found", { status: 404 });
    });

    const api = createApiClient({
      fetcher: fetcher as typeof fetch,
      authTokenProvider: async () => "user-access-token",
    });
    await api.getProviderSettings();
    await api.saveProviderPreferences([
      { providerKey: "openrouter", enabled: true, displayOrder: 1, activeProviderAccountId: null },
    ]);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer user-access-token",
    });
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer user-access-token",
    });
  });

  it("updates provider account homepage display with bearer auth", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: { id: "account-1", homepageEnabled: true, homepageOrder: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const api = createApiClient({
      baseUrl: "https://api-monitor.test",
      fetcher: fetcher as typeof fetch,
      authTokenProvider: async () => "user-access-token",
    });

    await expect(
      api.updateProviderAccountDisplay("account-1", {
        homepageEnabled: true,
        homepageOrder: 3,
      }),
    ).resolves.toEqual({ id: "account-1", homepageEnabled: true, homepageOrder: 3 });

    expect(fetcher).toHaveBeenCalledWith(
      "https://api-monitor.test/api/settings/accounts/account-1/display",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ homepageEnabled: true, homepageOrder: 3 }),
        headers: expect.objectContaining({
          Authorization: "Bearer user-access-token",
        }),
      }),
    );
  });
});
