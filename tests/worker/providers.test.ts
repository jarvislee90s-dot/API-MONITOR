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
import { fetchOllamaSnapshot } from "../../worker/providers/ollama";
import {
  fetchChatgptSnapshot,
  isTrustedChatgptUrl,
  mergeChatgptBuckets,
  parseCodexWindows,
  parseWebRateLimitWindows,
} from "../../worker/providers/chatgpt";

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
      "ollama",
    ]);
    expect(getProvider("openrouter")?.name).toBe("OpenRouter");
    expect(getProvider("opencode-go")?.name).toBe("OpenCode Go");
    expect(getProvider("xfyun-maas")?.name).toBe("讯飞 MaaS");
    expect(getProvider("aliyun-bailian")?.name).toBe("阿里云百炼");
    expect(getProvider("volc-ark")?.name).toBe("火山方舟");
    expect(getProvider("deepseek")?.name).toBe("DeepSeek");
    expect(getProvider("zhipu")?.name).toBe("智谱 BigModel");
    expect(getProvider("ollama")?.name).toBe("Ollama Pro");
    expect(isProviderId("openrouter")).toBe(true);
    expect(isProviderId("aliyun-bailian")).toBe(true);
    expect(isProviderId("volc-ark")).toBe(true);
    expect(isProviderId("deepseek")).toBe(true);
    expect(isProviderId("zhipu")).toBe(true);
    expect(isProviderId("ollama")).toBe(true);
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

describe("ollama adapter", () => {
  const NOW = new Date("2026-08-23T06:00:00.000Z");

  it("returns login_required when api key is missing", async () => {
    const result = await fetchOllamaSnapshot({ now: NOW, config: {} });
    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.metrics).toMatchObject({ hasApiKey: false });
  });

  it("parses session/weekly usage and model request counts", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({
        activity: { cost: "0.00000", period: { type: "last_4_weeks" }, models: [] },
        limits: {
          session: {
            usage: 0.068,
            models: [
              { name: "deepseek-v4-flash:0731", request_count: 239 },
              { name: "kimi-k2.6", request_count: 10 },
            ],
          },
          weekly: {
            usage: 0.007,
            models: [{ name: "deepseek-v4-flash:0731", request_count: 249 }],
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const result = await fetchOllamaSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: { apiKey: "ollama-key", apiUrl: "https://ollama.com/v1" },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows.map((w) => w.key)).toEqual(["rp5h", "weekly"]);
    expect(result.snapshot.windows[0]).toMatchObject({ label: "5小时", used: 6.8, limit: 100, percentUsed: 6.8, resetAt: "2026-08-23T10:00:00.000Z" });
    expect(result.snapshot.windows[1]).toMatchObject({ label: "每周", used: 0.7, limit: 100, percentUsed: 0.7, resetAt: "2026-08-24T00:00:00.000Z" });
    expect(result.snapshot.metrics).toMatchObject({
      sessionUsagePercent: 6.8,
      weeklyUsagePercent: 0.7,
      weeklyRequestCount: 249,
    });
    const parsed = JSON.parse(String(result.snapshot.metrics.weeklyModels));
    expect(parsed).toEqual([{ name: "deepseek-v4-flash:0731", requests: 249 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://ollama.com/api/usage");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer ollama-key" });
  });

  it("computes weekly reset at next Monday even when today is Monday", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          limits: {
            session: { usage: 0.05, models: [] },
            weekly: { usage: 0.01, models: [] },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const mondayNow = new Date("2026-08-24T02:00:00.000Z"); // 周一
    const result = await fetchOllamaSnapshot({
      now: mondayNow,
      fetchImpl: fetchImpl as typeof fetch,
      config: { apiKey: "ollama-key", apiUrl: "https://ollama.com/v1" },
    });

    expect(result.snapshot.windows[0].resetAt).toBe("2026-08-24T05:00:00.000Z");
    expect(result.snapshot.windows[1].resetAt).toBe("2026-08-31T00:00:00.000Z");
  });

  it("rejects a non-ollama api url and never sends the request", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchOllamaSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: { apiKey: "ollama-key", apiUrl: "https://evil.example.com/v1" },
    });
    expect(result.snapshot.status).toBe("error");
    expect(result.snapshot.summary).toContain("不安全");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps 401/403 to login_required", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    const result = await fetchOllamaSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: { apiKey: "bad-key", apiUrl: "https://ollama.com/v1" },
    });
    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.summary).toContain("登录态可能已失效");
  });

  it("returns login_required when neither cookie nor api key is configured", async () => {
    const result = await fetchOllamaSnapshot({ now: NOW, config: {} });
    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.metrics).toMatchObject({ hasAuthCookie: false, hasApiKey: false });
  });
});

