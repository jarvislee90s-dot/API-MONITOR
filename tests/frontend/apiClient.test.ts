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

  it("maps zhipu cards with accent, tagline, and primary metric label", async () => {
    const fetcher = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            kind: "usage_dashboard",
            generatedAt: "2026-08-21T04:00:00.000Z",
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
                providerId: "zhipu",
                providerName: "智谱 BigModel",
                sourceUrl: "https://bigmodel.cn/coding-plan/personal/usage",
                status: "ready",
                summary: "智谱 Coding Plan 用量已解析",
                capturedAt: "2026-08-21T04:00:00.000Z",
                trend: [],
                windows: [
                  {
                    key: "rp5h",
                    label: "5小时",
                    used: 2024,
                    limit: 12000,
                    resetAt: "2026-08-21T07:39:20.000Z",
                  },
                  { key: "weekly", label: "每周", used: 2024, limit: 60000 },
                ],
                metrics: {
                  quotaLevel: "pro",
                  cacheHitRate7d: 0.9552,
                  totalCredits7d: 4427.2874,
                  totalTokens7d: 44865163,
                  cacheHitRate30d: 0.92,
                  totalCredits30d: 6536.3966,
                  totalTokens30d: 90000000,
                },
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

    expect(platform.name).toBe("智谱 BigModel");
    expect(platform.accent).toBe("#0ea5e9");
    expect(platform.tagline).toBe("Coding Plan 用量 / 5小时周配额");
    expect(platform.quotaWindows.map((w) => w.label)).toEqual(["5小时", "每周"]);
    expect(platform.detailMetrics).toEqual([
      { label: "5小时", value: "2,024 / 1.2万" },
      { label: "登录状态", value: "已连接" },
      { label: "最近同步", value: "8月21日 12:00" },
      { label: "7天 Cache 命中率", value: "95.5%" },
      { label: "7天积分消耗", value: "4,427.29" },
      { label: "7天 Tokens", value: "0.45亿" },
      { label: "30天 Cache 命中率", value: "92%" },
      { label: "30天积分总数", value: "6,536.4" },
      { label: "30天 Tokens", value: "0.90亿" },
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

  it("maps fallback snapshots to warning state and surfaces cached data hint", async () => {
    const fetcher = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            kind: "usage_dashboard",
            generatedAt: "2026-06-13T13:30:00.000Z",
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
                summary: "OpenCode Go usage windows parsed（使用最近成功快照）",
                capturedAt: "2026-06-13T13:27:00.000Z",
                trend: [],
                windows: [
                  {
                    key: "weekly",
                    label: "Weekly",
                    used: 26,
                    limit: 100,
                  },
                ],
                metrics: {},
                meta: {
                  isFallback: true,
                  liveStatus: "partial",
                  liveSummary: "OpenCode Go dashboard loaded but usage windows were not found",
                  fallbackFrom: "OpenCode Go dashboard loaded but usage windows were not found",
                },
                selectedAccountId: "opencode-go:default",
                accounts: [
                  {
                    accountId: "opencode-go:default",
                    accountLabel: "默认账号",
                    sourceUrl: "https://opencode.ai/workspace/wrk_123/go",
                    status: "ready",
                    summary: "OpenCode Go usage windows parsed（使用最近成功快照）",
                    capturedAt: "2026-06-13T13:27:00.000Z",
                    trend: [],
                    windows: [
                      {
                        key: "weekly",
                        label: "Weekly",
                        used: 26,
                        limit: 100,
                      },
                    ],
                    metrics: {},
                    meta: {
                      isFallback: true,
                      liveStatus: "partial",
                    },
                  },
                ],
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
    const account = platform.accounts[0]!;

    expect(platform.status).toBe("partial");
    expect(platform.loginState).toBe("使用缓存数据");
    expect(account.status).toBe("partial");
    expect(account.loginState).toBe("使用缓存数据");
    expect(account.liveStatus).toBe("partial");
  });

  it("maps browser-rendered OpenCode snapshots to connected cloud browser state", async () => {
    const fetcher = vi.fn(async () => Response.json({
      ok: true,
      data: {
        kind: "usage_dashboard",
        generatedAt: "2026-06-16T07:00:00.000Z",
        status: "ready",
        summary: "ready",
        cards: [{
          providerId: "opencode-go",
          providerName: "OpenCode Go",
          sourceUrl: "https://opencode.ai/workspace/wrk_123/go",
          status: "ready",
          summary: "OpenCode Go usage windows parsed by Cloudflare Browser Run",
          capturedAt: "2026-06-16T07:00:00.000Z",
          trend: [],
          windows: [{ key: "rolling", label: "5h", used: 6, limit: 100, remaining: 94 }],
          metrics: {},
          meta: { fetchMethod: "browser_rendered" },
          selectedAccountId: "opencode-go:default",
          accounts: [],
        }],
        modelSpends: [],
        totals: { providers: 1, ready: 1, partial: 0, loginRequired: 0, error: 0 },
      },
    }));
    const client = createApiClient({ fetcher: fetcher as unknown as typeof fetch });

    const dashboard = await client.getUsageDashboard();

    expect(dashboard.platforms[0]).toMatchObject({
      status: "healthy",
      loginState: "云端浏览器同步",
    });
  });
});
