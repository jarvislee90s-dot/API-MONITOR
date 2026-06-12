// @vitest-environment node
import { describe, expect, it } from "vitest";
import { handleApiRequest } from "../../worker/index";
import { RefreshSessionDurableObject } from "../../worker/durable-object/refresh-session";
import type { WorkerEnv } from "../../worker/types";

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

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function createRefreshNamespace(): WorkerEnv["REFRESH_SESSION"] {
  const objects = new Map<string, RefreshSessionDurableObject>();

  return {
    idFromName(name: string) {
      return name;
    },
    get(id: string) {
      let instance = objects.get(id);
      if (!instance) {
        instance = new RefreshSessionDurableObject(
          { storage: new MemoryStorage() },
          {
            REFRESH_COOLDOWN_MS: "1",
            REFRESH_ACTIVE_WINDOW_MS: "600000",
          },
        );
        objects.set(id, instance);
      }

      return {
        fetch(request: Request) {
          return instance!.fetch(request);
        },
      };
    },
  };
}

function createRealEnv(): WorkerEnv {
  return {
    SUPABASE_URL: readEnv("SUPABASE_URL"),
    SUPABASE_SERVICE_ROLE_KEY: readEnv("SUPABASE_SERVICE_ROLE_KEY"),
    SUPABASE_USER_ID: readEnv("SUPABASE_USER_ID"),
    OPENROUTER_API_KEY: readEnv("OPENROUTER_API_KEY"),
    OPENROUTER_BASE_URL: readEnv("OPENROUTER_BASE_URL"),
    OPENCODE_GO_WORKSPACE_ID: readEnv("OPENCODE_GO_WORKSPACE_ID"),
    OPENCODE_GO_AUTH_COOKIE: readEnv("OPENCODE_GO_AUTH_COOKIE"),
    OPENCODE_GO_BASE_URL: readEnv("OPENCODE_GO_BASE_URL"),
    XFYUN_MAAS_API_URL: readEnv("XFYUN_MAAS_API_URL"),
    XFYUN_MAAS_PAGE_URL: readEnv("XFYUN_MAAS_PAGE_URL"),
    XFYUN_MAAS_AUTH_COOKIE: readEnv("XFYUN_MAAS_AUTH_COOKIE"),
    REFRESH_SESSION: createRefreshNamespace(),
  };
}

function requireEnv(names: string[]) {
  const missing = names.filter((name) => !readEnv(name));
  if (missing.length > 0) {
    throw new Error(`缺少端到端测试环境变量: ${missing.join(", ")}`);
  }
}

describe.skipIf(process.env.RUN_REAL_E2E !== "1")("real provider refresh e2e", () => {
  it("refreshes providers and persists snapshots to Supabase", async () => {
    requireEnv(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_USER_ID"]);

    const response = await handleApiRequest(
      new Request("https://api-monitor.local/api/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionKey: `real-e2e-${Date.now()}`,
          persist: true,
        }),
      }),
      createRealEnv(),
    );
    const payload = (await response.json()) as {
      ok: boolean;
      data?: {
        kind: string;
        cards: Array<{
          providerId: string;
          status: string;
          windows: unknown[];
          summary: string;
        }>;
      };
      error?: { message?: string };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data?.kind).toBe("usage_dashboard");
    expect(payload.data?.cards).toHaveLength(3);
    expect(payload.data?.cards.map((card) => card.providerId)).toEqual([
      "openrouter",
      "opencode-go",
      "xfyun-maas",
    ]);
  }, 30_000);
});