describe("ollama settings page (cookie path)", () => {
  const NOW = new Date("2026-10-07T02:40:00.000Z");

  // 取自真实 settings 页的服务端渲染片段(结构一致,数值为样例)
  const settingsHtml = `
    <span class="text-sm ">Session usage</span> <span class="text-sm "> 9.7% used </span>
    <div aria-label="Session usage 9.7% used">
      <button data-usage-segment data-model="glm-5.3-flash" data-requests="14" aria-label="glm-5.3-flash: 14 requests"></button>
      <button data-usage-segment data-model="deepseek-v4.1-flash" data-requests="352" aria-label="deepseek-v4.1-flash: 352 requests"></button>
    </div>
    <div class="local-time" data-time="2026-10-07T03:00:00Z"> Resets in 11 minutes. </div>
    <span class="text-sm">Weekly usage</span> <span class="text-sm ">65.1% used</span>
    <div aria-label="Weekly usage 65.1% used">
      <button data-usage-segment data-model="glm-5.3-flash" data-requests="56"></button>
      <button data-usage-segment data-model="deepseek-v4.1-flash" data-requests="9650"></button>
    </div>
    <div class="local-time" data-time="2026-10-12T00:00:00Z"> Resets in 4 days. </div>
    <div id="weekly-usage-models">
      <div>Models used this week</div>
      <div><span title="glm-5.3-flash">glm-5.3-flash</span><span> 56 requests </span></div>
      <div><span title="deepseek-v4.1-flash">deepseek-v4.1-flash</span><span> 9,650 requests </span></div>
    </div>
    <form method="POST" action="/settings"></form>
  `;

  it("parses session/weekly percent, reset times and model requests from settings HTML", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(settingsHtml, { status: 200, headers: { "content-type": "text/html" } }),
    );

    const result = await fetchOllamaSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: { authCookie: "aid=abc; __Secure-session=xyz", pageUrl: "https://ollama.com/settings" },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows.map((w) => w.key)).toEqual(["rp5h", "weekly"]);
    // 重置时间取自页面 data-time（页面是权威值，不再用本地推算）
    expect(result.snapshot.windows[0]).toMatchObject({
      label: "5小时",
      used: 9.7,
      percentUsed: 9.7,
      resetAt: "2026-10-07T03:00:00.000Z",
    });
    expect(result.snapshot.windows[1]).toMatchObject({
      label: "每周",
      used: 65.1,
      percentUsed: 65.1,
      resetAt: "2026-10-12T00:00:00.000Z",
    });
    expect(result.snapshot.metrics).toMatchObject({
      sessionUsagePercent: 9.7,
      weeklyUsagePercent: 65.1,
      sessionRequestCount: 366,
      weeklyRequestCount: 9706,
      weeklyModelCount: 2,
      fetchMethod: "cookie",
    });
    expect(JSON.parse(String(result.snapshot.metrics.weeklyModels))).toEqual([
      { name: "deepseek-v4.1-flash", requests: 9650 },
      { name: "glm-5.3-flash", requests: 56 },
    ]);

    // 只请求一次(网页路径命中即返回,不回退 API Key)
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://ollama.com/settings");
    expect((init.headers as Record<string, string>).Cookie).toContain("__Secure-session=xyz");
  });

  it("parses model segments when attributes span multiple lines", async () => {
    // 真实页面里属性间存在换行,解析不能依赖固定空白
    const multilineHtml = `
      <div aria-label="Session usage 9.7% used">
        <button
          type="button"
          class="relative h-full"
          data-usage-segment
          data-model="glm-5.3-flash"
          data-requests="14"
        ></button>
        <button
          data-requests="352"
          data-model="deepseek-v4.1-flash"
          data-usage-segment
        ></button>
      </div>
      <div aria-label="Weekly usage 65.1% used"></div>
      <div id="weekly-usage-models">
        <div><span title="glm-5.3-flash">glm-5.3-flash</span><span> 56 requests </span></div>
      </div>
      <form method="POST" action="/settings"></form>
    `;
    const fetchImpl = vi.fn(async () => new Response(multilineHtml, { status: 200 }));

    const result = await fetchOllamaSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: { authCookie: "aid=abc; __Secure-session=xyz", pageUrl: "https://ollama.com/settings" },
    });

    expect(result.snapshot.metrics.sessionRequestCount).toBe(366);
    expect(JSON.parse(String(result.snapshot.metrics.weeklyModels))).toEqual([
      { name: "glm-5.3-flash", requests: 56 },
    ]);
  });

  it("prefers cookie path over api key and does not call /api/usage", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/settings")
        ? new Response(settingsHtml, { status: 200 })
        : new Response(JSON.stringify({ limits: { weekly: { usage: 0.01, models: [] } } }), { status: 200 }),
    );

    const result = await fetchOllamaSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: { authCookie: "aid=abc; __Secure-session=xyz", apiKey: "ollama-key", apiUrl: "https://ollama.com/v1" },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.metrics.fetchMethod).toBe("cookie");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/settings");
  });

  it("falls back to api key when the settings page is not usable", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/settings")) return new Response("<html>login</html>", { status: 200 });
      return new Response(
        JSON.stringify({ limits: { session: { usage: 0.068, models: [] }, weekly: { usage: 0.007, models: [] } } }),
        { status: 200 },
      );
    });

    const result = await fetchOllamaSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: { authCookie: "aid=abc; __Secure-session=xyz", apiKey: "ollama-key", apiUrl: "https://ollama.com/v1" },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.metrics).toMatchObject({ fetchMethod: "apiKey", sessionUsagePercent: 6.8 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports login_required when the cookie is expired and no api key is set", async () => {
    const fetchImpl = vi.fn(async () => new Response("expired", { status: 401 }));
    const result = await fetchOllamaSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: { authCookie: "aid=abc; __Secure-session=stale", pageUrl: "https://ollama.com/settings" },
    });

    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.summary).toContain("refresh-ollama-cookie");
  });

  it("reports partial with a hint when api key channel returns no quota data", async () => {
    // 现状:官方 /api/usage 只返回 request_count/buckets,没有 limits
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ range: "7d", totals: { request_count: 25145 }, buckets: [] }), { status: 200 }),
    );

    const result = await fetchOllamaSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: { apiKey: "ollama-key", apiUrl: "https://ollama.com/v1" },
    });

    expect(result.snapshot.status).toBe("partial");
    expect(result.snapshot.summary).toContain("cookie");
  });
});

