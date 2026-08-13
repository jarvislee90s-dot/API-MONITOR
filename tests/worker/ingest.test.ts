import { describe, expect, it, vi } from "vitest";

import { handleIngestOpenCodeGo } from "../../worker/ingest";
import { handleIngestDeepSeek } from "../../worker/ingest";
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