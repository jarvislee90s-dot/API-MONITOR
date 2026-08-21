import { describe, expect, it, vi } from "vitest";

import { getProvider, isProviderId, listProviders } from "../../worker/providers/registry";
import { fetchOpenRouterSnapshot } from "../../worker/providers/openrouter";
import { fetchOpenCodeGoSnapshot } from "../../worker/providers/opencode-go";
import { parseOpenCodeGoWindows } from "../../worker/providers/opencode-go-parser";
import { fetchXfyunMaaSSnapshot } from "../../worker/providers/xfyun-maas";
import { fetchAliyunBailianSnapshot } from "../../worker/providers/aliyun-bailian";
import { fetchVolcArkSnapshot } from "../../worker/providers/volc-ark";
import { fetchDeepSeekSnapshot } from "../../worker/providers/deepseek";
import { fetchZhipuSnapshot } from "../../worker/providers/zhipu";

describe("provider registry", () => {
  it("exposes the cloud adapters", () => {
    expect(listProviders().map((provider) => provider.id)).toEqual([
      "openrouter",
      "opencode-go",
      "xfyun-maas",
      "aliyun-bailian",
      "volc-ark",
      "deepseek",
      "zhipu",
    ]);
    expect(getProvider("openrouter")?.name).toBe("OpenRouter");
    expect(getProvider("opencode-go")?.name).toBe("OpenCode Go");
    expect(getProvider("xfyun-maas")?.name).toBe("讯飞 MaaS");
    expect(getProvider("aliyun-bailian")?.name).toBe("阿里云百炼");
    expect(getProvider("volc-ark")?.name).toBe("火山方舟");
    expect(getProvider("deepseek")?.name).toBe("DeepSeek");
    expect(getProvider("zhipu")?.name).toBe("智谱 BigModel");
    expect(isProviderId("openrouter")).toBe(true);
    expect(isProviderId("aliyun-bailian")).toBe(true);
    expect(isProviderId("volc-ark")).toBe(true);
    expect(isProviderId("deepseek")).toBe(true);
    expect(isProviderId("zhipu")).toBe(true);
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
    expect(result.snapshot.summary).toContain("Missing workspaceId, auth cookie, or API key");
  });

  it("uses Bearer auth when an OpenCode API key is configured", async () => {
    const html = [
      "<html><script>",
      "rollingUsage:$R[10]={usagePercent:12,resetInSec:7200}",
      "weeklyUsage:$R[11]={resetInSec:500000,usagePercent:34}",
      "monthlyUsage:$R[12]={usagePercent:45,resetInSec:2480000}",
      "</script></html>",
    ].join("");

    const seenHeaders: Record<string, string>[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.headers) {
        const headers: Record<string, string> = {};
        const h = new Headers(init.headers);
        h.forEach((v, k) => { headers[k] = v; });
        seenHeaders.push(headers);
      }
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });

    const result = await fetchOpenCodeGoSnapshot({
      now: new Date("2026-06-16T07:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        workspaceId: "wrk_abc",
        apiKey: "sk-test-key",
      },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows.map((w) => w.key)).toEqual(["rolling", "weekly", "monthly"]);
    expect(result.snapshot.windows[0]).toMatchObject({
      used: 12,
      remaining: 88,
      percentUsed: 12,
    });
    expect(result.snapshot.meta).toMatchObject({ fetchMethod: "api_key" });
    expect(seenHeaders[0]).toMatchObject({ Authorization: "Bearer sk-test-key" });
    expect(seenHeaders[0]).not.toHaveProperty("Cookie");
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

  it("keeps login_required when browser fallback is enabled but no renderer or binding is available", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("", {
        status: 302,
        headers: { location: "https://auth.opencode.ai/authorize?client_id=app" },
      });
    });

    const result = await fetchOpenCodeGoSnapshot({
      now: new Date("2026-06-16T07:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        workspaceId: "wrk_123",
        authCookie: "auth=abc123",
        browserFallbackEnabled: true,
      },
    });

    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.meta).toMatchObject({
      fetchMethod: "worker_fetch",
      browserFallbackAttempted: true,
      browserFallbackStatus: "missing_binding",
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

describe("volc-ark adapter", () => {
  it("returns login_required when the auth cookie is missing", async () => {
    const result = await fetchVolcArkSnapshot({
      now: new Date("2026-06-17T00:00:00.000Z"),
      config: {},
    });

    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.summary).toContain("cookie");
  });

  it("parses the GetCodingPlanUsage response into a ready snapshot", async () => {
    const seenHeaders: Record<string, string>[] = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      if (init?.headers) {
        // 直接读取原始 headers 对象，避免 new Headers() 按 WHATWG 规范丢弃 Cookie 等禁止头
        seenHeaders.push(init.headers as Record<string, string>);
      }
      return new Response(
        JSON.stringify({
          ResponseMetadata: { RequestId: "req-1", Action: "GetCodingPlanUsage" },
          Result: {
            Status: "Running",
            UpdateTimestamp: 1781678769,
            QuotaUsage: [
              { Level: "session", Percent: 8.14, ResetTimestamp: 1781688895 },
              { Level: "weekly", Percent: 13.87, ResetTimestamp: 1782057600 },
              { Level: "monthly", Percent: 6.93, ResetTimestamp: 1784303999 },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await fetchVolcArkSnapshot({
      now: new Date("2026-06-17T06:46:09.000Z"),
      fetchImpl: fetchImpl,
      config: { authCookie: "csrfToken=abc123; digest=jwt-token; AccountID=2105060814" },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows.map((w) => w.key)).toEqual(["session", "weekly", "monthly"]);
    expect(result.snapshot.windows[0]).toMatchObject({
      label: "5小时",
      used: 8.14,
      limit: 100,
      remaining: 91.86,
      percentUsed: 8.14,
    });
    expect(result.snapshot.metrics).toMatchObject({
      planStatus: "Running",
      sessionPercent: 8.14,
      weeklyPercent: 13.87,
      monthlyPercent: 6.93,
    });
    // 确认 csrf token 从 cookie 提取并写入请求头
    expect(seenHeaders[0]["x-csrf-token"]).toBe("abc123");
    expect(seenHeaders[0]["Cookie"]).toContain("digest=jwt-token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects non-Volcengine API URLs before sending cookies", async () => {
    const fetchImpl = vi.fn(async () => new Response("should not fetch"));

    const result = await fetchVolcArkSnapshot({
      now: new Date("2026-06-17T00:00:00.000Z"),
      fetchImpl: fetchImpl,
      config: {
        apiUrl: "https://example.com/api/coding-plan/usage",
        authCookie: "csrfToken=abc; digest=jwt",
      },
    });

    expect(result.snapshot.status).toBe("error");
    expect(result.snapshot.summary).toContain("API URL");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports login_required on HTTP 401", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("{}", { status: 401, headers: { "content-type": "application/json" } }),
    );

    const result = await fetchVolcArkSnapshot({
      now: new Date("2026-06-17T00:00:00.000Z"),
      fetchImpl: fetchImpl,
      config: { authCookie: "csrfToken=abc; digest=expired" },
    });

    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.summary).toContain("401");
  });

  it("falls back to the default API URL when apiUrl is an empty string", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ Result: { Status: "Running", QuotaUsage: [] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await fetchVolcArkSnapshot({
      now: new Date("2026-06-17T00:00:00.000Z"),
      fetchImpl: fetchImpl,
      config: { authCookie: "csrfToken=abc; digest=jwt", apiUrl: "" },
    });

    // 空 apiUrl 应回退到默认火山引擎端点，不应报错
    expect(result.snapshot.status).not.toBe("error");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("deepseek adapter", () => {
  it("returns login_required when API key and token are missing", async () => {
    const result = await fetchDeepSeekSnapshot({
      now: new Date("2026-08-13T00:00:00.000Z"),
      config: {},
    });

    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.summary).toContain("DeepSeek");
    expect(result.snapshot.meta).toMatchObject({ entryUrl: "https://platform.deepseek.com/usage" });
  });

  it("parses platform usage into a ready snapshot", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const s = String(url);
      if (s.includes("get_user_summary")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              biz_code: 0,
              biz_data: {
                normal_wallets: [{ currency: "CNY", balance: "48.8835618400000000" }],
                bonus_wallets: [{ currency: "CNY", balance: "0" }],
                total_costs: [{ currency: "CNY", amount: "1.1164381600000000" }],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (s.includes("by_api_key/amount")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              biz_code: 0,
              biz_data: {
                series: [
                  {
                    model: "deepseek-v4-pro",
                    buckets: [
                      { time: 1786550400, usage: { RESPONSE_TOKEN: 41541, REQUEST: 15, PROMPT_CACHE_HIT_TOKEN: 3344384, PROMPT_CACHE_MISS_TOKEN: 240948 } },
                    ],
                  },
                  {
                    model: "deepseek-v4-flash",
                    buckets: [
                      { time: 1786550400, usage: { RESPONSE_TOKEN: 446, REQUEST: 3, PROMPT_CACHE_HIT_TOKEN: 99328, PROMPT_CACHE_MISS_TOKEN: 57860 } },
                    ],
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (s.includes("by_api_key/cost")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              biz_code: 0,
              biz_data: {
                data: [
                  {
                    currency: "CNY",
                    series: [
                      { model: "deepseek-v4-pro", buckets: [{ time: 1786550400, cost: "1.0556996000000000" }] },
                      { model: "deepseek-v4-flash", buckets: [{ time: 1786550400, cost: "0.0607385600000000" }] },
                    ],
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${s}`);
    });

    const result = await fetchDeepSeekSnapshot({
      now: new Date("2026-08-13T02:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: { userToken: "platform-token", authCookie: "HWWAFSESID=abc; smidV2=def" },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows.map((w) => w.key)).toEqual([
      "balance",
      "cost30d",
      "tokens30d",
      "requests30d",
    ]);
    expect(result.snapshot.metrics).toMatchObject({
      balance: 48.88356184,
      totalCost: 1.11643816,
      cost30d: 1.11643816,
      requests30d: 18,
      tokens30d: 3784507,
      promptCacheHitTokens30d: 3443712,
      promptCacheMissTokens30d: 298808,
      outputTokens30d: 41987,
    });
    expect(result.snapshot.meta.fetchMethod).toBe("platform_usage");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("falls back to the official balance API when only apiKey is configured", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: "CNY", total_balance: "49.01", granted_balance: "0.00", topped_up_balance: "49.01" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await fetchDeepSeekSnapshot({
      now: new Date("2026-08-13T02:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: { apiKey: "sk-test" },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.meta.fetchMethod).toBe("balance_api");
    expect(result.snapshot.windows.map((w) => w.key)).toEqual(["balance"]);
    expect(result.snapshot.metrics).toMatchObject({ balance: 49.01, currency: "CNY" });
  });

  it("returns partial when platform usage fails and no apiKey is configured", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));

    const result = await fetchDeepSeekSnapshot({
      now: new Date("2026-08-13T02:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: { userToken: "platform-token", authCookie: "HWWAFSESID=abc" },
    });

    expect(result.snapshot.status).toBe("partial");
    expect(result.snapshot.summary).toContain("DeepSeek");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("always requests the trusted platform origin regardless of pageUrl", async () => {
    const fetchedUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      fetchedUrls.push(String(url));
      return new Response("{}", { status: 500 });
    });

    const result = await fetchDeepSeekSnapshot({
      now: new Date("2026-08-13T02:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        userToken: "platform-token",
        authCookie: "HWWAFSESID=abc",
        pageUrl: "https://evil.example.com/usage",
      },
    });

    expect(fetchedUrls.length).toBe(3);
    expect(fetchedUrls.every((url) => url.includes("platform.deepseek.com"))).toBe(true);
    expect(result.snapshot.status).toBe("partial");
  });
});

describe("zhipu adapter", () => {
  it("returns login_required when auth cookie and token are missing", async () => {
    const result = await fetchZhipuSnapshot({
      now: new Date("2026-08-21T02:00:00.000Z"),
      config: {},
    });

    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.summary).toContain("智谱");
    expect(result.snapshot.meta).toMatchObject({ entryUrl: "https://bigmodel.cn/coding-plan/personal/usage" });
  });

  it("parses quota limits and 7d/30d credit usage into a ready snapshot", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const s = String(url);
      if (s.includes("/monitor/usage/quota/limit")) {
        return new Response(
          JSON.stringify({
            code: 200,
            data: {
              level: "pro",
              limits: [
                {
                  type: "CREDIT_LIMIT",
                  usage: 12000,
                  currentValue: 2024,
                  percentage: 16,
                  nextResetTime: "2026-08-21 15:39:20",
                },
                {
                  type: "CREDIT_LIMIT",
                  usage: 60000,
                  currentValue: 2024,
                  percentage: 3,
                  nextResetTime: "2026-08-28 09:58:00",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (s.includes("/monitor/credit-usage/usage-detail")) {
        const decoded = decodeURIComponent(s);
        const is7d = decoded.includes("startTime=2026-08-15");
        return new Response(
          JSON.stringify({
            code: 200,
            data: {
              summary: { cacheHitRate: { value: is7d ? "0.9552" : "0.92" } },
              modelUsage: {
                xTime: [],
                totalUsage: {
                  totalTokens: is7d ? 44865163 : 90000000,
                  totalCredits: is7d ? "4427.2874" : "6536.3966",
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${s}`);
    });

    const result = await fetchZhipuSnapshot({
      now: new Date("2026-08-21T02:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        authCookie: "bigmodel_token_production=token-abc; acw_tc=waf; ssxmod_itna=itna",
        authToken: "token-abc",
      },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows.map((w) => w.key)).toEqual(["rp5h", "weekly"]);
    expect(result.snapshot.windows.map((w) => w.label)).toEqual(["5小时", "每周"]);
    expect(result.snapshot.windows[0]).toMatchObject({
      used: 2024,
      limit: 12000,
      percentUsed: 16,
      percentRemaining: 84,
      resetAt: "2026-08-21T07:39:20.000Z",
    });
    expect(result.snapshot.windows[1]).toMatchObject({
      used: 2024,
      limit: 60000,
      percentUsed: 3,
      resetAt: "2026-08-28T01:58:00.000Z",
    });
    expect(result.snapshot.metrics).toMatchObject({
      quotaLevel: "pro",
      cacheHitRate7d: 0.9552,
      totalCredits7d: 4427.2874,
      totalTokens7d: 44865163,
      cacheHitRate30d: 0.92,
      totalCredits30d: 6536.3966,
      totalTokens30d: 90000000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects a non-bigmodel api base and never sends the request", async () => {
    const fetchImpl = vi.fn();

    const result = await fetchZhipuSnapshot({
      now: new Date("2026-08-21T02:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        authCookie: "bigmodel_token_production=token-abc",
        apiBase: "https://evil.example.com",
      },
    });

    expect(result.snapshot.status).toBe("error");
    expect(result.snapshot.summary).toContain("不安全");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns login_required when the quota endpoint responds 401", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));

    const result = await fetchZhipuSnapshot({
      now: new Date("2026-08-21T02:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        authCookie: "bigmodel_token_production=token-abc; acw_tc=waf",
        authToken: "token-abc",
      },
    });

    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.summary).toContain("登录态可能已过期");
    expect(result.snapshot.metrics).toMatchObject({ httpStatus: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns partial when endpoints return no usable data", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ code: 200, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await fetchZhipuSnapshot({
      now: new Date("2026-08-21T02:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: { authToken: "token-abc" },
    });

    expect(result.snapshot.status).toBe("partial");
    expect(result.snapshot.summary).toContain("未返回可用数据");
  });
});