describe("chatgpt adapter (codex 链路)", () => {
  const NOW = new Date("2026-10-14T00:00:00.000Z");

  it("returns login_required when no codex or session credentials are configured", async () => {
    const result = await fetchChatgptSnapshot({ now: NOW, config: {} });

    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.metrics).toMatchObject({ hasCodexCredentials: false, hasSessionToken: false });
  });

  it("仅放行 chatgpt.com 系与 auth.openai.com 的 https 域名", () => {
    expect(isTrustedChatgptUrl("https://chatgpt.com/backend-api/codex/rate_limits")).toBe(true);
    expect(isTrustedChatgptUrl("https://auth.openai.com/oauth/token")).toBe(true);
    expect(isTrustedChatgptUrl("https://evil.example.com/oauth/token")).toBe(false);
    expect(isTrustedChatgptUrl("http://chatgpt.com/api/auth/session")).toBe(false);
    expect(isTrustedChatgptUrl("https://notchatgpt.com/backend-api")).toBe(false);
  });

  it("sends Bearer and chatgpt-account-id headers and parses codex windows", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          rate_limits: {
            codex_5h: { used_percent: 42.5, resets_in_seconds: 3600 },
            codex_weekly: { used_percent: 0.25, reset_at: "2026-10-19T00:00:00Z" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await fetchChatgptSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: { accessToken: "fake-access-token-1", accountId: "fake-account-1" },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows.map((w) => w.key)).toEqual(["codex_5h", "codex_weekly"]);
    expect(result.snapshot.windows[0]).toMatchObject({
      label: "Codex 5小时",
      percentUsed: 42.5,
      resetAt: "2026-10-14T01:00:00.000Z",
    });
    expect(result.snapshot.windows[1]).toMatchObject({
      label: "Codex 每周",
      percentUsed: 25,
      resetAt: "2026-10-19T00:00:00.000Z",
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/rate_limits");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer fake-access-token-1",
      "chatgpt-account-id": "fake-account-1",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("tolerates used/limit 形态的 codex 响应", () => {
    const windows = parseCodexWindows(
      {
        rate_limits: {
          primary: { used: 40, limit: 200, resets_in_seconds: 7200 },
          secondary: { used: 30, limit: 1000, reset_at: "2026-10-16T00:00:00Z" },
        },
      },
      NOW,
    );

    expect(windows.map((w) => w.key)).toEqual(["codex_5h", "codex_weekly"]);
    expect(windows[0]).toMatchObject({ percentUsed: 20, resetAt: "2026-10-14T02:00:00.000Z" });
    expect(windows[1]).toMatchObject({ percentUsed: 3 });
  });

  it("refreshes the codex token on 401 and carries credentialUpdate", async () => {
    let rateLimitsCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const value = String(
        typeof input === "string" ? input : input instanceof Request ? input.url : input,
      );
      if (value === "https://auth.openai.com/oauth/token") {
        return new Response(
          JSON.stringify({ access_token: "fake-access-token-2", refresh_token: "fake-refresh-token-2" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      rateLimitsCalls += 1;
      if (rateLimitsCalls === 1) {
        return new Response("{}", { status: 401 });
      }
      return new Response(
        JSON.stringify({ rate_limits: { codex_5h: { used_percent: 10 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await fetchChatgptSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        accessToken: "fake-access-token-1",
        refreshToken: "fake-refresh-token-1",
        accountId: "fake-account-1",
      },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.metrics.codexTokenRefreshed).toBe(true);
    expect(result.credentialUpdate).toEqual({
      accessToken: "fake-access-token-2",
      refreshToken: "fake-refresh-token-2",
    });

    // 刷新请求体：grant_type + refresh_token + codex CLI 公开 client_id
    const tokenCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).includes("auth.openai.com"),
    ) as unknown as [string, RequestInit];
    expect(JSON.parse(String(tokenCall[1].body))).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "fake-refresh-token-1",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });

    // 重试必须用新 token（调用序列：rate_limits(401) → token 刷新 → rate_limits 重试）
    const retryCall = fetchImpl.mock.calls[2] as unknown as [string, RequestInit];
    expect((retryCall[1].headers as Record<string, string>).Authorization).toBe("Bearer fake-access-token-2");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("refreshes the codex token on a plain 403 without cf-mitigated header", async () => {
    let rateLimitsCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const value = String(
        typeof input === "string" ? input : input instanceof Request ? input.url : input,
      );
      if (value === "https://auth.openai.com/oauth/token") {
        return new Response(
          JSON.stringify({ access_token: "fake-access-token-2", refresh_token: "fake-refresh-token-2" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      rateLimitsCalls += 1;
      if (rateLimitsCalls === 1) {
        // 普通 403（无 cf-mitigated 头）：按凭据失效处理，应触发 token 刷新
        return new Response("forbidden", { status: 403 });
      }
      return new Response(
        JSON.stringify({ rate_limits: { codex_5h: { used_percent: 8 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await fetchChatgptSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        accessToken: "fake-access-token-1",
        refreshToken: "fake-refresh-token-1",
        accountId: "fake-account-1",
      },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.metrics.codexTokenRefreshed).toBe(true);
    // 发生了 token 刷新调用（rate_limits 403 → token 刷新 → rate_limits 重试）
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
    const retryCall = fetchImpl.mock.calls[2] as unknown as [string, RequestInit];
    expect(String(retryCall[0])).toBe("https://chatgpt.com/backend-api/codex/rate_limits");
    expect((retryCall[1].headers as Record<string, string>).Authorization).toBe(
      "Bearer fake-access-token-2",
    );
  });

  it("keeps credentialUpdate when refresh succeeds but the retry still returns 401", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const value = String(
        typeof input === "string" ? input : input instanceof Request ? input.url : input,
      );
      if (value === "https://auth.openai.com/oauth/token") {
        return new Response(
          JSON.stringify({ access_token: "fake-access-token-2", refresh_token: "fake-refresh-token-2" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 401 });
    });

    const result = await fetchChatgptSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        accessToken: "fake-access-token-1",
        refreshToken: "fake-refresh-token-1",
        accountId: "fake-account-1",
      },
    });

    expect(result.snapshot.status).toBe("login_required");
    // refresh token 轮换后旧值可能已作废：重试失败也要带出新 token
    expect(result.credentialUpdate).toEqual({
      accessToken: "fake-access-token-2",
      refreshToken: "fake-refresh-token-2",
    });
  });

  it("does not refresh the codex token on a Cloudflare challenge (403 + cf-mitigated)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } }),
    );

    const result = await fetchChatgptSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        accessToken: "fake-access-token-1",
        refreshToken: "fake-refresh-token-1",
        accountId: "fake-account-1",
      },
    });

    // CF 质询是 IP 拦截而非凭据失效：不得消耗 token 刷新调用
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.credentialUpdate).toBeUndefined();
    // codex 桶 cfChallenge=true 且无其他数据源 → error 分支，summary 提示 Cloudflare 拦截
    expect(result.snapshot.status).toBe("error");
    expect(result.snapshot.summary).toContain("Cloudflare 拦截");
  });

  it("returns login_required when token refresh fails and no session cookie", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const value = String(
        typeof input === "string" ? input : input instanceof Request ? input.url : input,
      );
      if (value === "https://auth.openai.com/oauth/token") {
        return new Response("invalid_grant", { status: 400 });
      }
      return new Response("{}", { status: 401 });
    });

    const result = await fetchChatgptSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        accessToken: "fake-access-token-1",
        refreshToken: "fake-refresh-token-1",
        accountId: "fake-account-1",
      },
    });

    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.summary).toContain("登录态已失效");
    // 未配置 sessionToken 时不应指责"网页 session 无效"，只说 Codex 凭据失效
    expect(result.snapshot.summary).not.toContain("网页 session");
    expect(result.snapshot.summary).toContain("Codex");
    expect(result.snapshot.windows).toEqual([]);
  });

  it("mergeChatgptBuckets：三链路全失败且凭据未耗尽时为 error", () => {
    const result = mergeChatgptBuckets({
      codex: { attempted: true, windows: [], loginRequired: false, cfChallenge: false, fetchFailed: true },
      web: { attempted: true, windows: [], loginRequired: false, cfChallenge: true, fetchFailed: false },
      subscription: { attempted: true, plan: null, planRenewAt: null, notFound: false },
      hasCodexCredentials: true,
      hasSessionToken: true,
      capturedAt: "2026-10-14T00:00:00.000Z",
      sourceUrl: "https://chatgpt.com",
      credentialUpdate: null,
    });

    expect(result.snapshot.status).toBe("error");
  });
});

