// @vitest-environment node
import { describe, expect, it } from "vitest";
import { handleApiRequest } from "../../worker/index";
import type { ProviderId, WorkerEnv } from "../../worker/types";

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function createDirectEnv(): WorkerEnv {
  return {
    REFRESH_SESSION: {
      idFromName(name: string) {
        return name;
      },
      get() {
        throw new Error("REFRESH_SESSION is not used by direct provider snapshot tests");
      },
    },
    OPENROUTER_API_KEY: readEnv("OPENROUTER_API_KEY"),
    OPENROUTER_BASE_URL: readEnv("OPENROUTER_BASE_URL"),
    OPENCODE_GO_WORKSPACE_ID: readEnv("OPENCODE_GO_WORKSPACE_ID"),
    OPENCODE_GO_AUTH_COOKIE: readEnv("OPENCODE_GO_AUTH_COOKIE"),
    OPENCODE_GO_BASE_URL: readEnv("OPENCODE_GO_BASE_URL"),
    XFYUN_MAAS_API_URL: readEnv("XFYUN_MAAS_API_URL"),
    XFYUN_MAAS_PAGE_URL: readEnv("XFYUN_MAAS_PAGE_URL"),
    XFYUN_MAAS_AUTH_COOKIE: readEnv("XFYUN_MAAS_AUTH_COOKIE"),
    ALIYUN_BAILIAN_PAGE_URL: readEnv("ALIYUN_BAILIAN_PAGE_URL"),
    ALIYUN_BAILIAN_API_URL: readEnv("ALIYUN_BAILIAN_API_URL"),
    ALIYUN_BAILIAN_AUTH_COOKIE: readEnv("ALIYUN_BAILIAN_AUTH_COOKIE"),
    VOLC_ARK_PAGE_URL: readEnv("VOLC_ARK_PAGE_URL"),
    VOLC_ARK_API_URL: readEnv("VOLC_ARK_API_URL"),
    VOLC_ARK_AUTH_COOKIE: readEnv("VOLC_ARK_AUTH_COOKIE"),
    DEEPSEEK_API_KEY: readEnv("DEEPSEEK_API_KEY"),
    DEEPSEEK_PAGE_URL: readEnv("DEEPSEEK_PAGE_URL"),
    DEEPSEEK_USER_TOKEN: readEnv("DEEPSEEK_USER_TOKEN"),
    DEEPSEEK_AUTH_COOKIE: readEnv("DEEPSEEK_AUTH_COOKIE"),
    ZHIPU_PAGE_URL: readEnv("ZHIPU_PAGE_URL"),
    ZHIPU_API_BASE: readEnv("ZHIPU_API_BASE"),
    ZHIPU_AUTH_COOKIE: readEnv("ZHIPU_AUTH_COOKIE"),
    ZHIPU_AUTH_TOKEN: readEnv("ZHIPU_AUTH_TOKEN"),
  };
}

const requiredEnvByProvider: Record<ProviderId, string[]> = {
  openrouter: ["OPENROUTER_API_KEY"],
  "deepseek": ["DEEPSEEK_API_KEY", "DEEPSEEK_USER_TOKEN", "DEEPSEEK_AUTH_COOKIE"],
  "opencode-go": ["OPENCODE_GO_WORKSPACE_ID", "OPENCODE_GO_AUTH_COOKIE"],
  "xfyun-maas": ["XFYUN_MAAS_API_URL", "XFYUN_MAAS_AUTH_COOKIE"],
  "aliyun-bailian": ["ALIYUN_BAILIAN_API_URL", "ALIYUN_BAILIAN_AUTH_COOKIE"],
  "volc-ark": ["VOLC_ARK_AUTH_COOKIE"],
  "zhipu": ["ZHIPU_AUTH_COOKIE"],
};

describe.skipIf(process.env.RUN_REAL_E2E !== "1")("real provider snapshot e2e", () => {
  for (const [providerId, requiredEnv] of Object.entries(requiredEnvByProvider) as Array<[ProviderId, string[]]>) {
    it(`loads ${providerId} usage snapshot directly`, async () => {
      const missing = requiredEnv.filter((name) => !readEnv(name));
      if (missing.length > 0) {
        throw new Error(`缺少 ${providerId} 真实测试环境变量: ${missing.join(", ")}`);
      }

      const response = await handleApiRequest(
        new Request(`https://api-monitor.local/api/providers/${providerId}/snapshot`),
        createDirectEnv(),
      );
      const payload = (await response.json()) as {
        ok: boolean;
        data?: {
          snapshot?: {
            providerId: string;
            status: string;
            windows: unknown[];
          };
        };
        error?: { message?: string };
      };

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.data?.snapshot?.providerId).toBe(providerId);
      expect(payload.data?.snapshot?.status).toBe("ready");
      expect(payload.data?.snapshot?.windows.length).toBeGreaterThan(0);
    }, 30_000);
  }
});
