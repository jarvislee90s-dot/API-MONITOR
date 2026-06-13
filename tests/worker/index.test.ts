import { describe, expect, it, vi } from "vitest";

import { handleApiRequest } from "../../worker/index";
import { buildUsageDashboard } from "../../worker/dashboard";
import { RefreshSessionDurableObject } from "../../worker/durable-object/refresh-session";
import { encryptCredentialPayload } from "../../worker/security/credentials";
import type { ProviderSnapshot, WorkerEnv } from "../../worker/types";

class MemoryStorage {
  private readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

function createEnv(fetchImpl: typeof fetch): WorkerEnv {
  const objects = new Map<string, RefreshSessionDurableObject>();

  return {
    OPENROUTER_API_KEY: "sk-test",
    OPENCODE_GO_WORKSPACE_ID: "wrk_123",
    OPENCODE_GO_AUTH_COOKIE: "auth-cookie=abc",
    ALIYUN_BAILIAN_AUTH_COOKIE: "login=abc",
    XFYUN_MAAS_API_URL: "https://maas.xfyun.cn/api/subscription",
    XFYUN_MAAS_AUTH_COOKIE: "session=abc",
    REFRESH_SESSION: {
      idFromName(name: string): string {
        return name;
      },
      get(id: string) {
        let instance = objects.get(id);
        if (!instance) {
          instance = new RefreshSessionDurableObject(
            { storage: new MemoryStorage() },
            {},
          );
          objects.set(id, instance);
        }
        return {
          fetch(request: Request) {
            return instance!.fetch(request);
          },
        };
      },
    },
  } as WorkerEnv;
}

function createUsageFetchStub() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
    if (url.includes("/api/v1/auth/key")) {
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
    }

