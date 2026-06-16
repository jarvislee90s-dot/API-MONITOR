import { describe, expect, it, vi } from "vitest";

import { getProvider, isProviderId, listProviders } from "../../worker/providers/registry";
import { fetchOpenRouterSnapshot } from "../../worker/providers/openrouter";
import { fetchOpenCodeGoSnapshot } from "../../worker/providers/opencode-go";
import { parseOpenCodeGoWindows } from "../../worker/providers/opencode-go-parser";
import { fetchXfyunMaaSSnapshot } from "../../worker/providers/xfyun-maas";
import { fetchAliyunBailianSnapshot } from "../../worker/providers/aliyun-bailian";

describe("provider registry", () => {
  it("exposes the cloud adapters", () => {
    expect(listProviders().map((provider) => provider.id)).toEqual([
      "openrouter",
      "opencode-go",
      "xfyun-maas",
      "aliyun-bailian",
    ]);
    expect(getProvider("openrouter")?.name).toBe("OpenRouter");
    expect(getProvider("opencode-go")?.name).toBe("OpenCode Go");
    expect(getProvider("xfyun-maas")?.name).toBe("讯飞 MaaS");
    expect(getProvider("aliyun-bailian")?.name).toBe("阿里云百炼");
    expect(isProviderId("openrouter")).toBe(true);
    expect(isProviderId("aliyun-bailian")).toBe(true);
    expect(isProviderId("unknown")).toBe(false);
  });
});

