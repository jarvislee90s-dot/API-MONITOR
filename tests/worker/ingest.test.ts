import { describe, expect, it, vi } from "vitest";

import {
  handleIngestChatgpt,
  handleIngestDeepSeek,
  handleIngestOpenCodeGo,
  handleIngestZhipu,
} from "../../worker/ingest";
import type { ProviderSnapshot, WorkerEnv } from "../../worker/types";

function makeSnapshot(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    sourceUrl: "https://opencode.ai/workspace/wrk_123/go",
    status: "ready",
    capturedAt: "2026-06-17T03:00:00.000Z",
    summary: "OpenCode Go usage windows parsed",
    windows: [
      { key: "rolling", label: "5h", used: 12, limit: 100, remaining: 88 },
    ],
    metrics: {},
    meta: { fetchMethod: "local_ingest" },
    ...overrides,
  };
}

function makeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    INGEST_API_KEY: "ingest-secret",
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
    SUPABASE_USER_ID: "00000000-0000-0000-0000-000000000001",
    ...overrides,
  } as WorkerEnv;
}

describe("handleIngestOpenCodeGo", () => {
  it("persists a valid snapshot and returns 200", async () => {
    const writes: unknown[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.startsWith("https://supabase.test/rest/v1/usage_snapshots") && init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)));
        return new Response("", { status: 201 });
      }
      if (url.startsWith("https://supabase.test/rest/v1/usage_snapshots")) {
        return Response.json([]);
      }
      if (url.startsWith("https://supabase.test/rest/v1/provider_accounts")) return new Response("", { status: 201 });
      if (url.startsWith("https://supabase.test/rest/v1/quota_windows")) return new Response("", { status: 201 });
      if (url.startsWith("https://supabase.test/rest/v1/refresh_events")) return new Response("", { status: 201 });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = makeEnv();
      const request = new Request("https://api.monitor.local/api/ingest/opencode-go", {
        method: "POST",
        headers: { "X-Ingest-Key": "ingest-secret", "content-type": "application/json" },
        body: JSON.stringify({ snapshot: makeSnapshot() }),
      });
      const response = await handleIngestOpenCodeGo(request, env);
      const payload = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.data.capturedAt).toBe("2026-06-17T03:00:00.000Z");
      const usageWrite = writes.find((w: any) => w.provider_key === "opencode-go") as any;
      expect(usageWrite).toBeTruthy();
      expect(usageWrite.status).toBe("ready");
      expect(usageWrite.payload.windows).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns 401 when X-Ingest-Key is missing or wrong", async () => {
    const env = makeEnv();
    const request = new Request("https://api.monitor.local/api/ingest/opencode-go", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshot: makeSnapshot() }),
    });
    const response = await handleIngestOpenCodeGo(request, env);
    expect(response.status).toBe(401);
  });

  it("returns 400 when providerId is not opencode-go", async () => {
    const env = makeEnv();
    const request = new Request("https://api.monitor.local/api/ingest/opencode-go", {
      method: "POST",
      headers: { "X-Ingest-Key": "ingest-secret", "content-type": "application/json" },
      body: JSON.stringify({ snapshot: makeSnapshot({ providerId: "openrouter" }) }),
    });
    const response = await handleIngestOpenCodeGo(request, env);
    expect(response.status).toBe(400);
  });

  it("returns 400 when windows is empty", async () => {
    const env = makeEnv();
    const request = new Request("https://api.monitor.local/api/ingest/opencode-go", {
      method: "POST",
      headers: { "X-Ingest-Key": "ingest-secret", "content-type": "application/json" },
      body: JSON.stringify({ snapshot: makeSnapshot({ windows: [] }) }),
    });
    const response = await handleIngestOpenCodeGo(request, env);
    expect(response.status).toBe(400);
  });
});

function makeDeepSeekSnapshot(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    providerId: "deepseek",
    providerName: "DeepSeek",
    sourceUrl: "https://platform.deepseek.com/usage",
    status: "ready",
    capturedAt: "2026-08-13T03:00:00.000Z",
    summary: "DeepSeek usage windows parsed",
    windows: [
      { key: "balance", label: "余额", used: 48.88 },
      { key: "tokens30d", label: "近30天Tokens", used: 3784507 },
    ],
    metrics: { balance: 48.88 },
    meta: { fetchMethod: "local_ingest" },
    ...overrides,
  };
}