    if (url.includes("opencode.ai/workspace")) {
      return new Response(
        [
          "<html><script>",
          "rollingUsage:$R[10]={usagePercent:7,resetInSec:18000}",
          "weeklyUsage:$R[11]={resetInSec:540000,usagePercent:2}",
          "monthlyUsage:$R[12]={usagePercent:16,resetInSec:2480000}",
          "</script></html>",
        ].join(""),
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    }

    if (url.includes("maas.xfyun.cn/api/subscription")) {
      return new Response(JSON.stringify({ used: 20, limit: 100, remaining: 80 }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    throw new Error(`unexpected fetch ${url}`);
  });
}

function createSnapshot(providerId: ProviderSnapshot["providerId"], providerName: string): ProviderSnapshot {
  return {
    providerId,
    providerName,
    sourceUrl: `https://example.test/${providerId}`,
    status: "ready",
    capturedAt: "2026-06-12T00:00:00.000Z",
    summary: `${providerName} ready`,
    windows: [],
    metrics: {},
    meta: {},
  };
}

function createSnapshotWithOverrides(
  overrides: Partial<ProviderSnapshot> & Pick<ProviderSnapshot, "providerId" | "providerName">,
): ProviderSnapshot {
  return {
    providerId: overrides.providerId,
    providerName: overrides.providerName,
    sourceUrl: overrides.sourceUrl ?? `https://example.test/${overrides.providerId}`,
    status: overrides.status ?? "ready",
    capturedAt: overrides.capturedAt ?? "2026-06-12T00:00:00.000Z",
    summary: overrides.summary ?? `${overrides.providerName} ready`,
    windows: overrides.windows ?? [],
    metrics: overrides.metrics ?? {},
    meta: overrides.meta ?? {},
  };
}

describe("worker api", () => {
  it("orders dashboard cards by provider preferences and hides disabled providers", () => {
    const dashboard = buildUsageDashboard(
      [
        createSnapshot("openrouter", "OpenRouter"),
        createSnapshot("opencode-go", "OpenCode Go"),
        createSnapshot("xfyun-maas", "讯飞 MaaS"),
      ],
      {
        providerPreferences: [
          { providerKey: "opencode-go", enabled: true, displayOrder: 1 },
          { providerKey: "openrouter", enabled: false, displayOrder: 2 },
          { providerKey: "xfyun-maas", enabled: true, displayOrder: 3 },
        ],
      },
    );

    expect(dashboard.cards.map((card) => card.providerId)).toEqual(["opencode-go", "xfyun-maas"]);
    expect(dashboard.totals.providers).toBe(2);
  });

  it("keeps one provider card and nests account snapshots", () => {
    const dashboard = buildUsageDashboard([
      createSnapshotWithOverrides({
        providerId: "openrouter",
        providerName: "OpenRouter",
        summary: "主账号 loaded",
        meta: { accountId: "acc-main", accountLabel: "主账号" },
        windows: [{ key: "month", label: "Monthly", used: 10, limit: 100, remaining: 90 }],
      }),
      createSnapshotWithOverrides({
        providerId: "openrouter",
        providerName: "OpenRouter",
        summary: "备用账号 loaded",
        meta: { accountId: "acc-backup", accountLabel: "备用账号" },
        windows: [{ key: "month", label: "Monthly", used: 20, limit: 100, remaining: 80 }],
      }),
    ]);

    expect(dashboard.cards).toHaveLength(1);
    expect(dashboard.cards[0]).toMatchObject({
      providerId: "openrouter",
      providerName: "OpenRouter",
      selectedAccountId: "acc-main",
    });
    expect(dashboard.cards[0]?.accounts).toEqual([
      expect.objectContaining({
        accountId: "acc-main",
        accountLabel: "主账号",
        summary: "主账号 loaded",
      }),
      expect.objectContaining({
        accountId: "acc-backup",
        accountLabel: "备用账号",
        summary: "备用账号 loaded",
      }),
    ]);
    expect(dashboard.totals.providers).toBe(1);
  });

  it("lists the provider registry", async () => {
    const env = createEnv(fetch);
    const response = await handleApiRequest(new Request("https://api.monitor.local/api/providers"), env);
    const payload = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data.map((provider: { id: string }) => provider.id)).toEqual([
      "openrouter",
      "opencode-go",
      "xfyun-maas",
      "aliyun-bailian",
    ]);
  });

  it("returns a unified usage dashboard from /api/usage", async () => {
    const fetchImpl = createUsageFetchStub();
    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = createEnv(fetchImpl as typeof fetch);
      const response = await handleApiRequest(new Request("https://api.monitor.local/api/usage"), env);
      const payload = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.data.kind).toBe("usage_dashboard");
      expect(payload.data.cards).toHaveLength(4);
      expect(payload.data.modelSpends).toEqual([]);
      expect(payload.data.totals).toMatchObject({
        providers: 4,
        ready: 3,
        partial: 1,
        loginRequired: 0,
        error: 0,
      });
      expect(payload.data.cards[0]).toMatchObject({
        providerId: "openrouter",
        providerName: "OpenRouter",
      });
      expect(payload.data.cards[0].trend).toHaveLength(4);
      expect(payload.data.cards[1].trend).toHaveLength(3);
      expect(payload.data.cards[2].trend).toHaveLength(1);
      expect(payload.data.cards[3]).toMatchObject({
        providerId: "aliyun-bailian",
        providerName: "阿里云百炼",
        status: "partial",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to the latest ready Supabase snapshot when live usage is partial", async () => {
    const readyOpenCodeSnapshot = {
      providerId: "opencode-go",
      providerName: "OpenCode Go",
      sourceUrl: "https://opencode.ai/workspace/wrk_123/go",
      status: "ready",
      capturedAt: "2026-06-11T00:00:00.000Z",
      summary: "OpenCode Go usage windows parsed",
      windows: [
        {
          key: "weekly",
          label: "Weekly",
          used: 26,
          limit: 100,
          remaining: 74,
          percentUsed: 26,
          percentRemaining: 74,
        },
      ],
      metrics: {},
      meta: {},
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();

      if (url.includes("/api/v1/auth/key")) {
        return new Response(JSON.stringify({ data: { usage: 0, limit: 1, limit_remaining: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("opencode.ai/workspace")) {
        return new Response("<html>No usage markers in this cloud response</html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (url.includes("maas.xfyun.cn/api/subscription")) {
        return new Response(JSON.stringify({ used: 20, limit: 100, remaining: 80 }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      if (url.startsWith("https://supabase.test/rest/v1/usage_snapshots")) {
        return new Response(
          JSON.stringify([
            {
              provider_key: "opencode-go",
              payload: readyOpenCodeSnapshot,
            },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`unexpected fetch ${url}`);
    });

    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = {
        ...createEnv(fetchImpl as typeof fetch),
        SUPABASE_URL: "https://supabase.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
        SUPABASE_USER_ID: "00000000-0000-0000-0000-000000000001",
      };
      const response = await handleApiRequest(new Request("https://api.monitor.local/api/usage"), env);
      const payload = (await response.json()) as any;
      const openCodeCard = payload.data.cards.find(
        (card: { providerId: string }) => card.providerId === "opencode-go",
      );

      expect(response.status).toBe(200);
      expect(openCodeCard).toMatchObject({
        providerId: "opencode-go",
        status: "ready",
      });
      expect(openCodeCard.summary).toContain("OpenCode Go usage windows parsed");
      expect(openCodeCard.windows).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refreshes a provider through the durable object gate", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      if (url.includes("/api/v1/auth/key")) {
        return new Response(
          JSON.stringify({
            data: {
              usage: 12,
              usage_daily: 4,
              limit: 100,
              limit_remaining: 88,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = createEnv(fetchImpl as typeof fetch);
      const response = await handleApiRequest(
        new Request("https://api.monitor.local/api/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            providerId: "openrouter",
            sessionKey: "openrouter:test-account",
          }),
        }),
        env,
      );

      const payload = (await response.json()) as any;
      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.data.refreshed).toBe(true);
      expect(payload.data.snapshot.snapshot.status).toBe("ready");
      expect(payload.data.snapshot.snapshot.providerId).toBe("openrouter");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refreshes all providers and returns the unified dashboard when providerId is omitted", async () => {
    const fetchImpl = createUsageFetchStub();
    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = createEnv(fetchImpl as typeof fetch);
      const response = await handleApiRequest(
        new Request("https://api.monitor.local/api/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionKey: "dashboard" }),
        }),
        env,
      );
      const payload = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.data.kind).toBe("usage_dashboard");
      expect(payload.data.refresh).toMatchObject({
        scope: "all",
        sessionKey: "dashboard",
        refreshed: true,
      });
      expect(payload.data.cards).toHaveLength(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("persists snapshots, quota windows, and refresh events to Supabase when configured", async () => {
    const restWrites: Array<{ path: string; search: string; headers: Headers; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();

      if (url.includes("/api/v1/auth/key")) {
        return new Response(
          JSON.stringify({
            data: {
              usage: 12,
              usage_daily: 4,
              limit: 100,
              limit_remaining: 88,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (url.startsWith("https://supabase.test/rest/v1/")) {
        const parsedUrl = new URL(url);
        const bodyText = request ? await request.clone().text() : String(init?.body ?? "");
        restWrites.push({
          path: parsedUrl.pathname,
          search: parsedUrl.search,
          headers: request ? request.headers : new Headers(init?.headers),
          body: bodyText ? JSON.parse(bodyText) : null,
        });
        return new Response("", { status: 201 });
      }

      throw new Error(`unexpected fetch ${url}`);
    });

    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = {
        ...createEnv(fetchImpl as typeof fetch),
        SUPABASE_URL: "https://supabase.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
        SUPABASE_USER_ID: "00000000-0000-0000-0000-000000000001",
      };
      const response = await handleApiRequest(
        new Request("https://api.monitor.local/api/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            providerId: "openrouter",
            sessionKey: "openrouter:persist-test",
          }),
        }),
        env,
      );
      const payload = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.data.refreshed).toBe(true);
      expect(restWrites.map((write) => write.path)).toEqual(
        expect.arrayContaining([
          "/rest/v1/provider_accounts",
          "/rest/v1/usage_snapshots",
          "/rest/v1/quota_windows",
          "/rest/v1/refresh_events",
        ]),
      );
      expect(restWrites.find((write) => write.path === "/rest/v1/quota_windows")?.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            user_id: "00000000-0000-0000-0000-000000000001",
            provider_key: "openrouter",
            window_key: "current",
          }),
        ]),
      );
      const providerAccountWrite = restWrites.find(
        (write) => write.path === "/rest/v1/provider_accounts" && write.search.includes("on_conflict"),
      );
      expect(providerAccountWrite?.search).toContain(
        "on_conflict=user_id%2Cprovider_key%2Csource_url",
      );
      expect(providerAccountWrite?.headers.get("prefer")).toContain(
        "resolution=merge-duplicates",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("creates a live login session placeholder", async () => {
    const env = createEnv(fetch);
    const response = await handleApiRequest(
      new Request("https://api.monitor.local/api/session/live-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "xfyun-maas",
          loginUrl: "https://maas.xfyun.cn/packageSubscription",
        }),
      }),
      env,
    );
    const payload = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data).toMatchObject({
      provider: "xfyun-maas",
      loginUrl: "https://maas.xfyun.cn/packageSubscription",
      liveViewUrl: "https://maas.xfyun.cn/packageSubscription",
      status: "manual_open",
    });
    expect(payload.data.expiresAt).toEqual(expect.any(String));
  });

  it("rejects invalid live login requests", async () => {
    const env = createEnv(fetch);
    const response = await handleApiRequest(
      new Request("https://api.monitor.local/api/session/live-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "xfyun-maas",
        }),
      }),
      env,
    );
    const payload = (await response.json()) as any;

    expect(response.status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("invalid_request");
  });

  it("returns provider_not_found for unknown providers", async () => {
    const env = createEnv(fetch);
    const response = await handleApiRequest(
      new Request("https://api.monitor.local/api/providers/unknown/snapshot"),
      env,
    );
    const payload = (await response.json()) as any;

    expect(response.status).toBe(404);
    expect(payload.error.code).toBe("provider_not_found");
  });

  it("uses Supabase active account config during refresh when available", async () => {
    const encryptionKey = "0123456789abcdef0123456789abcdef";
    const encrypted = await encryptCredentialPayload(
      { workspaceId: "wrk_db", authCookie: "auth-cookie=db" },
      encryptionKey,
    );
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();

      if (url.includes("/api/v1/auth/key")) {
        return new Response(JSON.stringify({ data: { usage: 12, limit: 100, limit_remaining: 88 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("opencode.ai/workspace")) {
        return new Response(
          [
            "<html><script>",
            "rollingUsage:$R[10]={usagePercent:7,resetInSec:18000}",
            "</script></html>",
          ].join(""),
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }

      if (url.includes("maas.xfyun.cn/api/subscription")) {
        return new Response(JSON.stringify({ used: 20, limit: 100, remaining: 80 }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_preferences")) {
        return new Response(
          JSON.stringify([{
            provider_key: "opencode-go",
            enabled: true,
            display_order: 1,
            active_provider_account_id: "account-db-1",
          }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_accounts")) {
        return new Response(
          JSON.stringify([{
            id: "account-db-1",
            provider_key: "opencode-go",
            account_label: "DB账号",
            source_url: "https://opencode.ai/workspace/wrk_db/go",
            status: "ready",
            config: { baseUrl: "https://opencode.ai", workspaceId: "wrk_db" },
          }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_account_credentials")) {
        return new Response(
          JSON.stringify([{
            provider_account_id: "account-db-1",
            encrypted_payload: encrypted.encryptedPayload,
            nonce: encrypted.nonce,
            key_version: encrypted.keyVersion,
          }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.startsWith("https://supabase.test/rest/v1/refresh_events")) {
        return new Response("", { status: 201 });
      }

      if (url.startsWith("https://supabase.test/rest/v1/usage_snapshots")) {
        return new Response("", { status: 201 });
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_accounts")) {
        return new Response("", { status: 201 });
      }

      if (url.startsWith("https://supabase.test/rest/v1/quota_windows")) {
        return new Response("", { status: 201 });
      }

      throw new Error(`unexpected fetch ${url}`);
    });

    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = {
        ...createEnv(fetchImpl as typeof fetch),
        SUPABASE_URL: "https://supabase.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
        SUPABASE_USER_ID: "00000000-0000-0000-0000-000000000001",
        CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
        OPENCODE_GO_WORKSPACE_ID: "wrk_123",
        OPENCODE_GO_AUTH_COOKIE: "auth-cookie=abc",
      };

      const response = await handleApiRequest(
        new Request("https://api.monitor.local/api/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerId: "opencode-go", sessionKey: "opencode-go:db-test" }),
        }),
        env,
      );
      const payload = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.data.refreshed).toBe(true);
      // The workspace URL should come from DB account config (wrk_db) instead of env (wrk_123)
      const opencodeCalls = fetchImpl.mock.calls.filter((call) => {
        const url = String(call[0]);
        return url.includes("opencode.ai/workspace");
      });
      expect(opencodeCalls.length).toBeGreaterThan(0);
      const opencodeUrl = String(opencodeCalls[0][0]);
      expect(opencodeUrl).toContain("wrk_db");
      expect(opencodeUrl).not.toContain("wrk_123");
      const accountReadCall = fetchImpl.mock.calls.find((call) => {
        const url = String(call[0]);
        return url.startsWith("https://supabase.test/rest/v1/provider_accounts") && url.includes("id=eq.account-db-1");
      });
      expect(String(accountReadCall?.[0])).toContain("provider_key=eq.opencode-go");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses homepage-enabled accounts as nested dashboard accounts", async () => {
    const encryptionKey = "0123456789abcdef0123456789abcdef";
    const encryptedMain = await encryptCredentialPayload({ apiKey: "sk-main" }, encryptionKey);
    const encryptedBackup = await encryptCredentialPayload({ apiKey: "sk-backup" }, encryptionKey);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();

      if (url.startsWith("https://supabase.test/rest/v1/provider_preferences")) {
        return new Response(
          JSON.stringify([{
            provider_key: "openrouter",
            enabled: true,
            display_order: 1,
            active_provider_account_id: "account-main",
          }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_accounts")) {
        const parsed = new URL(url);
        const accountIdFilter = parsed.searchParams.get("id");
        if (accountIdFilter === "eq.account-main") {
          return new Response(
            JSON.stringify([{
              id: "account-main",
              provider_key: "openrouter",
              account_label: "主账号",
              source_url: "https://openrouter.ai/activity",
              config: {},
            }]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (accountIdFilter === "eq.account-backup") {
          return new Response(
            JSON.stringify([{
              id: "account-backup",
              provider_key: "openrouter",
              account_label: "备用账号",
              source_url: "https://openrouter.ai/activity",
              config: {},
            }]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify([
            {
              id: "account-main",
              provider_key: "openrouter",
              account_label: "主账号",
              source_url: "https://openrouter.ai/activity",
              status: "ready",
              credential_hint: { apiKey: "sk...main" },
              homepage_enabled: true,
              homepage_order: 1,
              last_test_summary: "main ready",
            },
            {
              id: "account-backup",
              provider_key: "openrouter",
              account_label: "备用账号",
              source_url: "https://openrouter.ai/activity",
              status: "ready",
              credential_hint: { apiKey: "sk...back" },
              homepage_enabled: true,
              homepage_order: 2,
              last_test_summary: "backup ready",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_account_credentials")) {
        const parsed = new URL(url);
        const accountId = parsed.searchParams.get("provider_account_id");
        if (accountId === "eq.account-main") {
          return new Response(
            JSON.stringify([{
              encrypted_payload: encryptedMain.encryptedPayload,
              nonce: encryptedMain.nonce,
              key_version: encryptedMain.keyVersion,
            }]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (accountId === "eq.account-backup") {
          return new Response(
            JSON.stringify([{
              encrypted_payload: encryptedBackup.encryptedPayload,
              nonce: encryptedBackup.nonce,
              key_version: encryptedBackup.keyVersion,
            }]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }

      if (url.includes("/api/v1/auth/key")) {
        const authorization = init?.headers instanceof Headers
          ? init.headers.get("Authorization")
          : (init?.headers as Record<string, string> | undefined)?.Authorization;
        const usage = authorization?.includes("sk-backup") ? 22 : 11;
        return new Response(JSON.stringify({ data: { usage, limit: 100, limit_remaining: 100 - usage } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });

    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = {
        ...createEnv(fetchImpl as typeof fetch),
        SUPABASE_URL: "https://supabase.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
        SUPABASE_USER_ID: "00000000-0000-0000-0000-000000000001",
        CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
      };

      const response = await handleApiRequest(new Request("https://api.monitor.local/api/usage"), env);
      const payload = (await response.json()) as any;
      const openrouterCard = payload.data.cards.find(
        (card: { providerId: string }) => card.providerId === "openrouter",
      );

      expect(response.status).toBe(200);
      expect(payload.data.cards).toHaveLength(1);
      expect(openrouterCard).toMatchObject({
        providerId: "openrouter",
        selectedAccountId: "account-main",
      });
      expect(openrouterCard.accounts).toEqual([
        expect.objectContaining({ accountId: "account-main", accountLabel: "主账号" }),
        expect.objectContaining({ accountId: "account-backup", accountLabel: "备用账号" }),
      ]);
      const openrouterCalls = fetchImpl.mock.calls.filter((call) => {
        const input = call[0];
        const url = input instanceof Request ? input.url : String(input);
        return url.includes("/api/v1/auth/key");
      });
      expect(openrouterCalls).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps account metadata when a homepage-enabled account fetch fails", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();

      if (url.startsWith("https://supabase.test/rest/v1/provider_preferences")) {
        return Response.json([{
          provider_key: "opencode-go",
          enabled: true,
          display_order: 1,
          active_provider_account_id: "account-broken",
        }]);
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_accounts")) {
        return Response.json([{
          id: "account-broken",
          provider_key: "opencode-go",
          account_label: "失效账号",
          source_url: "https://opencode.ai/workspace/wrk_broken/go",
          status: "ready",
          credential_hint: { workspaceId: "wrk_broken" },
          homepage_enabled: true,
          homepage_order: 1,
        }]);
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_account_credentials")) {
        return Response.json([]);
      }

      if (url.startsWith("https://supabase.test/rest/v1/usage_snapshots")) {
        return Response.json([]);
      }

      if (url.includes("opencode.ai/workspace")) {
        throw new Error("account fetch failed");
      }

      throw new Error(`unexpected fetch ${url}`);
    });

    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = {
        ...createEnv(fetchImpl as typeof fetch),
        SUPABASE_URL: "https://supabase.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
        SUPABASE_USER_ID: "00000000-0000-0000-0000-000000000001",
        CREDENTIAL_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      };

      const response = await handleApiRequest(new Request("https://api.monitor.local/api/usage"), env);
      const payload = (await response.json()) as any;
      const openCodeCard = payload.data.cards.find(
        (card: { providerId: string }) => card.providerId === "opencode-go",
      );

      expect(response.status).toBe(200);
      expect(openCodeCard.accounts[0]).toMatchObject({
        accountId: "account-broken",
        accountLabel: "失效账号",
        status: "error",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refreshes homepage-enabled accounts for a single provider request", async () => {
    const encryptionKey = "0123456789abcdef0123456789abcdef";
    const encryptedMain = await encryptCredentialPayload({ apiKey: "sk-main" }, encryptionKey);
    const encryptedBackup = await encryptCredentialPayload({ apiKey: "sk-backup" }, encryptionKey);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();

      if (url.startsWith("https://supabase.test/rest/v1/provider_preferences")) {
        return Response.json([{
          provider_key: "openrouter",
          enabled: true,
          display_order: 1,
          active_provider_account_id: "account-main",
        }]);
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_accounts")) {
        const parsed = new URL(url);
        const accountIdFilter = parsed.searchParams.get("id");
        if (accountIdFilter === "eq.account-main") {
          return Response.json([{ id: "account-main", provider_key: "openrouter", account_label: "主账号", source_url: "https://openrouter.ai/activity", config: {} }]);
        }
        if (accountIdFilter === "eq.account-backup") {
          return Response.json([{ id: "account-backup", provider_key: "openrouter", account_label: "备用账号", source_url: "https://openrouter.ai/activity", config: {} }]);
        }
        return Response.json([
          { id: "account-main", provider_key: "openrouter", account_label: "主账号", source_url: "https://openrouter.ai/activity", homepage_enabled: true, homepage_order: 1 },
          { id: "account-backup", provider_key: "openrouter", account_label: "备用账号", source_url: "https://openrouter.ai/activity", homepage_enabled: true, homepage_order: 2 },
        ]);
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_account_credentials")) {
        const accountId = new URL(url).searchParams.get("provider_account_id");
        return Response.json([{
          encrypted_payload: accountId === "eq.account-backup" ? encryptedBackup.encryptedPayload : encryptedMain.encryptedPayload,
          nonce: accountId === "eq.account-backup" ? encryptedBackup.nonce : encryptedMain.nonce,
          key_version: "v1",
        }]);
      }

      if (url.startsWith("https://supabase.test/rest/v1/refresh_events")) return new Response("", { status: 201 });
      if (url.startsWith("https://supabase.test/rest/v1/usage_snapshots")) return new Response("", { status: 201 });
      if (url.startsWith("https://supabase.test/rest/v1/quota_windows")) return new Response("", { status: 201 });

      if (url.includes("/api/v1/auth/key")) {
        const request = input instanceof Request ? input : null;
        const authorization = request?.headers.get("Authorization") ?? (init?.headers as Record<string, string> | undefined)?.Authorization;
        const usage = authorization?.includes("sk-backup") ? 22 : 11;
        return Response.json({ data: { usage, limit: 100, limit_remaining: 100 - usage } });
      }

      throw new Error(`unexpected fetch ${url}`);
    });

    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = {
        ...createEnv(fetchImpl as typeof fetch),
        SUPABASE_URL: "https://supabase.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
        SUPABASE_USER_ID: "00000000-0000-0000-0000-000000000001",
        CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
      };

      const response = await handleApiRequest(
        new Request("https://api.monitor.local/api/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerId: "openrouter", sessionKey: "openrouter:multi-account", persist: false }),
        }),
        env,
      );
      const payload = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.data.kind).toBe("usage_dashboard");
      expect(payload.data.cards).toHaveLength(1);
      expect(payload.data.cards[0].accounts).toHaveLength(2);
      expect(payload.data.refresh).toMatchObject({
        scope: "single",
        providerId: "openrouter",
        refreshed: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses Supabase active account config for direct provider snapshots", async () => {
    const encryptionKey = "0123456789abcdef0123456789abcdef";
    const encrypted = await encryptCredentialPayload(
      {
        apiUrl: "https://bailian.console.aliyun.com/api/coding-plan/usage",
        authCookie: "login=db",
        cloudFetchEnabled: true,
      },
      encryptionKey,
    );
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();

      if (url.startsWith("https://supabase.test/rest/v1/provider_preferences")) {
        return new Response(
          JSON.stringify([{
            provider_key: "aliyun-bailian",
            enabled: true,
            display_order: 1,
            active_provider_account_id: "account-bailian-1",
          }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_accounts")) {
        return new Response(
          JSON.stringify([{
            id: "account-bailian-1",
            provider_key: "aliyun-bailian",
            source_url: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/coding-plan",
            config: {
              pageUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/coding-plan",
            },
          }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_account_credentials")) {
        return new Response(
          JSON.stringify([{
            encrypted_payload: encrypted.encryptedPayload,
            nonce: encrypted.nonce,
            key_version: encrypted.keyVersion,
          }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.startsWith("https://bailian.console.aliyun.com/api/coding-plan/usage")) {
        return new Response(
          JSON.stringify({
            data: {
              windows: [{ key: "monthly", label: "Monthly", used: 10, limit: 100 }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`unexpected fetch ${url}`);
    });

    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = {
        ...createEnv(fetchImpl as typeof fetch),
        SUPABASE_URL: "https://supabase.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
        SUPABASE_USER_ID: "00000000-0000-0000-0000-000000000001",
        CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
      };

      const response = await handleApiRequest(
        new Request("https://api.monitor.local/api/providers/aliyun-bailian/snapshot"),
        env,
      );
      const payload = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(payload.data.snapshot.status).toBe("ready");
      expect(payload.data.snapshot.providerId).toBe("aliyun-bailian");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to env config when Supabase active account is missing", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();

      if (url.includes("/api/v1/auth/key")) {
        return new Response(JSON.stringify({ data: { usage: 12, limit: 100, limit_remaining: 88 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("opencode.ai/workspace")) {
        return new Response(
          [
            "<html><script>",
            "rollingUsage:$R[10]={usagePercent:7,resetInSec:18000}",
            "</script></html>",
          ].join(""),
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }

      if (url.includes("maas.xfyun.cn/api/subscription")) {
        return new Response(JSON.stringify({ used: 20, limit: 100, remaining: 80 }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_preferences")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.startsWith("https://supabase.test/rest/v1/refresh_events")) {
        return new Response("", { status: 201 });
      }

      if (url.startsWith("https://supabase.test/rest/v1/usage_snapshots")) {
        return new Response("", { status: 201 });
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_accounts")) {
        return new Response("", { status: 201 });
      }

      if (url.startsWith("https://supabase.test/rest/v1/quota_windows")) {
        return new Response("", { status: 201 });
      }

      throw new Error(`unexpected fetch ${url}`);
    });

    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = {
        ...createEnv(fetchImpl as typeof fetch),
        SUPABASE_URL: "https://supabase.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
        SUPABASE_USER_ID: "00000000-0000-0000-0000-000000000001",
        CREDENTIAL_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
        OPENCODE_GO_WORKSPACE_ID: "wrk_123",
        OPENCODE_GO_AUTH_COOKIE: "auth-cookie=abc",
      };

      const response = await handleApiRequest(
        new Request("https://api.monitor.local/api/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerId: "opencode-go", sessionKey: "opencode-go:env-test" }),
        }),
        env,
      );
      const payload = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.data.refreshed).toBe(true);
      const opencodeCalls = fetchImpl.mock.calls.filter((call) => {
        const url = String(call[0]);
        return url.includes("opencode.ai/workspace");
      });
      expect(opencodeCalls.length).toBeGreaterThan(0);
      const opencodeUrl = String(opencodeCalls[0][0]);
      expect(opencodeUrl).toContain("wrk_123");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("merges env secrets when a Supabase active account config is incomplete", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();

      if (url.startsWith("https://supabase.test/rest/v1/provider_preferences")) {
        return new Response(
          JSON.stringify([{
            provider_key: "aliyun-bailian",
            enabled: true,
            display_order: 1,
            active_provider_account_id: "account-bailian-env-fallback",
          }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_accounts")) {
        return new Response(
          JSON.stringify([{
            id: "account-bailian-env-fallback",
            provider_key: "aliyun-bailian",
            source_url: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/coding-plan",
            config: {
              pageUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/coding-plan",
            },
          }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_account_credentials")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.startsWith("https://bailian-cs.console.aliyun.com/data/api.json")) {
        return new Response(
          JSON.stringify({
            data: {
              windows: [{ key: "monthly", label: "Monthly", used: 10, limit: 100 }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`unexpected fetch ${url}`);
    });

    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = {
        ...createEnv(fetchImpl as typeof fetch),
        SUPABASE_URL: "https://supabase.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
        SUPABASE_USER_ID: "00000000-0000-0000-0000-000000000001",
        ALIYUN_BAILIAN_API_URL: "https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2",
        ALIYUN_BAILIAN_AUTH_COOKIE: "login=env",
        ALIYUN_BAILIAN_SEC_TOKEN: "sec-test",
        ALIYUN_BAILIAN_CLOUD_FETCH: "1",
      };

      const response = await handleApiRequest(
        new Request("https://api.monitor.local/api/providers/aliyun-bailian/snapshot"),
        env,
      );
      const payload = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(payload.data.snapshot.status).toBe("ready");
      expect(payload.data.snapshot.windows).toHaveLength(1);
      const bailianCall = fetchImpl.mock.calls.find((call) => String(call[0]).startsWith("https://bailian-cs.console.aliyun.com"));
      expect(bailianCall).toBeDefined();
      const request = bailianCall as unknown as [RequestInfo | URL, RequestInit];
      const body = request[1].body?.toString() ?? "";
      expect(new URLSearchParams(body).get("sec_token")).toBe("sec-test");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
