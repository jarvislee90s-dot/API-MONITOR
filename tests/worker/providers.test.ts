import { describe, expect, it, vi } from "vitest";

import { getProvider, isProviderId, listProviders } from "../../worker/providers/registry";
import { fetchOpenRouterSnapshot } from "../../worker/providers/openrouter";
import { fetchOpenCodeGoSnapshot } from "../../worker/providers/opencode-go";
import { fetchXfyunMaaSSnapshot } from "../../worker/providers/xfyun-maas";

describe("provider registry", () => {
  it("exposes the three cloud adapters", () => {
    expect(listProviders().map((provider) => provider.id)).toEqual([
      "openrouter",
      "opencode-go",
      "xfyun-maas",
    ]);
    expect(getProvider("openrouter")?.name).toBe("OpenRouter");
    expect(getProvider("opencode-go")?.name).toBe("OpenCode Go");
    expect(getProvider("xfyun-maas")?.name).toBe("讯飞 MaaS");
    expect(isProviderId("openrouter")).toBe(true);
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