describe("handleIngestDeepSeek", () => {
  it("persists a valid deepseek snapshot and returns 200", async () => {
    const writes: unknown[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.startsWith("https://supabase.test/rest/v1/usage_snapshots") && init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)));
        return new Response("", { status: 201 });
      }
      if (url.startsWith("https://supabase.test/rest/v1/usage_snapshots")) {
        return Response.json([]);
      }
      if (url.startsWith("https://supabase.test/rest/v1/provider_accounts")) return new Response("", { status: 201 });
      if (url.startsWith("https://supabase.test/rest/v1/quota_windows")) return new Response("", { status: 201 });
      if (url.startsWith("https://supabase.test/rest/v1/refresh_events")) return new Response("", { status: 201 });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = makeEnv();
      const request = new Request("https://api.monitor.local/api/ingest/deepseek", {
        method: "POST",
        headers: { "X-Ingest-Key": "ingest-secret", "content-type": "application/json" },
        body: JSON.stringify({ snapshot: makeDeepSeekSnapshot() }),
      });
      const response = await handleIngestDeepSeek(request, env);
      const payload = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      const usageWrite = writes.find((w: any) => w.provider_key === "deepseek") as any;
      expect(usageWrite).toBeTruthy();
      expect(usageWrite.payload.providerId).toBe("deepseek");
      expect(usageWrite.payload.windows).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects opencode-go snapshots on the deepseek endpoint", async () => {
    const env = makeEnv();
    const request = new Request("https://api.monitor.local/api/ingest/deepseek", {
      method: "POST",
      headers: { "X-Ingest-Key": "ingest-secret", "content-type": "application/json" },
      body: JSON.stringify({ snapshot: makeSnapshot() }),
    });
    const response = await handleIngestDeepSeek(request, env);
    expect(response.status).toBe(400);
  });
});

function makeZhipuSnapshot(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    providerId: "zhipu",
    providerName: "智谱 BigModel",
    sourceUrl: "https://bigmodel.cn/coding-plan/personal/usage",
    status: "ready",
    capturedAt: "2026-08-21T04:00:00.000Z",
    summary: "智谱 Coding Plan 用量已解析",
    windows: [
      { key: "rp5h", label: "5小时", used: 1.5, percentUsed: 30 },
      { key: "weekly", label: "每周", used: 2, percentUsed: 20 },
    ],
    metrics: { cacheHitRatePercent: 85, totalCredits: 1234 },
    meta: { fetchMethod: "local_ingest" },
    ...overrides,
  };
}

describe("handleIngestZhipu", () => {
  it("persists a valid zhipu snapshot and returns 200", async () => {
    const writes: unknown[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.startsWith("https://supabase.test/rest/v1/usage_snapshots") && init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)));
        return new Response("", { status: 201 });
      }
      if (url.startsWith("https://supabase.test/rest/v1/usage_snapshots")) {
        return Response.json([]);
      }
      if (url.startsWith("https://supabase.test/rest/v1/provider_accounts")) return new Response("", { status: 201 });
      if (url.startsWith("https://supabase.test/rest/v1/quota_windows")) return new Response("", { status: 201 });
      if (url.startsWith("https://supabase.test/rest/v1/refresh_events")) return new Response("", { status: 201 });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = makeEnv();
      const request = new Request("https://api.monitor.local/api/ingest/zhipu", {
        method: "POST",
        headers: { "X-Ingest-Key": "ingest-secret", "content-type": "application/json" },
        body: JSON.stringify({ snapshot: makeZhipuSnapshot() }),
      });
      const response = await handleIngestZhipu(request, env);
      const payload = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      const usageWrite = writes.find((w: any) => w.provider_key === "zhipu") as any;
      expect(usageWrite).toBeTruthy();
      expect(usageWrite.payload.providerId).toBe("zhipu");
      expect(usageWrite.payload.windows).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects deepseek snapshots on the zhipu endpoint", async () => {
    const env = makeEnv();
    const request = new Request("https://api.monitor.local/api/ingest/zhipu", {
      method: "POST",
      headers: { "X-Ingest-Key": "ingest-secret", "content-type": "application/json" },
      body: JSON.stringify({ snapshot: makeDeepSeekSnapshot() }),
    });
    const response = await handleIngestZhipu(request, env);
    expect(response.status).toBe(400);
  });

  it("returns 401 when the ingest key is missing", async () => {
    const env = makeEnv();
    const request = new Request("https://api.monitor.local/api/ingest/zhipu", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshot: makeZhipuSnapshot() }),
    });
    const response = await handleIngestZhipu(request, env);
    expect(response.status).toBe(401);
  });
});