describe("chatgpt adapter (网页/订阅链路)", () => {
  const NOW = new Date("2026-10-14T00:00:00.000Z");

  it("exchanges session token for accessToken and parses message_cap windows", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const value = String(
        typeof input === "string" ? input : input instanceof Request ? input.url : input,
      );
      if (value === "https://chatgpt.com/api/auth/session") {
        return new Response(JSON.stringify({ accessToken: "fake-web-access-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (value === "https://chatgpt.com/backend-api/rate_limits") {
        return new Response(
          JSON.stringify({
            message_cap: { max_cap: 10, remaining_cap: 7, reset_at: "2026-10-14T03:00:00Z" },
            gpt_5x_message_cap: { max_cap: 40, remaining_cap: 30, reset_at: "2026-10-14T03:00:00Z" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (value === "https://chatgpt.com/backend-api/accounts/check") {
        return new Response(JSON.stringify({ account: { plan_type: "free" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected ${value}`);
    });

    const result = await fetchChatgptSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: { sessionToken: "fake-session-token" },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows.map((w) => w.key)).toEqual(["web_5h_default", "web_5h_gpt_5x"]);
    expect(result.snapshot.windows[0]).toMatchObject({
      label: "对话 5小时·default",
      percentUsed: 30,
      resetAt: "2026-10-14T03:00:00.000Z",
    });
    expect(result.snapshot.windows[1]).toMatchObject({ percentUsed: 25 });
    expect(result.snapshot.metrics).toMatchObject({ plan: "free", planRenewAt: null, webFetchMethod: "direct" });

    const [sessionUrl, sessionInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(sessionUrl)).toBe("https://chatgpt.com/api/auth/session");
    expect((sessionInit.headers as Record<string, string>).Cookie).toBe(
      "__Secure-next-auth.session-token=fake-session-token",
    );
    const [limitsUrl, limitsInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(String(limitsUrl)).toBe("https://chatgpt.com/backend-api/rate_limits");
    expect((limitsInit.headers as Record<string, string>).Authorization).toBe("Bearer fake-web-access-token");
  });

  it("parses the new grouped array shape with slug pass-through", () => {
    const windows = parseWebRateLimitWindows(
      [{ slug: "gpt_5_high", used_percent: 0.4, resets_in_seconds: 900 }],
      NOW,
    );

    expect(windows.map((w) => w.key)).toEqual(["web_5h_gpt_5_high"]);
    expect(windows[0]).toMatchObject({
      label: "对话 5小时·gpt_5_high",
      percentUsed: 40,
      resetAt: "2026-10-14T00:15:00.000Z",
    });
  });

  it("maps a Cloudflare challenge on the web link to partial", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const value = String(
        typeof input === "string" ? input : input instanceof Request ? input.url : input,
      );
      if (value === "https://chatgpt.com/api/auth/session") {
        return new Response("challenge", {
          status: 403,
          headers: { "cf-mitigated": "challenge" },
        });
      }
      return new Response(
        JSON.stringify({ rate_limits: { codex_5h: { used_percent: 12 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await fetchChatgptSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        accessToken: "fake-access-token-1",
        accountId: "fake-account-1",
        sessionToken: "fake-session-token",
      },
    });

    expect(result.snapshot.status).toBe("partial");
    expect(result.snapshot.summary).toContain("Cloudflare 拦截");
    expect(result.snapshot.metrics.webFetchMethod).toBe("snapshot_fallback");
  });

  it("treats subscription 404 as the free plan without degrading", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const value = String(
        typeof input === "string" ? input : input instanceof Request ? input.url : input,
      );
      if (value === "https://chatgpt.com/api/auth/session") {
        return new Response(JSON.stringify({ accessToken: "fake-web-access-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (value === "https://chatgpt.com/backend-api/rate_limits") {
        return new Response(
          JSON.stringify({ message_cap: { max_cap: 10, remaining_cap: 10, reset_at: "2026-10-14T03:00:00Z" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (value === "https://chatgpt.com/backend-api/accounts/check") {
        return new Response("not found", { status: 404 });
      }
      throw new Error(`unexpected ${value}`);
    });

    const result = await fetchChatgptSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: { sessionToken: "fake-session-token" },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.metrics).toMatchObject({ plan: "free", planRenewAt: null });
  });

  it("merges three buckets into ready with the plus plan and renewal date", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const value = String(
        typeof input === "string" ? input : input instanceof Request ? input.url : input,
      );
      if (value === "https://chatgpt.com/backend-api/codex/rate_limits") {
        return new Response(
          JSON.stringify({ rate_limits: { codex_5h: { used_percent: 5 }, codex_weekly: { used_percent: 10 } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (value === "https://chatgpt.com/api/auth/session") {
        return new Response(JSON.stringify({ accessToken: "fake-web-access-token" }), {
          status: 200,
          headers: { "content-type": "application/json" }});
      }
      if (value === "https://chatgpt.com/backend-api/rate_limits") {
        return new Response(
          JSON.stringify({ message_cap: { max_cap: 80, remaining_cap: 40, reset_at: "2026-10-14T03:00:00Z" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (value === "https://chatgpt.com/backend-api/accounts/check") {
        return new Response(
          JSON.stringify({
            account: { plan_type: "plus" },
            subscription: { next_renewal_date: "2026-11-01T00:00:00Z" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected ${value}`);
    });

    const result = await fetchChatgptSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        accessToken: "fake-access-token-1",
        accountId: "fake-account-1",
        sessionToken: "fake-session-token",
      },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows.map((w) => w.key)).toEqual([
      "codex_5h",
      "codex_weekly",
      "web_5h_default",
    ]);
    expect(result.snapshot.metrics).toMatchObject({
      plan: "plus",
      planRenewAt: "2026-11-01T00:00:00.000Z",
      codexTokenRefreshed: false,
      webFetchMethod: "direct",
    });
    expect(result.snapshot.summary).toContain("订阅档位 plus");
  });
});
