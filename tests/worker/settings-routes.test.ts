import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleSettingsRequest } from "../../worker/settings/routes";

describe("provider settings migration", () => {
  it("stores preferences separately from encrypted credentials", () => {
    const sql = readFileSync(
      "supabase/migrations/202606120001_provider_settings_and_credentials.sql",
      "utf8",
    );

    expect(sql).toContain("create table if not exists public.provider_preferences");
    expect(sql).toContain("create table if not exists public.provider_account_credentials");
    expect(sql).toContain("encrypted_payload text not null");
    expect(sql).toContain("nonce text not null");
    expect(sql).toContain("add column if not exists account_label text not null default '默认账号'");
    expect(sql).toContain("add column if not exists credential_hint jsonb not null default '{}'::jsonb");
    expect(sql).toContain("create unique index if not exists provider_accounts_user_id_idx");
    expect(sql).toContain("provider_preferences_active_account_same_user_fk");
    expect(sql).toContain("provider_account_credentials_account_same_user_fk");
    expect(sql).toContain("duplicate_provider_account_labels");
    expect(sql).toContain("create index if not exists provider_preferences_user_order_idx");
    expect(sql).toContain("create unique index if not exists provider_accounts_user_provider_label_idx");
    expect(sql).toContain("alter table public.provider_preferences enable row level security");
    expect(sql).toContain("alter table public.provider_account_credentials enable row level security");
    expect(sql).toContain("create policy provider_preferences_select_own");
    expect(sql).toContain("create policy provider_preferences_insert_own");
    expect(sql).toContain("create policy provider_preferences_update_own");
    expect(sql).toContain("create policy provider_preferences_delete_own");
    expect(sql).toContain("revoke all on public.provider_account_credentials from anon, authenticated");
    expect(sql).toContain("grant select, insert, update, delete on public.provider_preferences to service_role");
    expect(sql).toContain(
      "grant select, insert, update, delete on public.provider_account_credentials to service_role",
    );
  });
});

describe("provider account homepage visibility migration", () => {
  it("adds account-level homepage visibility without exposing credentials", () => {
    const sql = readFileSync(
      "supabase/migrations/202606130001_provider_account_homepage_visibility.sql",
      "utf8",
    );

    expect(sql).toContain("alter table public.provider_accounts");
    expect(sql).toContain("add column if not exists homepage_enabled boolean not null default false");
    expect(sql).toContain("add column if not exists homepage_order integer not null default 100");
    expect(sql).toContain("add column if not exists last_test_summary text");
    expect(sql).toContain("create index if not exists provider_accounts_homepage_order_idx");
    expect(sql).toContain("on public.provider_accounts (user_id, provider_key, homepage_enabled, homepage_order)");
    expect(sql).not.toContain("provider_account_credentials");
  });
});

