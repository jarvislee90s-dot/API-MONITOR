import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../frontend/src/api/client";

// 构造 chatgpt 卡的 /api/usage 响应，cardOverrides 覆盖卡字段以便聚焦断言
function buildChatgptUsageResponse(cardOverrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      ok: true,
      data: {
        kind: "usage_dashboard",
        generatedAt: "2026-10-14T00:00:00.000Z",
        status: "ready",
        summary: "ready",
        totals: { providers: 1, ready: 1, partial: 0, loginRequired: 0, error: 0 },
        cards: [
          {
            providerId: "chatgpt",
            providerName: "ChatGPT",
            sourceUrl: "https://chatgpt.com",
            status: "ready",
            summary: "Codex 窗口已获取",
            capturedAt: "2026-10-13T16:05:00.000Z",
            trend: [],
            windows: [
              { key: "codex_5h", label: "Codex 5小时", used: 40, limit: 100, percentUsed: 40, resetAt: null },
            ],
            metrics: {
              plan: "plus",
              planRenewAt: null,
              codexTokenRefreshed: false,
              webFetchMethod: "direct",
            },
            meta: {},
            ...cardOverrides,
          },
        ],
        modelSpends: [],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// 「推送时间」按查看者本地时区渲染（未固定 timeZone），期望值用同一 Intl 规则动态生成，
// 避免测试绑定运行机器时区而 flaky
function formatLocalPushTime(capturedAt: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(capturedAt));
}

// 构造任意单卡 /api/usage 响应（非 chatgpt 供应商的回归守卫走这里）
function buildSingleCardResponse(card: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      ok: true,
      data: {
        kind: "usage_dashboard",
        generatedAt: "2026-10-14T00:00:00.000Z",
        status: "ready",
        summary: "ready",
        totals: { providers: 1, ready: 1, partial: 0, loginRequired: 0, error: 0 },
        cards: [card],
        modelSpends: [],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

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

  it("maps ollama card windows, detail metrics and model list", async () => {
    const fetcher = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            kind: "usage_dashboard",
            generatedAt: "2026-08-23T06:00:00.000Z",
            status: "ready",
            summary: "Ollama Pro: ready",
            totals: { providers: 1, ready: 1, partial: 0, loginRequired: 0, error: 0 },
            cards: [
              {
                providerId: "ollama",
                providerName: "Ollama Pro",
                sourceUrl: "https://ollama.com/settings",
                status: "ready",
                summary: "Ollama Pro 用量已解析",
                capturedAt: "2026-08-23T06:00:00.000Z",
                trend: [],
                windows: [
                  { key: "rp5h", label: "5小时", used: 6.8, limit: 100, percentUsed: 6.8, resetAt: null },
                  { key: "weekly", label: "每周", used: 0.7, limit: 100, percentUsed: 0.7, resetAt: null },
                ],
                metrics: {
                  sessionUsagePercent: 6.8,
                  weeklyUsagePercent: 0.7,
                  sessionRequestCount: 117,
                  weeklyRequestCount: 249,
                  weeklyModelCount: 2,
                  weeklyModels: JSON.stringify([
                    { name: "deepseek-v4-flash:0731", requests: 239 },
                    { name: "kimi-k2.6", requests: 10 },
                  ]),
                },
                meta: {},
                selectedAccountId: "ollama:default",
                accounts: [],
              },
            ],
            modelSpends: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const client = createApiClient({ fetcher: fetcher as unknown as typeof fetch });
    const dashboard = await client.getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    expect(platform.quotaWindows.map((w) => w.label)).toEqual(["5小时", "每周"]);
    expect(platform.quotaWindows[0]?.resetAt).toBe("滚动窗口");
    expect(platform.modelSpends).toEqual([
      { model: "deepseek-v4-flash:0731", requests: 239, tokens: 0, spendUsd: 0, share: 239 / 249 },
      { model: "kimi-k2.6", requests: 10, tokens: 0, spendUsd: 0, share: 10 / 249 },
    ]);
    const detail = platform.detailMetrics.map((m) => m.label);
    expect(detail).toEqual(["5小时请求数", "本周请求数", "5小时预计总请求"]);
    const estimated = platform.detailMetrics.find((m) => m.label === "5小时预计总请求");
    expect(estimated?.value).toBe("1,721"); // 117 / (6.8/100) = 1720.6 -> 1721
  });

  it("maps the chatgpt card with plan metrics and per-provider fallbacks", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            kind: "usage_dashboard",
            generatedAt: "2026-10-14T00:00:00.000Z",
            status: "ready",
            summary: "ready",
            totals: { providers: 1, ready: 1, partial: 0, loginRequired: 0, error: 0 },
            cards: [
              {
                providerId: "chatgpt",
                providerName: "ChatGPT",
                sourceUrl: "https://chatgpt.com",
                status: "ready",
                summary: "Codex 窗口已获取；订阅档位 plus",
                capturedAt: "2026-10-14T00:00:00.000Z",
                trend: [],
                windows: [
                  {
                    key: "codex_5h",
                    label: "Codex 5小时",
                    used: 40,
                    limit: 100,
                    percentUsed: 40,
                    resetAt: null,
                  },
                  {
                    key: "web_5h_default",
                    label: "对话 5小时·default",
                    used: 30,
                    limit: 100,
                    percentUsed: 30,
                    resetAt: "2026-10-14T03:00:00.000Z",
                    meta: { stale: true },
                  },
                ],
                metrics: {
                  plan: "plus",
                  planRenewAt: null,
                  codexTokenRefreshed: true,
                  webFetchMethod: "direct",
                },
                meta: {},
              },
            ],
            modelSpends: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const dashboard = await createApiClient({ fetcher: fetcher as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    expect(platform.accent).toBe("#10a37f");
    expect(platform.tagline).toBe("Codex / 对话额度 / 订阅状态");
    expect(platform.primaryMetricLabel).toBe("Codex 5小时");
    // resetAt 缺失 → 滚动窗口；补齐窗口 label 加（历史）后缀
    expect(platform.quotaWindows[0]?.resetAt).toBe("滚动窗口");
    expect(platform.quotaWindows[1]?.label).toBe("对话 5小时·default（历史）");
    expect(platform.detailMetrics).toEqual([
      { label: "订阅档位", value: "plus" },
      { label: "续费日期", value: "订阅前无数据" },
      { label: "Token 刷新", value: "本轮已刷新" },
      { label: "抓取方式", value: "云端直连" },
    ]);
  });

  it("maps chatgpt webFetchMethod=unconfigured to 未配置 instead of 快照回退", async () => {
    // 仅 codex 凭据（未配置 sessionToken）：web 桶未尝试，前端不得误显「快照回退」
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            kind: "usage_dashboard",
            generatedAt: "2026-10-14T00:00:00.000Z",
            status: "ready",
            summary: "ready",
            totals: { providers: 1, ready: 1, partial: 0, loginRequired: 0, error: 0 },
            cards: [
              {
                providerId: "chatgpt",
                providerName: "ChatGPT",
                sourceUrl: "https://chatgpt.com",
                status: "ready",
                summary: "Codex 窗口已获取",
                capturedAt: "2026-10-14T00:00:00.000Z",
                trend: [],
                windows: [
                  { key: "codex_5h", label: "Codex 5小时", used: 40, limit: 100, percentUsed: 40, resetAt: null },
                ],
                metrics: {
                  plan: "plus",
                  planRenewAt: null,
                  codexTokenRefreshed: false,
                  webFetchMethod: "unconfigured",
                },
                meta: {},
              },
            ],
            modelSpends: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const dashboard = await createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    expect(platform.detailMetrics).toEqual([
      { label: "订阅档位", value: "plus" },
      { label: "续费日期", value: "订阅前无数据" },
      { label: "Token 刷新", value: "未刷新" },
      { label: "抓取方式", value: "未配置" },
    ]);
  });

  it("maps chatgpt meta.fetchMethod=local_ingest to 本机推送 ahead of webFetchMethod states", async () => {
    // 本机脚本推送的快照：即使 web 通道未配置（codex-only 推送），抓取方式也必须显示本机推送
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            kind: "usage_dashboard",
            generatedAt: "2026-10-14T00:00:00.000Z",
            status: "ready",
            summary: "ready",
            totals: { providers: 1, ready: 1, partial: 0, loginRequired: 0, error: 0 },
            cards: [
              {
                providerId: "chatgpt",
                providerName: "ChatGPT",
                sourceUrl: "https://chatgpt.com",
                status: "ready",
                summary: "Codex 窗口已获取；订阅档位 plus",
                capturedAt: "2026-10-14T00:00:00.000Z",
                trend: [],
                windows: [
                  { key: "codex_5h", label: "Codex 5小时", used: 40, limit: 100, percentUsed: 40, resetAt: null },
                ],
                metrics: {
                  plan: "plus",
                  planRenewAt: null,
                  codexTokenRefreshed: false,
                  webFetchMethod: "unconfigured",
                },
                meta: { fetchMethod: "local_ingest" },
              },
            ],
            modelSpends: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const dashboard = await createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    expect(platform.detailMetrics).toEqual([
      { label: "订阅档位", value: "plus" },
      { label: "续费日期", value: "订阅前无数据" },
      { label: "Token 刷新", value: "未刷新" },
      { label: "抓取方式", value: "本机推送" },
      // 本机推送快照在「抓取方式」后追加「推送时间」（capturedAt 存在时）
      { label: "推送时间", value: formatLocalPushTime("2026-10-14T00:00:00.000Z") },
    ]);
  });

  it("maps chatgpt webFetchMethod=snapshot_fallback to 快照回退 when meta has no fetchMethod", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            kind: "usage_dashboard",
            generatedAt: "2026-10-14T00:00:00.000Z",
            status: "ready",
            summary: "ready",
            totals: { providers: 1, ready: 1, partial: 0, loginRequired: 0, error: 0 },
            cards: [
              {
                providerId: "chatgpt",
                providerName: "ChatGPT",
                sourceUrl: "https://chatgpt.com",
                status: "ready",
                summary: "Codex 窗口已获取",
                capturedAt: "2026-10-14T00:00:00.000Z",
                trend: [],
                windows: [
                  { key: "codex_5h", label: "Codex 5小时", used: 40, limit: 100, percentUsed: 40, resetAt: null },
                ],
                metrics: {
                  plan: "plus",
                  planRenewAt: null,
                  codexTokenRefreshed: false,
                  webFetchMethod: "snapshot_fallback",
                },
                meta: {},
              },
            ],
            modelSpends: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const dashboard = await createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    expect(platform.detailMetrics).toEqual([
      { label: "订阅档位", value: "plus" },
      { label: "续费日期", value: "订阅前无数据" },
      { label: "Token 刷新", value: "未刷新" },
      { label: "抓取方式", value: "快照回退" },
    ]);
  });

  it("maps local_ingest fallback snapshots to healthy with 本机推送同步 login state", async () => {
    // 本机推送是既定数据通道：即使云端 live 通道 error，ready 快照也不挂常驻 warning
    const fetcher = vi.fn(async () =>
      buildChatgptUsageResponse({
        meta: { isFallback: true, fetchMethod: "local_ingest", liveStatus: "error" },
      }),
    );

    const dashboard = await createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    // status "healthy" 在 PlatformCard 中渲染为「健康」badge
    expect(platform.status).toBe("healthy");
    expect(platform.loginState).toBe("本机推送同步");
  });

  it("keeps non-local-ingest fallback snapshots on warning with 使用缓存数据", async () => {
    // 回归守卫：普通 fallback（live 通道 error）仍保持 warning / 使用缓存数据
    const fetcher = vi.fn(async () =>
      buildChatgptUsageResponse({
        meta: { isFallback: true, liveStatus: "error" },
      }),
    );

    const dashboard = await createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    expect(platform.status).toBe("warning");
    expect(platform.loginState).toBe("使用缓存数据");
  });

  it("appends 推送时间 metric after 抓取方式 for local_ingest snapshots with capturedAt", async () => {
    const fetcher = vi.fn(async () =>
      buildChatgptUsageResponse({ meta: { fetchMethod: "local_ingest" } }),
    );

    const dashboard = await createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    const labels = platform.detailMetrics.map((metric) => metric.label);
    expect(labels).toContain("抓取方式");
    expect(labels).toContain("推送时间");
    // 「推送时间」追加在「抓取方式」之后，两条同时存在
    expect(labels.indexOf("推送时间")).toBeGreaterThan(labels.indexOf("抓取方式"));

    const pushTime = platform.detailMetrics.find((metric) => metric.label === "推送时间");
    // 形状守卫：中文短日期 + 24 小时制时分（独立于动态期望值，防止格式退化）
    expect(pushTime?.value).toMatch(/^\d+月\d+日 \d{2}:\d{2}$/);
    expect(pushTime?.value).toBe(formatLocalPushTime("2026-10-13T16:05:00.000Z"));
  });

  it("does not add 推送时间 metric for non-local-ingest chatgpt snapshots", async () => {
    // 云端直连快照：即使 capturedAt 存在，也不出现「推送时间」指标
    const fetcher = vi.fn(async () => buildChatgptUsageResponse());

    const dashboard = await createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    expect(platform.detailMetrics.some((metric) => metric.label === "推送时间")).toBe(false);
    expect(platform.detailMetrics).toContainEqual({ label: "抓取方式", value: "云端直连" });
  });

});

describe("chatgpt 双额度桶（Codex 编码 / 网页对话）映射", () => {
  it("仅 Codex 窗口时追加「网页对话额度」占位说明行，trend 仍只含真实窗口", async () => {
    // 免费档典型形态：rate_limits 返回 404，web 桶无任何数据 → 显式占位防误读
    const fetcher = vi.fn(async () =>
      buildChatgptUsageResponse({
        windows: [
          {
            key: "codex_5h",
            label: "Codex 30天",
            used: 100,
            limit: 100,
            percentUsed: 100,
            resetAt: null,
            meta: { bucket: "codex" },
          },
        ],
      }),
    );

    const dashboard = await createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    expect(platform.quotaWindows).toHaveLength(2);
    // 第一条：真实 codex 窗口，scope 用桶名标注归属
    expect(platform.quotaWindows[0]).toMatchObject({
      label: "Codex 30天",
      scope: "Codex 编码额度",
      bucket: "codex",
    });
    // 第二条：web 桶占位说明行
    expect(platform.quotaWindows[1]).toMatchObject({
      label: "网页对话额度",
      scope: "网页对话额度",
      bucket: "web",
      used: 0,
      limit: 0,
      percentUsed: null,
      resetAt: "",
    });
    expect(platform.quotaWindows[1]?.note).toContain("独立计量");
    // trend 只由真实窗口推导：占位行不产生 trend 点
    expect(platform.trend).toHaveLength(1);
    expect(platform.trend[0]?.label).toBe("Codex 30天");
  });

  it("已有 web 窗口时不追加占位行，两个桶分别以桶名作 scope", async () => {
    const fetcher = vi.fn(async () =>
      buildChatgptUsageResponse({
        windows: [
          {
            key: "codex_5h",
            label: "Codex 5小时",
            used: 40,
            limit: 100,
            percentUsed: 40,
            resetAt: null,
            meta: { bucket: "codex" },
          },
          {
            key: "web_5h_default",
            label: "对话 5小时·default",
            used: 30,
            limit: 100,
            percentUsed: 30,
            resetAt: null,
            meta: { bucket: "web" },
          },
        ],
      }),
    );

    const dashboard = await createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    expect(platform.quotaWindows).toHaveLength(2);
    expect(platform.quotaWindows.map((w) => w.scope)).toEqual(["Codex 编码额度", "网页对话额度"]);
    // 有真实 web 窗口就不再补占位说明行
    expect(platform.quotaWindows.every((w) => w.note === undefined)).toBe(true);
  });

  it("旧快照无 meta.bucket 时按 key 前缀兜底：codex_5h → Codex 编码额度桶", async () => {
    // 历史快照（bucket 字段上线前持久化）无需重推也能正确分桶展示
    const fetcher = vi.fn(async () =>
      buildChatgptUsageResponse({
        windows: [
          { key: "codex_5h", label: "Codex 5小时", used: 40, limit: 100, percentUsed: 40, resetAt: null },
        ],
      }),
    );

    const dashboard = await createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    expect(platform.quotaWindows[0]).toMatchObject({
      label: "Codex 5小时",
      scope: "Codex 编码额度",
      bucket: "codex",
    });
  });

  it("旧快照无 meta.bucket 时按 key 前缀兜底：web_5h_default → 网页对话额度桶，且不追加占位行", async () => {
    const fetcher = vi.fn(async () =>
      buildChatgptUsageResponse({
        windows: [
          { key: "web_5h_default", label: "对话 5小时·default", used: 30, limit: 100, percentUsed: 30, resetAt: null },
        ],
      }),
    );

    const dashboard = await createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    expect(platform.quotaWindows[0]).toMatchObject({
      label: "对话 5小时·default",
      scope: "网页对话额度",
      bucket: "web",
    });
    // web 桶已有真实窗口：不得再追加占位说明行
    expect(platform.quotaWindows).toHaveLength(1);
    expect(platform.quotaWindows.every((w) => w.note === undefined)).toBe(true);
  });

  it("账号层同样追加占位说明行（卡片与账号两层都套用）", async () => {
    const codexOnlyWindow = {
      key: "codex_5h",
      label: "Codex 5小时",
      used: 40,
      limit: 100,
      percentUsed: 40,
      resetAt: null,
      meta: { bucket: "codex" },
    };
    const fetcher = vi.fn(async () =>
      buildChatgptUsageResponse({
        windows: [codexOnlyWindow],
        accounts: [
          {
            accountId: "chatgpt:main",
            accountLabel: "主账号",
            sourceUrl: "https://chatgpt.com",
            status: "ready",
            summary: "Codex 窗口已获取",
            capturedAt: "2026-10-13T16:05:00.000Z",
            trend: [],
            windows: [codexOnlyWindow],
            metrics: {},
            meta: {},
          },
        ],
      }),
    );

    const dashboard = await createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;
    const account = platform.accounts[0]!;

    // 卡片层
    expect(platform.quotaWindows.at(-1)).toMatchObject({ bucket: "web", scope: "网页对话额度" });
    // 账号层同样追加，且账号 trend 不含占位点
    expect(account.quotaWindows).toHaveLength(2);
    expect(account.quotaWindows[1]).toMatchObject({ bucket: "web", scope: "网页对话额度" });
    expect(account.quotaWindows[1]?.note).toContain("独立计量");
    expect(account.trend).toHaveLength(1);
  });

  it("chatgpt 无窗口时主指标标签兜底为 Codex 编码额度", async () => {
    const fetcher = vi.fn(async () => buildChatgptUsageResponse({ windows: [] }));

    const dashboard = await createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    expect(platform.primaryMetricLabel).toBe("Codex 编码额度");
  });

  it("其它供应商窗口 scope 仍等于 label，不追加占位行（回归守卫）", async () => {
    const fetcher = vi.fn(async () =>
      buildSingleCardResponse({
        providerId: "zhipu",
        providerName: "智谱 BigModel",
        sourceUrl: "https://bigmodel.cn/coding-plan/personal/usage",
        status: "ready",
        summary: "智谱 Coding Plan 用量已解析",
        capturedAt: "2026-10-14T00:00:00.000Z",
        trend: [],
        windows: [
          { key: "rp5h", label: "5小时", used: 2024, limit: 12000, resetAt: "2026-10-14T07:39:20.000Z" },
          { key: "weekly", label: "每周", used: 2024, limit: 60000 },
        ],
        metrics: {},
        meta: {},
      }),
    );

    const dashboard = await createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    expect(platform.quotaWindows.map((w) => w.scope)).toEqual(["5小时", "每周"]);
    expect(platform.quotaWindows.every((w) => w.bucket == null && w.note === undefined)).toBe(true);
    expect(platform.quotaWindows).toHaveLength(2);
  });
});