describe("handleIngestChatgpt", () => {
  // 实测 codex/usage 结构（rate_limit 单数 + primary/secondary_window + 顶层 plan_type）
  const realCodexPayload = {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 42.5, limit_window_seconds: 18000, reset_after_seconds: 3600 },
      secondary_window: { used_percent: 25, limit_window_seconds: 604800, reset_at: 1794844800 },
    },
  };

  function makeChatgptRequest(body: unknown, headers: Record<string, string> = {}) {
    return new Request("https://api.monitor.local/api/ingest/chatgpt", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Ingest-Key": "ingest-secret", ...headers },
      body: JSON.stringify(body),
    });
  }

  // Supabase REST mock：listProviderSettings 读账号 + persistSnapshot 落库（沿用 index.test.ts 的表 mock 方式）
  function makeSupabaseFetch(accounts: unknown[] = []) {
    const writes: { path: string; method: string; search: string; body: any }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      const parsed = new URL(url);
      const method = init?.method ?? "GET";
      if (parsed.pathname === "/rest/v1/provider_preferences" && method === "GET") {
        return Response.json([]);
      }
      if (parsed.pathname === "/rest/v1/provider_accounts" && method === "GET") {
        return Response.json(accounts);
      }
      if (parsed.pathname === "/rest/v1/provider_accounts") {
        writes.push({ path: parsed.pathname, method, search: parsed.search, body: JSON.parse(String(init?.body ?? "null")) });
        return new Response("", { status: 201 });
      }
      if (parsed.pathname === "/rest/v1/usage_snapshots" && method === "POST") {
        writes.push({ path: parsed.pathname, method, search: parsed.search, body: JSON.parse(String(init?.body)) });
        return new Response("", { status: 201 });
      }
      if (parsed.pathname === "/rest/v1/quota_windows" && method === "POST") {
        return new Response("", { status: 201 });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    return { fetchImpl, writes };
  }

  const chatgptAccountRow = {
    id: "account-chatgpt-1",
    provider_key: "chatgpt",
    account_label: "ChatGPT 主账号",
    source_url: "https://chatgpt.com",
    status: "ready",
  };

  it("returns 401 when x-ingest-key is missing or wrong", async () => {
    const env = makeEnv();
    const missing = await handleIngestChatgpt(makeChatgptRequest({ codex: realCodexPayload }, { "X-Ingest-Key": "" }), env);
    expect(missing.status).toBe(401);
    const wrong = await handleIngestChatgpt(makeChatgptRequest({ codex: realCodexPayload }, { "X-Ingest-Key": "not-the-key" }), env);
    expect(wrong.status).toBe(401);
  });

  it("returns 503 when INGEST_API_KEY is not configured", async () => {
    const env = makeEnv({ INGEST_API_KEY: undefined });
    const response = await handleIngestChatgpt(makeChatgptRequest({ codex: realCodexPayload }), env);
    expect(response.status).toBe(503);
  });

  it("returns 400 when the body has no codex/rateLimits/subscription payload", async () => {
    const env = makeEnv();
    const response = await handleIngestChatgpt(makeChatgptRequest({}), env);
    expect(response.status).toBe(400);
  });

  it("returns 400 when the codex payload yields neither windows nor a subscription plan", async () => {
    const env = makeEnv();
    const response = await handleIngestChatgpt(makeChatgptRequest({ codex: { foo: 1 } }), env);
    expect(response.status).toBe(400);
  });

  it("parses the real codex payload, attaches the chatgpt account and persists a local_ingest snapshot", async () => {
    const { fetchImpl, writes } = makeSupabaseFetch([chatgptAccountRow]);
    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = makeEnv();
      const response = await handleIngestChatgpt(
        makeChatgptRequest({ capturedAt: "2026-10-14T00:00:00.000Z", codex: realCodexPayload }),
        env,
      );
      const payload = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.data).toMatchObject({
        providerId: "chatgpt",
        capturedAt: "2026-10-14T00:00:00.000Z",
        status: "ready",
        windows: 2,
        plan: "plus",
      });

      const usageWrite = writes.find((w) => w.path === "/rest/v1/usage_snapshots");
      expect(usageWrite).toBeTruthy();
      expect(usageWrite!.body.provider_key).toBe("chatgpt");
      // 挂到 listProviderSettings 找到的 chatgpt 账号行
      expect(usageWrite!.body.provider_account_id).toBe("account-chatgpt-1");
      expect(usageWrite!.body.payload.meta.fetchMethod).toBe("local_ingest");
      expect(usageWrite!.body.payload.meta.accountId).toBe("account-chatgpt-1");
      expect(usageWrite!.body.payload.metrics.plan).toBe("plus");
      expect(usageWrite!.body.payload.windows.map((w: any) => w.key)).toEqual(["codex_5h", "codex_weekly"]);
      // 已知账号时按 id PATCH 账号行，而非 source_url upsert
      const accountWrite = writes.find((w) => w.path === "/rest/v1/provider_accounts");
      expect(accountWrite!.method).toBe("PATCH");
      expect(accountWrite!.search).toContain("id=eq.account-chatgpt-1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts a free-plan subscription payload without windows", async () => {
    const { fetchImpl, writes } = makeSupabaseFetch([chatgptAccountRow]);
    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = makeEnv();
      const response = await handleIngestChatgpt(
        makeChatgptRequest({ subscription: { account: { plan_type: "free" } } }),
        env,
      );
      const payload = (await response.json()) as any;

      // 免费档无窗口：只要有订阅档位即可入库（status=partial）
      expect(response.status).toBe(200);
      expect(payload.data).toMatchObject({ providerId: "chatgpt", status: "partial", windows: 0, plan: "free" });

      const usageWrite = writes.find((w) => w.path === "/rest/v1/usage_snapshots");
      expect(usageWrite!.body.payload.windows).toEqual([]);
      expect(usageWrite!.body.payload.metrics.plan).toBe("free");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("仅推送 v4 accounts/check 订阅 payload（无 codex/rateLimits）→ 200 且落库 plan/续费时间", async () => {
    // 本机 refresh-chatgpt-usage.ts 的真实推送形态：accounts/check/v4-2023-04-27 原始响应体
    const v4PlusPayload = {
      accounts: {
        default: {
          account: { plan_type: "plus", plan_display_name: "ChatGPT Plus" },
          entitlement: {
            subscription_plan: "chatgptplusplan",
            has_active_subscription: true,
            renews_at: "2026-11-01T00:00:00Z",
            expires_at: null,
            cancels_at: null,
          },
          last_active_subscription: { will_renew: true, purchase_origin_platform: "chatgpt_web" },
        },
      },
      account_ordering: ["default"],
    };

    const { fetchImpl, writes } = makeSupabaseFetch([chatgptAccountRow]);
    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = makeEnv();
      const response = await handleIngestChatgpt(
        makeChatgptRequest({ subscription: v4PlusPayload }),
        env,
      );
      const payload = (await response.json()) as any;

      // 无窗口但订阅档位有效：应入库而非 400
      expect(response.status).toBe(200);
      expect(payload.data).toMatchObject({
        providerId: "chatgpt",
        status: "partial",
        windows: 0,
        plan: "plus",
      });

      const usageWrite = writes.find((w) => w.path === "/rest/v1/usage_snapshots");
      expect(usageWrite).toBeTruthy();
      expect(usageWrite!.body.payload.metrics.plan).toBe("plus");
      expect(usageWrite!.body.payload.metrics.planRenewAt).toBe("2026-11-01T00:00:00.000Z");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("parses a rateLimits payload into web windows with direct fetch method", async () => {
    const { fetchImpl, writes } = makeSupabaseFetch([chatgptAccountRow]);
    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = makeEnv();
      const response = await handleIngestChatgpt(
        makeChatgptRequest({
          rateLimits: [{ slug: "gpt_5_high", used_percent: 0.4, resets_in_seconds: 900 }],
        }),
        env,
      );
      const payload = (await response.json()) as any;

      expect(response.status).toBe(200);
      expect(payload.data).toMatchObject({ providerId: "chatgpt", status: "ready", windows: 1 });

      const usageWrite = writes.find((w) => w.path === "/rest/v1/usage_snapshots");
      expect(usageWrite!.body.payload.windows.map((w: any) => w.key)).toEqual(["web_5h_gpt_5_high"]);
      expect(usageWrite!.body.payload.metrics.webFetchMethod).toBe("direct");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});