describe("settings routes", () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    SUPABASE_ANON_KEY: "anon-public-key",
  };

  it("rejects provider settings updates without the admin token", async () => {
    const missingTokenResponse = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/providers", {
        method: "PUT",
      }),
      env,
      async () => new Response("[]"),
    );

    expect(missingTokenResponse.status).toBe(401);
    await expect(missingTokenResponse.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unauthorized",
      },
    });

    const wrongTokenResponse = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/providers", {
        method: "PUT",
        headers: {
          Authorization: "Bearer wrong-token",
        },
      }),
      env,
      async () => new Response("[]"),
    );

    expect(wrongTokenResponse.status).toBe(401);
    await expect(wrongTokenResponse.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unauthorized",
      },
    });
  });

  it("returns sanitized provider settings for an authorized request", async () => {
    const fetchCalls: URL[] = [];
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/auth/v1/user")) {
        return Response.json({ id: "user-123", email: "me@example.com" });
      }
      fetchCalls.push(url);

      if (url.pathname.endsWith("/provider_preferences")) {
        return Response.json([
          {
            provider_key: "openrouter",
            enabled: true,
            display_order: 10,
            active_provider_account_id: "account-1",
          },
        ]);
      }

      if (url.pathname.endsWith("/provider_accounts")) {
        return Response.json([
          {
            id: "account-1",
            provider_key: "openrouter",
            account_label: "主账号",
            source_url: "https://openrouter.ai/activity",
            status: "ready",
            status_message: "可用",
            credential_hint: {
              lastFour: "1234",
            },
            homepage_enabled: true,
            homepage_order: 1,
            last_test_summary: "OpenRouter usage snapshot loaded",
            encrypted_payload: "secret",
          },
        ]);
      }

      return new Response("not found", { status: 404 });
    };

    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/providers", {
        method: "GET",
        headers: {
          Authorization: "Bearer user-jwt",
        },
      }),
      env,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      data: {
        preferences: [
          {
            providerKey: "openrouter",
            enabled: true,
            displayOrder: 10,
            activeProviderAccountId: "account-1",
          },
        ],
        accounts: [
          {
            id: "account-1",
            providerKey: "openrouter",
            accountLabel: "主账号",
            sourceUrl: "https://openrouter.ai/activity",
            status: "ready",
            statusMessage: "可用",
            credentialHint: {
              lastFour: "1234",
            },
            homepageEnabled: true,
            homepageOrder: 1,
            lastTestSummary: "OpenRouter usage snapshot loaded",
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain("encrypted_payload");
    expect(JSON.stringify(body)).not.toContain("encryptedPayload");
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("nonce");
    expect(fetchCalls.map((url) => url.pathname)).toEqual([
      "/rest/v1/provider_preferences",
      "/rest/v1/provider_accounts",
    ]);
    expect(fetchCalls[0].searchParams.get("user_id")).toBe("eq.user-123");
    expect(fetchCalls[1].searchParams.get("is_archived")).toBe("eq.false");
  });

  it("falls back to legacy provider account columns when layered settings tables are missing", async () => {
    const fetchCalls: URL[] = [];
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/auth/v1/user")) {
        return Response.json({ id: "user-123", email: "me@example.com" });
      }
      fetchCalls.push(url);

      if (url.pathname.endsWith("/provider_preferences")) {
        return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      }

      if (url.pathname.endsWith("/provider_accounts")) {
        const select = url.searchParams.get("select") ?? "";
        if (select.includes("account_label")) {
          return new Response(JSON.stringify({ message: "column does not exist" }), { status: 400 });
        }
        return Response.json([
          {
            id: "legacy-account-1",
            provider_key: "openrouter",
            display_name: "旧表主账号",
            source_url: "https://openrouter.ai/activity",
            status: "ready",
            status_message: "可用",
            config: {
              apiKey: "sk-secret-value",
              __homepageEnabled: true,
              __homepageOrder: 2,
            },
          },
        ]);
      }

      return new Response("not found", { status: 404 });
    };

    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/providers", {
        method: "GET",
        headers: { Authorization: "Bearer user-jwt" },
      }),
      env,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      data: {
        preferences: [],
        accounts: [
          {
            id: "legacy-account-1",
            providerKey: "openrouter",
            accountLabel: "旧表主账号",
            homepageEnabled: true,
            homepageOrder: 2,
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain("sk-secret-value");
    expect(fetchCalls.map((url) => url.searchParams.get("select"))).toEqual([
      "provider_key,enabled,display_order,active_provider_account_id",
      "id,provider_key,account_label,source_url,status,status_message,credential_hint,homepage_enabled,homepage_order,last_test_summary",
      "id,provider_key,display_name,source_url,status,status_message,config",
      "id,display_name,config",
    ]);
  });

  it("updates account homepage visibility without touching credentials", async () => {
    const fetchCalls: { url: URL; init?: RequestInit }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/auth/v1/user")) {
        return Response.json({ id: "user-123", email: "me@example.com" });
      }
      fetchCalls.push({ url, init });
      return Response.json([{ id: "account-1", homepage_enabled: true, homepage_order: 2 }]);
    };

    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/accounts/account-1/display", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer user-jwt",
        },
        body: JSON.stringify({ homepageEnabled: true, homepageOrder: 2 }),
      }),
      env,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        id: "account-1",
        homepageEnabled: true,
        homepageOrder: 2,
      },
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url.pathname).toBe("/rest/v1/provider_accounts");
    expect(fetchCalls[0]?.url.searchParams.get("id")).toBe("eq.account-1");
    expect(fetchCalls[0]?.url.searchParams.get("user_id")).toBe("eq.user-123");
    expect(fetchCalls[0]?.init).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({
        homepage_enabled: true,
        homepage_order: 2,
      }),
    });
    expect(String(fetchCalls[0]?.init?.body)).not.toContain("credential");
  });

  it("rejects invalid account homepage display payloads", async () => {
    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/accounts/account-1/display", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer user-jwt",
        },
        body: JSON.stringify({ homepageEnabled: "yes", homepageOrder: -1 }),
      }),
      env,
      async (input) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/auth/v1/user")) {
          return Response.json({ id: "user-123", email: "me@example.com" });
        }
        throw new Error("fetch should not be called for invalid payload");
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
      },
    });
  });

  it("persists homepage visibility into legacy account config when homepage columns are missing", async () => {
    const fetchCalls: { url: URL; init?: RequestInit; body: Record<string, unknown> | null }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/auth/v1/user")) {
        return Response.json({ id: "user-123", email: "me@example.com" });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, init, body });

      if (init?.method === "PATCH" && body?.homepage_enabled !== undefined) {
        return new Response(JSON.stringify({ message: "column does not exist" }), { status: 400 });
      }
      if (init?.method === "PATCH" && body?.config) {
        return Response.json([{ id: "account-1" }]);
      }
      return Response.json([{ id: "account-1", config: { apiKey: "sk-secret" } }]);
    };

    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/accounts/account-1/display", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer user-jwt",
        },
        body: JSON.stringify({ homepageEnabled: false, homepageOrder: 100 }),
      }),
      env,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        id: "account-1",
        homepageEnabled: false,
        homepageOrder: 100,
      },
    });
    const legacyPatch = fetchCalls.find((call) => call.body?.config);
    expect(legacyPatch?.body).toMatchObject({
      config: {
        apiKey: "sk-secret",
        __homepageEnabled: false,
        __homepageOrder: 100,
      },
    });
  });

  it("returns not found when account display update matches no rows", async () => {
    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/accounts/missing-account/display", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer user-jwt",
        },
        body: JSON.stringify({ homepageEnabled: true, homepageOrder: 2 }),
      }),
      env,
      async (input) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/auth/v1/user")) {
          return Response.json({ id: "user-123", email: "me@example.com" });
        }
        return Response.json([]);
      },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "account_not_found",
      },
    });
  });

  it("upserts provider preferences with correct admin token", async () => {
    const fetchCalls: { url: URL; body: unknown }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/auth/v1/user")) {
        return Response.json({ id: "user-123", email: "me@example.com" });
      }
      const bodyText = init?.body ? String(init.body) : "";
      fetchCalls.push({ url, body: bodyText ? JSON.parse(bodyText) : null });
      if (url.pathname.endsWith("/provider_preferences")) {
        return Response.json([{ provider_key: "openrouter", enabled: true, display_order: 10, active_provider_account_id: "account-1" }]);
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/providers", {
        method: "PUT",
        headers: { "content-type": "application/json", Authorization: "Bearer user-jwt" },
        body: JSON.stringify({ providerKey: "openrouter", enabled: true, displayOrder: 10, activeProviderAccountId: "account-1" }),
      }),
      env,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    const upsertCall = fetchCalls.find((c) => c.url.pathname.endsWith("/provider_preferences"));
    expect(upsertCall).toBeDefined();
    expect(upsertCall?.body).toMatchObject({
      user_id: "user-123",
      provider_key: "openrouter",
      enabled: true,
      display_order: 10,
      active_provider_account_id: "account-1",
    });
  });

  it("upserts provider preferences in batches", async () => {
    const fetchCalls: { url: URL; body: unknown }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/auth/v1/user")) {
        return Response.json({ id: "user-123", email: "me@example.com" });
      }
      const bodyText = init?.body ? String(init.body) : "";
      fetchCalls.push({ url, body: bodyText ? JSON.parse(bodyText) : null });
      if (url.pathname.endsWith("/provider_preferences")) {
        return Response.json([{}]);
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/providers", {
        method: "PUT",
        headers: { "content-type": "application/json", Authorization: "Bearer user-jwt" },
        body: JSON.stringify({
          providers: [
            { providerKey: "openrouter", enabled: true, displayOrder: 1, activeProviderAccountId: "account-1" },
            { providerKey: "opencode-go", enabled: false, displayOrder: 2, activeProviderAccountId: null },
          ],
        }),
      }),
      env,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(fetchCalls.map((call) => call.body)).toMatchObject([
      { provider_key: "openrouter", enabled: true, display_order: 1 },
      { provider_key: "opencode-go", enabled: false, display_order: 2 },
    ]);
  });

  it("creates a provider account with encrypted credentials", async () => {
    const fetchCalls: { url: URL; body: unknown }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/auth/v1/user")) {
        return Response.json({ id: "user-123", email: "me@example.com" });
      }
      const bodyText = init?.body ? String(init.body) : "";
      const body = bodyText ? JSON.parse(bodyText) : null;
      fetchCalls.push({ url, body });
      if (url.pathname.endsWith("/provider_accounts")) {
        return Response.json([{ id: "account-new" }]);
      }
      if (url.pathname.endsWith("/provider_account_credentials")) {
        return Response.json([{}]);
      }
      return new Response("not found", { status: 404 });
    };

    const envWithKey = { ...env, CREDENTIAL_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" };

    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer user-jwt" },
        body: JSON.stringify({
          providerKey: "opencode-go",
          accountLabel: "测试账号",
          sourceUrl: "https://opencode.ai/workspace/wrk_999/go",
          credentials: { workspaceId: "wrk_999", authCookie: "auth=secret" },
        }),
      }),
      envWithKey,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe("account-new");

    const accountCall = fetchCalls.find((c) => c.url.pathname.endsWith("/provider_accounts"));
    expect(accountCall).toBeDefined();
    const accountBody = accountCall?.body as Record<string, unknown>;
    expect(accountBody).toMatchObject({
      user_id: "user-123",
      provider_key: "opencode-go",
      display_name: "测试账号",
      account_label: "测试账号",
      source_url: "https://opencode.ai/workspace/wrk_999/go",
      auth_mode: "configured",
      credential_hint: {
        workspaceId: "wrk_999",
      },
    });
    const credentialHint = accountBody.credential_hint as Record<string, unknown>;
    expect(JSON.stringify(accountBody)).not.toContain("auth=secret");
    expect(String(credentialHint.authCookie)).toContain("...");

    const credCall = fetchCalls.find((c) => c.url.pathname.endsWith("/provider_account_credentials"));
    expect(credCall).toBeDefined();
    const credentialBody = credCall?.body as Record<string, unknown>;
    expect(credentialBody).toMatchObject({
      user_id: "user-123",
      provider_account_id: "account-new",
    });
    expect(credentialBody.encrypted_payload).toBeDefined();
    expect(credentialBody.nonce).toBeDefined();
  });

  it("saves provider accounts to legacy config when credential table columns are missing", async () => {
    const fetchCalls: { url: URL; body: Record<string, unknown> | null }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/auth/v1/user")) {
        return Response.json({ id: "user-123", email: "me@example.com" });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, body });

      if (url.pathname.endsWith("/provider_accounts") && body?.account_label) {
        return new Response(JSON.stringify({ message: "column does not exist" }), { status: 400 });
      }
      if (url.pathname.endsWith("/provider_accounts")) {
        return Response.json([{ id: "legacy-account-new" }]);
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer user-jwt" },
        body: JSON.stringify({
          providerKey: "openrouter",
          accountLabel: "旧表账号",
          sourceUrl: "https://openrouter.ai/activity",
          credentials: { apiKey: "sk-secret-value" },
        }),
      }),
      env,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { id: "legacy-account-new" },
    });
    const legacyAccountCall = fetchCalls.find(
      (call) => call.body?.display_name === "旧表账号" && !("account_label" in call.body),
    );
    expect(legacyAccountCall?.url.searchParams.get("on_conflict")).toBeNull();
    expect(legacyAccountCall?.body).toMatchObject({
      user_id: "user-123",
      provider_key: "openrouter",
      display_name: "旧表账号",
      source_url: "https://openrouter.ai/activity",
      config: {
        apiKey: "sk-secret-value",
        __homepageEnabled: true,
        __homepageOrder: 100,
      },
    });
  });

  it("creates a separate legacy account instead of overwriting an existing account with the same source URL", async () => {
    const fetchCalls: { url: URL; body: Record<string, unknown> | null }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/auth/v1/user")) {
        return Response.json({ id: "user-123", email: "me@example.com" });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, body });

      if (url.pathname.endsWith("/provider_accounts") && body?.account_label) {
        return new Response(JSON.stringify({ message: "column does not exist" }), { status: 400 });
      }
      if (url.pathname.endsWith("/provider_accounts")) {
        return Response.json([{ id: "legacy-account-new" }]);
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer user-jwt" },
        body: JSON.stringify({
          providerKey: "openrouter",
          accountLabel: "第二个账号",
          sourceUrl: "https://openrouter.ai/activity",
          credentials: { apiKey: "sk-second-secret" },
        }),
      }),
      env,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    const legacyAccountCall = fetchCalls.find(
      (call) => call.body?.display_name === "第二个账号" && !("account_label" in call.body),
    );
    expect(legacyAccountCall?.url.searchParams.get("on_conflict")).toBeNull();
    expect(legacyAccountCall?.body).toMatchObject({
      display_name: "第二个账号",
      source_url: "https://openrouter.ai/activity",
    });
  });

  it("updates an existing legacy account by id without creating a new account", async () => {
    const fetchCalls: { url: URL; init?: RequestInit; body: Record<string, unknown> | null }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/auth/v1/user")) {
        return Response.json({ id: "user-123", email: "me@example.com" });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, init, body });

      if (init?.method === "PATCH" && body?.account_label) {
        return new Response(JSON.stringify({ message: "column does not exist" }), { status: 400 });
      }
      if (init?.method === "PATCH" && body?.display_name) {
        return Response.json([{ id: "legacy-account-1" }]);
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/accounts/legacy-account-1", {
        method: "PATCH",
        headers: { "content-type": "application/json", Authorization: "Bearer user-jwt" },
        body: JSON.stringify({
          providerKey: "openrouter",
          accountLabel: "改名后的账号",
          sourceUrl: "https://openrouter.ai/activity",
          credentials: { apiKey: "sk-updated-secret" },
        }),
      }),
      env,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    const legacyPatch = fetchCalls.find(
      (call) => call.body?.display_name === "改名后的账号" && !("account_label" in call.body),
    );
    expect(legacyPatch?.init?.method).toBe("PATCH");
    expect(legacyPatch?.url.searchParams.get("id")).toBe("eq.legacy-account-1");
    expect(legacyPatch?.url.searchParams.get("user_id")).toBe("eq.user-123");
    expect(legacyPatch?.body).toMatchObject({
      display_name: "改名后的账号",
      source_url: "https://openrouter.ai/activity",
      config: {
        apiKey: "sk-updated-secret",
      },
    });
  });

  it("deletes a provider account owned by the current user", async () => {
    const fetchCalls: { url: URL; init?: RequestInit }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/auth/v1/user")) {
        return Response.json({ id: "user-123", email: "me@example.com" });
      }
      fetchCalls.push({ url, init });
      return new Response(null, { status: 204 });
    };

    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/accounts/account-1", {
        method: "DELETE",
        headers: { Authorization: "Bearer user-jwt" },
      }),
      env,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { id: "account-1" },
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.method).toBe("DELETE");
    expect(fetchCalls[0]?.url.pathname).toBe("/rest/v1/provider_accounts");
    expect(fetchCalls[0]?.url.searchParams.get("id")).toBe("eq.account-1");
    expect(fetchCalls[0]?.url.searchParams.get("user_id")).toBe("eq.user-123");
  });

  it("reads provider preferences from legacy __preferences__ system record", async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/auth/v1/user")) {
        return Response.json({ id: "user-123", email: "me@example.com" });
      }
      if (url.pathname.endsWith("/provider_preferences")) {
        return new Response(JSON.stringify({ message: "relation does not exist" }), { status: 404 });
      }
      if (url.pathname.endsWith("/provider_accounts")) {
        const select = url.searchParams.get("select") ?? "";
        if (select.includes("display_name,config")) {
          return Response.json([
            {
              id: "sys-pref",
              display_name: "__preferences__",
              config: {
                __preferences: [
                  { provider_key: "opencode-go", enabled: false, display_order: 1, active_provider_account_id: null },
                  { provider_key: "openrouter", enabled: true, display_order: 2, active_provider_account_id: "acc-1" },
                ],
              },
            },
          ]);
        }
        if (select.includes("display_name,source_url")) {
          return Response.json([]);
        }
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/providers", {
        method: "GET",
        headers: { Authorization: "Bearer user-jwt" },
      }),
      env,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      data: {
        preferences: [
          { providerKey: "opencode-go", enabled: false, displayOrder: 1, activeProviderAccountId: null },
          { providerKey: "openrouter", enabled: true, displayOrder: 2, activeProviderAccountId: "acc-1" },
        ],
      },
    });
  });

  it("writes provider preferences to legacy __preferences__ system record when new schema is missing", async () => {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/auth/v1/user")) {
        return Response.json({ id: "user-123", email: "me@example.com" });
      }
      if (url.pathname.endsWith("/provider_preferences") && init?.method === "POST") {
        return new Response(JSON.stringify({ message: "relation does not exist" }), { status: 404 });
      }
      if (url.pathname.endsWith("/provider_accounts") && init?.method === "GET") {
        return Response.json([]);
      }
      if (url.pathname.endsWith("/provider_accounts") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return Response.json([{ id: body.id ?? "sys-new" }]);
      }
      if (url.pathname.endsWith("/provider_accounts") && init?.method === "PATCH") {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/providers", {
        method: "PUT",
        headers: { "content-type": "application/json", Authorization: "Bearer user-jwt" },
        body: JSON.stringify({
          providerKey: "openrouter",
          enabled: true,
          displayOrder: 1,
          activeProviderAccountId: "acc-1",
        }),
      }),
      env,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      data: { providerKey: "openrouter", displayOrder: 1 },
    });
  });

  it("rejects credential saves when encryption key is missing", async () => {
    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer user-jwt" },
        body: JSON.stringify({
          providerKey: "openrouter",
          accountLabel: "主账号",
          sourceUrl: "https://openrouter.ai/activity",
          credentials: { apiKey: "sk-test" },
        }),
      }),
      env,
      async (input) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/auth/v1/user")) {
          return Response.json({ id: "user-123", email: "me@example.com" });
        }
        return Response.json([{ id: "account-new" }]);
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "account_creation_failed",
      },
    });
  });

  it("tests a provider account connection", async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("/auth/v1/user")) {
        return Response.json({ id: "user-123", email: "me@example.com" });
      }
      if (url.pathname.endsWith("/provider_accounts")) {
        return Response.json([{
          id: "account-1",
          provider_key: "openrouter",
          account_label: "主账号",
          source_url: "https://openrouter.ai/activity",
          status: "ready",
          config: { apiKey: "sk-test" },
        }]);
      }
      if (url.pathname.endsWith("/provider_account_credentials")) {
        return Response.json([{
          provider_account_id: "account-1",
          encrypted_payload: "mock-encrypted",
          nonce: "mock-nonce",
          key_version: "v1",
        }]);
      }
      if (url.pathname.endsWith("/provider_preferences")) {
        return Response.json([{
          provider_key: "openrouter",
          enabled: true,
          display_order: 1,
          active_provider_account_id: "account-1",
        }]);
      }
      if (url.pathname.endsWith("/api/v1/auth/key")) {
        return Response.json({ data: { usage: 12, limit: 100, limit_remaining: 88 } });
      }
      return new Response("not found", { status: 404 });
    };

    const envWithKey = { ...env, CREDENTIAL_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" };

    const response = await handleSettingsRequest(
      new Request("https://api-monitor.local/api/settings/accounts/account-1/test", {
        method: "POST",
        headers: { Authorization: "Bearer user-jwt" },
      }),
      envWithKey,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      ok: true,
      status: "ready",
    });
  });
});