describe("openrouter adapter", () => {
  it("returns login_required when the API key is missing", async () => {
    const result = await fetchOpenRouterSnapshot({
      now: new Date("2026-06-11T00:00:00.000Z"),
      config: {},
    });

    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.summary).toContain("Missing OpenRouter API key");
  });

  it("parses the key endpoint into a ready snapshot", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: {
            usage: 12,
            usage_daily: 4,
            usage_weekly: 7,
            usage_monthly: 9,
            limit: 100,
            limit_remaining: 88,
            is_free_tier: false,
            rate_limit_requests: 10,
            rate_limit_interval: 60,
            label: "Personal",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const result = await fetchOpenRouterSnapshot({
      now: new Date("2026-06-11T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: { apiKey: "sk-test" },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows.map((window) => window.key)).toEqual([
      "current",
      "daily",
      "weekly",
      "monthly",
    ]);
    expect(result.snapshot.metrics).toMatchObject({
      usage: 12,
      usageDaily: 4,
      usageWeekly: 7,
      usageMonthly: 9,
      limit: 100,
      remaining: 88,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("opencode-go adapter", () => {
  it("returns login_required when the cloud auth inputs are missing", async () => {
    const result = await fetchOpenCodeGoSnapshot({
      now: new Date("2026-06-11T00:00:00.000Z"),
      config: {},
    });

    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.summary).toContain("Missing workspaceId or auth cookie");
  });

  it("parses rolling, weekly, and monthly usage windows", async () => {
    const html = [
      "<html><script>",
      "rollingUsage:$R[10]={usagePercent:7,resetInSec:18000}",
      "weeklyUsage:$R[11]={resetInSec:540000,usagePercent:2}",
      "monthlyUsage:$R[12]={usagePercent:16,resetInSec:2480000}",
      "</script></html>",
    ].join("");
    const fetchImpl = vi.fn(async () => {
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });

    const result = await fetchOpenCodeGoSnapshot({
      now: new Date("2026-06-11T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        workspaceId: "wrk_123",
        authCookie: "auth-cookie=abc",
      },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows.map((window) => window.key)).toEqual([
      "rolling",
      "weekly",
      "monthly",
    ]);
    expect(result.snapshot.windows[0]).toMatchObject({
      label: "5h",
      used: 7,
      percentRemaining: 93,
      resetAt: "2026-06-11T13:00:00+08:00",
    });
    expect(result.snapshot.windows[1]).toMatchObject({
      label: "Weekly",
      used: 2,
      percentRemaining: 98,
    });
    expect(result.snapshot.windows[2]).toMatchObject({
      label: "Monthly",
      used: 16,
      percentRemaining: 84,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("normalizes auth token and DevTools JSON cookies before fetching", async () => {
    const html = "rollingUsage:$R[10]={usagePercent:7,resetInSec:18000}";
    const seenCookies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenCookies.push(headers.get("Cookie") ?? "");
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });

    await fetchOpenCodeGoSnapshot({
      now: new Date("2026-06-11T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        workspaceId: "wrk_123",
        authCookie: "abc123",
      },
    });
    await fetchOpenCodeGoSnapshot({
      now: new Date("2026-06-11T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        workspaceId: "wrk_123",
        authCookie: JSON.stringify([
          { name: "auth", value: "json-token" },
          { name: "theme", value: "light" },
        ]),
      },
    });

    expect(seenCookies).toEqual(["auth=abc123", "auth=json-token; theme=light"]);
  });

  it("reports login_required when OpenCode redirects to auth", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("", {
        status: 302,
        headers: { location: "https://auth.opencode.ai/authorize?client_id=app" },
      });
    });

    const result = await fetchOpenCodeGoSnapshot({
      now: new Date("2026-06-11T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        workspaceId: "wrk_123",
        authCookie: "abc123",
      },
    });

    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.summary).toContain("redirected to login");
  });

  it("uses baseUrl as the OpenCode origin while preserving the workspace route", async () => {
    const html = "rollingUsage:$R[10]={usagePercent:7,resetInSec:18000}";
    const fetchedUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      fetchedUrls.push(String(url));
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });

    await fetchOpenCodeGoSnapshot({
      now: new Date("2026-06-11T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        workspaceId: "wrk_123",
        authCookie: "auth=abc123",
        baseUrl: "https://opencode.ai",
      },
    });

    expect(fetchedUrls).toEqual(["https://opencode.ai/workspace/wrk_123/go"]);
  });

  it("parses OpenCode Go usage windows through the shared parser", () => {
    const html = [
      "<html><script>",
      "rollingUsage:$R[10]={usagePercent:6,resetInSec:10200}",
      "weeklyUsage:$R[11]={usagePercent:16,resetInSec:489600}",
      "monthlyUsage:$R[12]={usagePercent:25,resetInSec:1987200}",
      "</script></html>",
    ].join("");

    const windows = parseOpenCodeGoWindows(html, new Date("2026-06-16T07:00:00.000Z"));

    expect(windows.map((window) => window.key)).toEqual(["rolling", "weekly", "monthly"]);
    expect(windows[0]).toMatchObject({
      key: "rolling",
      label: "5h",
      used: 6,
      limit: 100,
      remaining: 94,
      percentUsed: 6,
      percentRemaining: 94,
      resetAt: "2026-06-16T17:50:00+08:00",
    });
    expect(windows[1]).toMatchObject({ key: "weekly", used: 16, remaining: 84 });
    expect(windows[2]).toMatchObject({ key: "monthly", used: 25, remaining: 75 });
  });

  it("uses the injected browser renderer when lightweight OpenCode fetch redirects to login", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("", {
        status: 302,
        headers: { location: "https://auth.opencode.ai/authorize?client_id=app" },
      });
    });
    const browserRenderer = vi.fn(async () => {
      return [
        "<html><script>",
        "rollingUsage:$R[10]={usagePercent:6,resetInSec:10200}",
        "weeklyUsage:$R[11]={usagePercent:16,resetInSec:489600}",
        "monthlyUsage:$R[12]={usagePercent:25,resetInSec:1987200}",
        "</script></html>",
      ].join("");
    });

    const result = await fetchOpenCodeGoSnapshot({
      now: new Date("2026-06-16T07:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      browserRenderer,
      config: {
        workspaceId: "wrk_123",
        authCookie: "auth=abc123",
        browserFallbackEnabled: true,
      },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows.map((window) => window.key)).toEqual(["rolling", "weekly", "monthly"]);
    expect(result.snapshot.meta).toMatchObject({
      fetchMethod: "browser_rendered",
      liveFetchStatus: "login_required",
    });
    expect(browserRenderer).toHaveBeenCalledWith({
      sourceUrl: "https://opencode.ai/workspace/wrk_123/go",
      authCookie: "auth=abc123",
      browser: undefined,
    });
  });
});

describe("xfyun maas adapter", () => {
  it("returns login_required when no cloud login inputs are configured", async () => {
    const result = await fetchXfyunMaaSSnapshot({
      now: new Date("2026-06-11T00:00:00.000Z"),
      config: {},
    });

    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.meta).toMatchObject({ entryUrl: "https://maas.xfyun.cn/packageSubscription" });
  });

  it("parses a JSON status endpoint into a ready snapshot", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ used: 20, limit: 100, remaining: 80 }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    });

    const result = await fetchXfyunMaaSSnapshot({
      now: new Date("2026-06-11T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        apiUrl: "https://maas.xfyun.cn/api/subscription",
        authCookie: "session=abc",
      },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows).toEqual([
      {
        key: "subscription",
        label: "Subscription",
        used: 20,
        limit: 100,
        remaining: 80,
      },
    ]);
    expect(result.snapshot.metrics).toMatchObject({
      used: 20,
      limit: 100,
      remaining: 80,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("parses coding plan list usage windows without retaining credentials", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            rows: [
              {
                name: "专业版",
                expiresAt: "2026-07-11 14:31:31",
                codingPlanAppCredentialDTO: {
                  apiKey: "should-not-be-retained",
                  appSecret: "should-not-be-retained",
                },
                codingPlanUsageDTO: {
                  channel: "astron-code-latest",
                  packageLeft: 15801,
                  packageLimit: 18000,
                  packageUsage: 2199,
                  rp5hLimit: 1200,
                  rp5hUsage: 338,
                  rpwLimit: 9000,
                  rpwUsage: 2199,
                },
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    });

    const result = await fetchXfyunMaaSSnapshot({
      now: new Date("2026-06-11T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        apiUrl: "https://maas.xfyun.cn/api/v1/gpt-finetune/coding-plan/list?page=1&size=6",
        authCookie: "session=abc",
      },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows).toEqual([
      {
        key: "rp5h",
        label: "5小时",
        used: 338,
        limit: 1200,
        remaining: 862,
      },
      {
        key: "weekly",
        label: "每周",
        used: 2199,
        limit: 9000,
        remaining: 6801,
      },
      {
        key: "package",
        label: "套餐",
        used: 2199,
        limit: 18000,
        remaining: 15801,
      },
    ]);
    expect(result.snapshot.metrics).toMatchObject({
      planName: "专业版",
      channel: "astron-code-latest",
      packageUsage: 2199,
      packageLimit: 18000,
      rp5hUsage: 338,
      rp5hLimit: 1200,
      rpwUsage: 2199,
      rpwLimit: 9000,
    });
    expect(JSON.stringify(result)).not.toContain("should-not-be-retained");
  });
});

describe("aliyun-bailian adapter", () => {
  it("returns a manual dashboard entry by default without cloud fetching", async () => {
    const fetchImpl = vi.fn(async () => new Response("should not fetch"));
    const result = await fetchAliyunBailianSnapshot({
      now: new Date("2026-06-12T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        apiUrl: "https://bailian.console.aliyun.com/api/coding-plan/usage",
      },
    });

    expect(result.snapshot.status).toBe("partial");
    expect(result.snapshot.summary).toContain("原网页");
    expect(result.snapshot.sourceUrl).toContain("bailian.console.aliyun.com");
    expect(result.snapshot.meta.openMode).toBe("external");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns partial with dashboard entry when no API URL is configured", async () => {
    const result = await fetchAliyunBailianSnapshot({
      now: new Date("2026-06-12T00:00:00.000Z"),
      config: {
        pageUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/coding-plan",
        authCookie: "login=abc",
      },
    });

    expect(result.snapshot.providerId).toBe("aliyun-bailian");
    expect(result.snapshot.status).toBe("partial");
    expect(result.snapshot.sourceUrl).toContain("bailian.console.aliyun.com");
  });

  it("parses configured JSON usage API into quota windows", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: {
            planName: "Coding Plan",
            windows: [
              { key: "monthly", label: "Monthly", used: 32, limit: 100, resetAt: "2026-07-01T00:00:00+08:00" },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await fetchAliyunBailianSnapshot({
      now: new Date("2026-06-12T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        pageUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/coding-plan",
        apiUrl: "https://bailian.console.aliyun.com/api/coding-plan/usage",
        authCookie: "login=abc",
        cloudFetchEnabled: true,
      },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows).toEqual([
      {
        key: "monthly",
        label: "Monthly",
        used: 32,
        limit: 100,
        remaining: 68,
        resetAt: "2026-07-01T00:00:00+08:00",
      },
    ]);
  });

  it("parses Aliyun Bailian console coding plan quota response", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          code: "200",
          data: {
            DataV2: {
              data: {
                data: {
                  codingPlanInstanceInfos: [
                    {
                      codingPlanQuotaInfo: {
                        perBillMonthUsedQuota: 18525,
                        per5HourUsedQuota: 0,
                        perBillMonthTotalQuota: 90000,
                        per5HourTotalQuota: 6000,
                        perWeekTotalQuota: 45000,
                        perBillMonthQuotaNextRefreshTime: 1781366400000,
                        per5HourQuotaNextRefreshTime: 1781279135000,
                        perWeekUsedQuota: 1394,
                        perWeekQuotaNextRefreshTime: 1781452800000,
                      },
                      instanceEndTime: 1781366400000,
                      instanceName: "Coding Plan Pro",
                      remainingDays: 1,
                      instanceStartTime: 1773395017000,
                      status: "VALID",
                    },
                  ],
                },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await fetchAliyunBailianSnapshot({
      now: new Date("2026-06-12T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        pageUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/coding-plan",
        apiUrl: "https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2",
        authCookie: "login=abc",
        cloudFetchEnabled: true,
      },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows).toEqual([
      {
        key: "5h",
        label: "5h",
        used: 0,
        limit: 6000,
        remaining: 6000,
        resetAt: "2026-06-12T23:45:35+08:00",
      },
      {
        key: "weekly",
        label: "Weekly",
        used: 1394,
        limit: 45000,
        remaining: 43606,
        resetAt: "2026-06-15T00:00:00+08:00",
      },
      {
        key: "monthly",
        label: "Monthly",
        used: 18525,
        limit: 90000,
        remaining: 71475,
        resetAt: "2026-06-14T00:00:00+08:00",
      },
    ]);
    expect(result.snapshot.metrics.planName).toBe("Coding Plan Pro");
    expect(result.snapshot.metrics.planStatus).toBe("VALID");

    const request = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = request[1].body?.toString() ?? "";
    const params = JSON.parse(new URLSearchParams(body).get("params") ?? "{}");
    expect(params.Data.cornerstoneParam).toMatchObject({
      protocol: "V2",
      console: "ONE_CONSOLE",
      productCode: "p_efm",
      consoleSite: "BAILIAN_ALIYUN",
    });
  });

  it("rejects non-Aliyun API URLs before sending cookies", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("should not fetch");
    });

    const result = await fetchAliyunBailianSnapshot({
      now: new Date("2026-06-12T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        apiUrl: "https://example.com/api/coding-plan/usage",
        authCookie: "login=abc",
        cloudFetchEnabled: true,
      },
    });

    expect(result.snapshot.status).toBe("error");
    expect(result.snapshot.summary).toContain("API URL");
    expect(fetchImpl).not.toHaveBeenCalled();
  });


  it("reports login_required when Aliyun gateway returns NotLogined", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          code: "200",
          data: {
            success: false,
            errorCode: "BailianGateway.Login.NotLogined",
            errorMsg: "BailianGateway.Login.NotLogined",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await fetchAliyunBailianSnapshot({
      now: new Date("2026-06-12T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        apiUrl: "https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2",
        authCookie: "login=abc",
        cloudFetchEnabled: true,
      },
    });

    expect(result.snapshot.status).toBe("partial");
    expect(result.snapshot.summary).toContain("原网页");
    expect(result.snapshot.meta.cloudFetchStatus).toBe("login_required");
  });

  it("falls back to the manual entry when the API returns a login page", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });

    const result = await fetchAliyunBailianSnapshot({
      now: new Date("2026-06-12T00:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        apiUrl: "https://bailian.console.aliyun.com/api/coding-plan/usage",
        authCookie: "login=abc",
        cloudFetchEnabled: true,
      },
    });

    expect(result.snapshot.status).toBe("partial");
    expect(result.snapshot.summary).toContain("原网页");
    expect(result.snapshot.meta.cloudFetchStatus).toBe("login_required");
  });
});
