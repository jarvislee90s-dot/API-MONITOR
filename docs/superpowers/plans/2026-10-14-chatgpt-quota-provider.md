# ChatGPT 订阅额度监控 Provider（第一期）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 新增 `chatgpt` provider，独立分桶监控 Codex 编码额度（5h/周窗）、网页对话 5 小时额度（按模型组）、订阅档位与续费日期，token 自动刷新写回云端。

**架构：** 方案 C 混合分治：Codex OAuth 链路全自动（Bearer + `chatgpt-account-id`，401 时 refresh token 纯 HTTP 刷新并经 `credentialUpdate` 写回 Supabase），网页/订阅链路云端直连尝试（session cookie → accessToken → rate_limits / accounts/check），CF 质询与结构漂移按单桶降级。三条链路在单个 provider 内以独立函数实现（互不阻塞、超时各自独立），合并为一份 `ProviderSnapshot`，刷新节流与快照持久化全部复用既有机制。

**技术栈：** Cloudflare Worker TS + Supabase（AES-GCM 凭据表）+ React/Vite 前端 + Vitest（mock fetch + 假 token，真实凭据绝不进 fixture）。

**设计依据：** `docs/superpowers/specs/2026-10-14-chatgpt-quota-provider-design.md`（本计划逐条落实其 §10 第一期清单）。

**验证命令（以 package.json 实际脚本名为准）：** `npm run test:worker`、`npm run test:frontend`、`npm run test`、`npm run build`（= `tsc --noEmit` + 前端构建）。注意：仓库中没有 `worker:test` / `frontend:test` 脚本，不要使用。

**任务总览：**

| Task | 内容 | 对应 spec |
| --- | --- | --- |
| 1 | `worker/types.ts`：ProviderId + WorkerEnv + `credentialUpdate` + ProviderWindow.meta | §4、§10 |
| 2 | `worker/settings/repository.ts`：`updateProviderAccountCredentials` + 单测 | §4 |
| 3 | `worker/providers/chatgpt.ts`：白名单、无凭据 login_required、Codex 链路、mergeChatgptBuckets + 组一测试 | §5、§6 |
| 4 | 网页/订阅链路（session 换 accessToken、message_cap/分组双形态、订阅 404→free）+ 组二测试 | §2、§5、§6 |
| 5 | registry 注册 + 三处测试断言同步（providers.test.ts / index.test.ts×2） | §10 |
| 6 | `worker/index.ts`：buildProviderConfig 分支、15s 超时、credentialUpdate 写回、桶级窗口补齐 | §4、§6 |
| 7 | 前端四处：catalog / 凭据表单 / client.ts 映射与兜底 + 前端测试 | §7 |
| 8 | `scripts/probe-chatgpt-endpoints.ts` 一次性探测脚本 | §2、§8 |
| 9 | `scripts/import-chatgpt-credentials.ts` 导入脚本（--check 干跑） | §8 |
| 10 | 全量回归 + 手动验收（spec §9 a-d） | §9 |

---

## Task 1：类型层扩展（ProviderId / WorkerEnv / credentialUpdate / ProviderWindow.meta）

纯类型任务，无可失败测试；验证 = 编译通过 + 既有测试不回归。ProviderWindow 的 `meta` 可选字段供 Task 6 的桶级补齐窗口打 `stale` 标记（spec §6「补齐窗口打 meta.stale=true」）。

**Files:**

- Modify: `worker/types.ts:1-9`（ProviderId 联合类型）
- Modify: `worker/types.ts:13-22`（ProviderWindow 尾部加 meta）
- Modify: `worker/types.ts:119-122`（ProviderFetchResult 加 credentialUpdate）
- Modify: `worker/types.ts:214-217`（WorkerEnv OLLAMA_* 之后加 CHATGPT_*）
- Test: 既有 `tests/worker/providers.test.ts`（此时 registry 尚未注册 chatgpt，运行时列表不变，预期全绿）

**步骤：**

- [ ] 修改 `worker/types.ts:1-9`，ProviderId 联合类型加 `"chatgpt"`：

```ts
export type ProviderId =
  | "openrouter"
  | "opencode-go"
  | "xfyun-maas"
  | "aliyun-bailian"
  | "volc-ark"
  | "deepseek"
  | "zhipu"
  | "ollama"
  | "chatgpt";
```

- [ ] 修改 `worker/types.ts:13-22`，ProviderWindow 末尾（`resetAt` 之后）加可选 meta：

```ts
export type ProviderWindow = {
  key: string;
  label: string;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  percentUsed?: number | null;
  percentRemaining?: number | null;
  resetAt?: string | null;
  meta?: Record<string, unknown>;
};
```

- [ ] 修改 `worker/types.ts:119-122`，ProviderFetchResult 加 credentialUpdate（token 轮换写回通道，spec §4）：

```ts
export type ProviderFetchResult = {
  snapshot: ProviderSnapshot;
  warnings: string[];
  credentialUpdate?: Record<string, string>;
};
```

- [ ] 修改 `worker/types.ts:214-217`，在 `OLLAMA_AUTH_COOKIE?: string;` 之后、`REFRESH_SESSION` 之前插入：

```ts
  CHATGPT_ACCESS_TOKEN?: string;
  CHATGPT_REFRESH_TOKEN?: string;
  CHATGPT_ACCOUNT_ID?: string;
  CHATGPT_SESSION_TOKEN?: string;
```

- [ ] 运行 `npx tsc --noEmit`，预期 0 错误。
- [ ] 运行 `npm run test:worker`，预期全部通过（registry 运行时列表未变）。
- [ ] 提交：

```bash
git add worker/types.ts
git commit -m "feat(worker): 类型层扩展 chatgpt——ProviderId/WorkerEnv/credentialUpdate/ProviderWindow.meta"
```

---

## Task 2：repository 新增 updateProviderAccountCredentials（token 轮换写回）

复用既有 `encryptCredentialPayload` / `maskCredentialPayload` / `createSupabaseHeaders`，签名风格与 `updateProviderAccountDisplay`（`repository.ts:268-318`）一致。写回失败抛错由调用方（index.ts，Task 6）降级为 warning。

**Files:**

- Modify: `worker/settings/repository.ts:638`（在 `upsertProviderAccount` 结束后、`updateProviderAccount`（:640）之前插入新函数）
- Test: `tests/worker/settings-routes.test.ts`（文件末尾追加 describe；该文件无独立 repository 单测文件，按计划并入此处，直接以 mock fetchImpl 单测新函数）

**步骤：**

- [ ] 在 `tests/worker/settings-routes.test.ts` 顶部把 vitest 导入改为含 `vi`，并追加两个导入：

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { handleSettingsRequest } from "../../worker/settings/routes";
import { updateProviderAccountCredentials } from "../../worker/settings/repository";
import { decryptCredentialPayload } from "../../worker/security/credentials";
```

- [ ] 在文件末尾追加失败测试：

```ts
describe("updateProviderAccountCredentials", () => {
  const encryptionKey = "0123456789abcdef0123456789abcdef"; // 32 字节测试密钥
  const env = {
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
    CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
  };

  it("加密覆盖写入凭据行并同步脱敏 hint", async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      });
      return new Response("{}", { status: 201 });
    });

    const result = await updateProviderAccountCredentials(
      env,
      "user-1",
      "acc-1",
      { accessToken: "fake-access-token-2", refreshToken: "fake-refresh-token-2" },
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ id: "acc-1" });
    // 1. 覆盖写入 provider_account_credentials（on_conflict=provider_account_id）
    expect(calls[0]?.url).toBe(
      "https://supabase.test/rest/v1/provider_account_credentials?on_conflict=provider_account_id",
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toMatchObject({ user_id: "user-1", provider_account_id: "acc-1", key_version: "v1" });
    // 密文走同一 AES-GCM 通道，可用原密钥解回
    const decrypted = await decryptCredentialPayload(
      {
        encryptedPayload: String(calls[0]?.body?.encrypted_payload),
        nonce: String(calls[0]?.body?.nonce),
        keyVersion: "v1",
      },
      encryptionKey,
    );
    expect(decrypted).toEqual({ accessToken: "fake-access-token-2", refreshToken: "fake-refresh-token-2" });
    // 2. PATCH provider_accounts 同步脱敏 hint
    expect(calls[1]?.url).toBe("https://supabase.test/rest/v1/provider_accounts?id=eq.acc-1&user_id=eq.user-1");
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.body?.credential_hint).toEqual({
      accessToken: "fake-...en-2",
      refreshToken: "fake-...en-2",
    });
  });

  it("凭据写入失败时抛错", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    await expect(
      updateProviderAccountCredentials(
        env,
        "user-1",
        "acc-1",
        { accessToken: "fake-access-token-2" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow("Failed to update provider account credentials: 500");
  });

  it("缺少加密密钥时抛错", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    await expect(
      updateProviderAccountCredentials(
        { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY },
        "user-1",
        "acc-1",
        { accessToken: "fake-access-token-2" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow("Credential encryption key is required to update credentials");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] 运行 `npm run test:worker -- settings-routes`，预期失败：`FAIL tests/worker/settings-routes.test.ts > updateProviderAccountCredentials`，错误为 `does not provide an export named 'updateProviderAccountCredentials'`（或 `updateProviderAccountCredentials is not a function`）。
- [ ] 在 `worker/settings/repository.ts` 的 `upsertProviderAccount` 结束（第 638 行 `}`）之后插入实现：

```ts
// 覆盖写入指定账号的加密凭据（chatgpt token 轮换写回通道）；
// credential_hint 为展示用，同步失败不影响写回结果
export async function updateProviderAccountCredentials(
  env: SettingsEnv & { CREDENTIAL_ENCRYPTION_KEY?: string },
  userId: string,
  accountId: string,
  credentials: CredentialPayload,
  fetchImpl: typeof fetch,
): Promise<{ id: string }> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase configuration missing");
  }

  const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("Credential encryption key is required to update credentials");
  }

  const headers = createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY);
  const encrypted = await encryptCredentialPayload(credentials, encryptionKey);

  const credUrl = new URL("/rest/v1/provider_account_credentials", env.SUPABASE_URL);
  credUrl.searchParams.set("on_conflict", "provider_account_id");

  const credResponse = await fetchImpl(credUrl, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates,return=minimal",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      user_id: userId,
      provider_account_id: accountId,
      encrypted_payload: encrypted.encryptedPayload,
      nonce: encrypted.nonce,
      key_version: encrypted.keyVersion,
    }),
  });

  if (!credResponse.ok) {
    throw new Error(`Failed to update provider account credentials: ${credResponse.status}`);
  }

  const hintUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  hintUrl.searchParams.set("id", `eq.${accountId}`);
  hintUrl.searchParams.set("user_id", `eq.${userId}`);

  await fetchImpl(hintUrl, {
    method: "PATCH",
    headers: {
      ...headers,
      Prefer: "return=minimal",
      "content-type": "application/json",
    },
    body: JSON.stringify({ credential_hint: maskCredentialPayload(credentials) }),
  }).catch(() => undefined);

  return { id: accountId };
}
```

- [ ] 运行 `npm run test:worker -- settings-routes`，预期全部通过。
- [ ] 运行 `npm run test:worker`，预期全绿。
- [ ] 提交：

```bash
git add worker/settings/repository.ts tests/worker/settings-routes.test.ts
git commit -m "feat(worker): repository 新增 updateProviderAccountCredentials——token 轮换写回通道"
```

---

## Task 3：chatgpt.ts 骨架 + Codex 链路 + 三桶合并（spec §9 测试组一）

创建 `worker/providers/chatgpt.ts`。本任务交付：域名白名单、无凭据 login_required、`parseCodexWindows` 宽容解析、`refreshCodexToken`、`fetchCodexWindows`（401 → 刷新 → 重试一次 → credentialUpdate 带出）、`mergeChatgptBuckets`（spec §5 状态机完整实现，纯函数）。网页/订阅链路在 Task 4 接入；本任务结束时模块尚未注册进 registry（Task 5），仅被测试直接引用，生产行为不受影响。

`CODEX_TOKEN_URL` 与默认 client_id 为常量；实现期需与 Task 8 探测脚本输出核对，若不符以探测结果修正 `defaultCodexClientId` 常量并同步更新本任务「refreshes the codex token」测试中的 client_id 断言。

**Files:**

- Create: `worker/providers/chatgpt.ts`
- Test: `tests/worker/providers.test.ts`（文件末尾 :1467 之后追加导入与两组 describe 的第一组）

**步骤：**

- [ ] 在 `tests/worker/providers.test.ts` 导入区（:12 `fetchOllamaSnapshot` 之后）追加：

```ts
import {
  fetchChatgptSnapshot,
  isTrustedChatgptUrl,
  mergeChatgptBuckets,
  parseCodexWindows,
} from "../../worker/providers/chatgpt";
```

- [ ] 在文件末尾追加组一失败测试：

```ts
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

    // 重试必须用新 token
    const retryCall = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect((retryCall[1].headers as Record<string, string>).Authorization).toBe("Bearer fake-access-token-2");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
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
```

- [ ] 运行 `npm run test:worker -- providers`，预期失败：`Error: Failed to resolve import "../../worker/providers/chatgpt"`（模块不存在）。
- [ ] 创建 `worker/providers/chatgpt.ts`，完整内容：

```ts
import { clampNumber, toIsoString } from "../http";
import type {
  ProviderDefinition,
  ProviderFetchInput,
  ProviderFetchResult,
  ProviderSnapshot,
  ProviderStatus,
  ProviderWindow,
} from "../types";
import { createResult } from "./types";

type ChatgptConfig = {
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
  sessionToken?: string;
  codexClientId?: string;
};

const defaultSourceUrl = "https://chatgpt.com";
const codexRateLimitsUrl = "https://chatgpt.com/backend-api/codex/rate_limits";
const codexTokenUrl = "https://auth.openai.com/oauth/token";
const webSessionUrl = "https://chatgpt.com/api/auth/session";
const webRateLimitsUrl = "https://chatgpt.com/backend-api/rate_limits";
const subscriptionCheckUrl = "https://chatgpt.com/backend-api/accounts/check";
// codex CLI 公开 client_id；实现期与 scripts/probe-chatgpt-endpoints.ts 探测输出核对，
// 若不符以探测结果修正此常量并同步更新 providers.test.ts 刷新测试的 client_id 断言
const defaultCodexClientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const defaultRequestTimeoutMs = 15_000;
const webUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 域名白名单：凭据只允许发往 chatgpt.com 系与 auth.openai.com（spec §4）
export function isTrustedChatgptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    return (
      url.hostname === "chatgpt.com" ||
      url.hostname.endsWith(".chatgpt.com") ||
      url.hostname === "auth.openai.com"
    );
  } catch {
    return false;
  }
}

// CF 质询识别：403 且响应头 cf-mitigated: challenge（spec §6）
export function isCloudflareChallenge(response: Response): boolean {
  if (response.status !== 403) return false;
  return response.headers.get("cf-mitigated")?.toLowerCase() === "challenge";
}

// 单链路网络超时（spec §6：15s，照 opencode-go 的 requestTimeoutMs 约定）
function buildTimeoutSignal(requestTimeoutMs?: number): AbortSignal | undefined {
  return AbortSignal.timeout(requestTimeoutMs ?? defaultRequestTimeoutMs);
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = clampNumber(source[key]);
    if (value !== null) return value;
  }
  return null;
}

// 小数（0~1）按百分比放大，其余视为已是百分比值
function toPercentValue(value: number | null): number | null {
  if (value === null) return null;
  const percent = value > 0 && value <= 1 ? value * 100 : value;
  return Math.round(percent * 10) / 10;
}

// 重置时间：优先 ISO 字段，其次"剩余秒数 + now"推算
function pickResetAt(source: Record<string, unknown>, now: Date): string | null {
  for (const key of ["reset_at", "resets_at", "resetAt", "resetsAt", "reset_time"]) {
    const raw = source[key];
    if (typeof raw === "string" && raw.length > 0) {
      const date = new Date(raw);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  const seconds = pickNumber(source, [
    "resets_in_seconds",
    "reset_in_seconds",
    "seconds_until_reset",
    "reset_after_seconds",
  ]);
  if (seconds !== null && seconds >= 0) {
    return new Date(now.getTime() + seconds * 1000).toISOString();
  }
  return null;
}

function buildPercentWindow(params: {
  key: string;
  label: string;
  percentUsed: number | null;
  resetAt: string | null;
}): ProviderWindow {
  return {
    key: params.key,
    label: params.label,
    used: params.percentUsed ?? undefined,
    limit: params.percentUsed !== null ? 100 : undefined,
    remaining: params.percentUsed !== null ? Math.max(0, 100 - params.percentUsed) : undefined,
    percentUsed: params.percentUsed,
    percentRemaining: params.percentUsed !== null ? Math.max(0, 100 - params.percentUsed) : undefined,
    resetAt: params.resetAt,
  };
}

// 宽容解析 codex rate_limits：根对象或 rate_limits 键下，
// 键名含 5h/primary/session → codex_5h，含 week/secondary/7d → codex_weekly（spec §2）
export function parseCodexWindows(payload: unknown, now: Date): ProviderWindow[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const container = ((payload as { rate_limits?: unknown }).rate_limits ?? payload) as Record<
    string,
    unknown
  >;
  if (!container || typeof container !== "object") return [];

  const windows: ProviderWindow[] = [];
  for (const [rawKey, rawValue] of Object.entries(container)) {
    if (!rawValue || typeof rawValue !== "object") continue;
    const source = rawValue as Record<string, unknown>;
    const isFiveHour = /5h|primary|session/i.test(rawKey);
    const isWeekly = /week|secondary|7d/i.test(rawKey);
    if (!isFiveHour && !isWeekly) continue;
    const key = isFiveHour ? "codex_5h" : "codex_weekly";
    if (windows.some((window) => window.key === key)) continue;

    let percentUsed = toPercentValue(
      pickNumber(source, [
        "used_percent",
        "used_pct",
        "usage_percent",
        "usagePercent",
        "percent_used",
        "percentUsed",
        "usage",
      ]),
    );
    if (percentUsed === null) {
      const used = pickNumber(source, ["used", "used_requests", "requests_used", "count"]);
      const limit = pickNumber(source, ["limit", "total", "max", "capacity"]);
      if (used !== null && limit !== null && limit > 0) {
        percentUsed = Math.round((used / limit) * 1000) / 10;
      }
    }
    const resetAt = pickResetAt(source, now);
    if (percentUsed === null && resetAt === null) continue;

    windows.push(
      buildPercentWindow({
        key,
        label: isFiveHour ? "Codex 5小时" : "Codex 每周",
        percentUsed,
        resetAt,
      }),
    );
  }
  return windows;
}

// 用 refresh token 纯 HTTP 刷新 access token；失败返回 null，由调用方按桶降级（spec §2）
async function refreshCodexToken(input: {
  refreshToken: string;
  clientId: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<{ accessToken: string; refreshToken: string } | null> {
  try {
    const response = await input.fetchImpl(codexTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: input.clientId,
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
      }),
      signal: buildTimeoutSignal(input.requestTimeoutMs),
    });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      refresh_token?: unknown;
    } | null;
    if (!payload || typeof payload.access_token !== "string" || payload.access_token.length === 0) {
      return null;
    }
    return {
      accessToken: payload.access_token,
      // 部分实现不回传新 refresh token，沿用旧值
      refreshToken:
        typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
          ? payload.refresh_token
          : input.refreshToken,
    };
  } catch {
    return null;
  }
}

// 三桶统一结果形态（网页/订阅链路在 Task 4 复用）
export type ChatgptBucketOutcome = {
  attempted: boolean;
  windows: ProviderWindow[];
  loginRequired: boolean;
  cfChallenge: boolean;
  fetchFailed: boolean;
};

function notConfiguredBucket(): ChatgptBucketOutcome {
  return { attempted: false, windows: [], loginRequired: false, cfChallenge: false, fetchFailed: false };
}

async function requestCodexRateLimits(input: {
  accessToken: string;
  accountId: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<Response> {
  return input.fetchImpl(codexRateLimitsUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${input.accessToken}`,
      "chatgpt-account-id": input.accountId,
      "User-Agent": webUserAgent,
    },
    signal: buildTimeoutSignal(input.requestTimeoutMs),
  });
}

// codex 链路：Bearer + chatgpt-account-id；401/403（非质询）→ 刷新 → 重试一次 → credentialUpdate 带出（spec §6）
async function fetchCodexWindows(input: {
  config: ChatgptConfig;
  now: Date;
  fetchImpl: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<{ outcome: ChatgptBucketOutcome; credentialUpdate: Record<string, string> | null }> {
  if (!isTrustedChatgptUrl(codexRateLimitsUrl) || !isTrustedChatgptUrl(codexTokenUrl)) {
    return { outcome: { ...notConfiguredBucket(), fetchFailed: true }, credentialUpdate: null };
  }

  const accessToken = input.config.accessToken ?? "";
  const accountId = input.config.accountId ?? "";

  let response: Response;
  try {
    response = await requestCodexRateLimits({
      accessToken,
      accountId,
      fetchImpl: input.fetchImpl,
      requestTimeoutMs: input.requestTimeoutMs,
    });
  } catch {
    return { outcome: { ...notConfiguredBucket(), attempted: true, fetchFailed: true }, credentialUpdate: null };
  }

  let credentialUpdate: Record<string, string> | null = null;
  if ((response.status === 401 || response.status === 403) && input.config.refreshToken) {
    const refreshed = await refreshCodexToken({
      refreshToken: input.config.refreshToken,
      clientId: input.config.codexClientId?.trim() || defaultCodexClientId,
      fetchImpl: input.fetchImpl,
      requestTimeoutMs: input.requestTimeoutMs,
    });
    if (refreshed) {
      // 即使重试仍失败也要带出新 token：refresh token 轮换后旧值可能已作废
      credentialUpdate = { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken };
      try {
        response = await requestCodexRateLimits({
          accessToken: refreshed.accessToken,
          accountId,
          fetchImpl: input.fetchImpl,
          requestTimeoutMs: input.requestTimeoutMs,
        });
      } catch {
        return {
          outcome: { ...notConfiguredBucket(), attempted: true, fetchFailed: true },
          credentialUpdate,
        };
      }
    }
  }

  if (isCloudflareChallenge(response)) {
    return { outcome: { ...notConfiguredBucket(), attempted: true, cfChallenge: true }, credentialUpdate };
  }
  if (response.status === 401 || response.status === 403) {
    return { outcome: { ...notConfiguredBucket(), attempted: true, loginRequired: true }, credentialUpdate };
  }
  if (!response.ok) {
    return { outcome: { ...notConfiguredBucket(), attempted: true, fetchFailed: true }, credentialUpdate };
  }

  const payload = await response.json().catch(() => null);
  return {
    outcome: { ...notConfiguredBucket(), attempted: true, windows: parseCodexWindows(payload, input.now) },
    credentialUpdate,
  };
}

// 订阅桶结果形态（Task 4 填充真实链路；notFound=true 表示 404/空 → 免费档，不降级）
export type ChatgptSubscriptionOutcome = {
  attempted: boolean;
  plan: string | null;
  planRenewAt: string | null;
  notFound: boolean;
};

function notConfiguredSubscription(): ChatgptSubscriptionOutcome {
  return { attempted: false, plan: null, planRenewAt: null, notFound: false };
}

function withCredentialUpdate(
  result: ProviderFetchResult,
  credentialUpdate: Record<string, string> | null,
): ProviderFetchResult {
  if (!credentialUpdate) return result;
  return { ...result, credentialUpdate };
}

// 三桶状态合并（spec §5 状态机，纯函数）：
// 任一桶有数据即不为 error；codex/web 至少一桶有窗口且无降级 → ready；
// 有数据但 CF 质询或订阅获取失败（免费档 notFound 不算失败）→ partial；
// 无任何凭据、或 OAuth 刷新失败且 session 失效 → login_required；三链路全失败 → error
export function mergeChatgptBuckets(input: {
  codex: ChatgptBucketOutcome;
  web: ChatgptBucketOutcome;
  subscription: ChatgptSubscriptionOutcome;
  hasCodexCredentials: boolean;
  hasSessionToken: boolean;
  capturedAt: string;
  sourceUrl: string;
  credentialUpdate: Record<string, string> | null;
}): ProviderFetchResult {
  const windows = [...input.codex.windows, ...input.web.windows];
  const metrics: Record<string, number | string | boolean | null> = {
    hasCodexCredentials: input.hasCodexCredentials,
    hasSessionToken: input.hasSessionToken,
    codexTokenRefreshed: input.credentialUpdate !== null,
    webFetchMethod: input.web.windows.length > 0 ? "direct" : "snapshot_fallback",
    plan: input.subscription.plan ?? "unknown",
    planRenewAt: input.subscription.planRenewAt,
  };

  const base = {
    providerId: "chatgpt" as const,
    providerName: "ChatGPT",
    sourceUrl: input.sourceUrl,
    capturedAt: input.capturedAt,
    windows,
    metrics,
    meta: { entryUrl: input.sourceUrl },
  };

  const subscriptionHasData = input.subscription.attempted && input.subscription.plan !== null;
  const anyData = windows.length > 0 || subscriptionHasData;

  if (!anyData) {
    const noCredentials = !input.hasCodexCredentials && !input.hasSessionToken;
    const credentialsExhausted =
      (!input.hasCodexCredentials || (input.codex.attempted && input.codex.loginRequired)) &&
      (!input.hasSessionToken || (input.web.attempted && input.web.loginRequired));
    if (noCredentials || credentialsExhausted) {
      return withCredentialUpdate(
        createResult({
          ...base,
          status: "login_required",
          summary: noCredentials
            ? "ChatGPT 需要 Codex OAuth 凭据（accessToken + accountId）或网页 session cookie"
            : "ChatGPT 登录态已失效：Codex token 刷新失败且网页 session 无效，请重新运行 scripts/import-chatgpt-credentials.ts",
        }),
        input.credentialUpdate,
      );
    }
    return withCredentialUpdate(
      createResult({
        ...base,
        status: "error",
        summary: "ChatGPT 三链路本轮均未取到数据：Codex 与网页/订阅链路请求失败（含 Cloudflare 拦截）",
      }),
      input.credentialUpdate,
    );
  }

  const summaryParts: string[] = [];
  if (input.codex.windows.length > 0) summaryParts.push("Codex 窗口已获取");
  if (input.web.windows.length > 0) summaryParts.push("网页对话额度已获取");
  if (input.subscription.plan) summaryParts.push(`订阅档位 ${input.subscription.plan}`);

  const subscriptionFailed =
    input.subscription.attempted && input.subscription.plan === null && !input.subscription.notFound;
  const degraded = input.codex.cfChallenge || input.web.cfChallenge || subscriptionFailed;

  if (input.codex.cfChallenge || input.web.cfChallenge) {
    summaryParts.push("Cloudflare 拦截，请稍后重试或运行本地脚本（第二期）");
  }
  if (subscriptionFailed) {
    summaryParts.push("订阅信息获取失败");
  }
  if (input.subscription.plan === "free" && input.codex.windows.length === 0) {
    summaryParts.push("当前免费档，无 Codex 窗口数据");
  }

  const hasQuotaWindows = input.codex.windows.length > 0 || input.web.windows.length > 0;
  const status: ProviderStatus = hasQuotaWindows && !degraded ? "ready" : "partial";

  return withCredentialUpdate(
    createResult({ ...base, status, summary: summaryParts.join("；") }),
    input.credentialUpdate,
  );
}

export async function fetchChatgptSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = (input.config ?? {}) as ChatgptConfig;
  const hasCodexCredentials = Boolean(config.accessToken && config.accountId);
  const hasSessionToken = Boolean(config.sessionToken);

  if (!hasCodexCredentials && !hasSessionToken) {
    return mergeChatgptBuckets({
      codex: notConfiguredBucket(),
      web: notConfiguredBucket(),
      subscription: notConfiguredSubscription(),
      hasCodexCredentials: false,
      hasSessionToken: false,
      capturedAt: now,
      sourceUrl: defaultSourceUrl,
      credentialUpdate: null,
    });
  }

  const codexResult = hasCodexCredentials
    ? await fetchCodexWindows({
        config,
        now: input.now,
        fetchImpl,
        requestTimeoutMs: input.requestTimeoutMs,
      })
    : { outcome: notConfiguredBucket(), credentialUpdate: null };

  // 网页/订阅链路（Task 4 接入）：当前仅有 sessionToken 时按未配置桶处理
  const web = notConfiguredBucket();
  const subscription = notConfiguredSubscription();

  return mergeChatgptBuckets({
    codex: codexResult.outcome,
    web,
    subscription,
    hasCodexCredentials,
    hasSessionToken,
    capturedAt: now,
    sourceUrl: defaultSourceUrl,
    credentialUpdate: codexResult.credentialUpdate,
  });
}

export const chatgpt: ProviderDefinition = {
  id: "chatgpt",
  name: "ChatGPT",
  sourceUrl: defaultSourceUrl,
  description: "Codex 编码额度 / 网页对话额度 / 订阅状态",
  fetchSnapshot: fetchChatgptSnapshot,
};
```

- [ ] 运行 `npm run test:worker -- providers`，预期新增 6 个用例全部通过。
- [ ] 运行 `npm run test:worker`，预期全绿。
- [ ] 提交：

```bash
git add worker/providers/chatgpt.ts tests/worker/providers.test.ts
git commit -m "feat(worker): chatgpt provider 骨架与 Codex 链路——宽容解析/token 刷新/三桶合并"
```

---

## Task 4：网页对话与订阅链路（spec §9 测试组二）

接入 `fetchWebAccessToken`（session cookie → accessToken，两链路共用）、`fetchWebRateLimits`（兼容旧 `message_cap` 与新分组两种形态 → `web_5h_<slug>` 窗口，组名透传）、`fetchSubscription`（候选端点 `accounts/check`，404/空 → `plan:"free"`）。同时把 `fetchChatgptSnapshot` 的 web/subscription 桶从「未配置」换成真实链路。

**Files:**

- Modify: `worker/providers/chatgpt.ts`（在 `fetchChatgptSnapshot` 之前插入三个链路函数与解析器；`fetchChatgptSnapshot` 替换 web/subscription 段）
- Test: `tests/worker/providers.test.ts`（组一 describe 之后追加组二 describe）

**步骤：**

- [ ] 在 `tests/worker/providers.test.ts` 的 chatgpt 导入块中加入 `parseWebRateLimitWindows`，并在组一 describe 之后追加组二失败测试：

```ts
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
          headers: { "content-type": "application/json" } },
        );
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
```

- [ ] 运行 `npm run test:worker -- providers`，预期失败：导入块引用了尚不存在的 `parseWebRateLimitWindows`，vitest 报整个文件收集失败（`does not provide an export named 'parseWebRateLimitWindows'`）；即便仅注释掉该导入，其余组二用例也会因 session 链路未接入而 status/metrics 不符。
- [ ] 在 `worker/providers/chatgpt.ts` 中、`fetchChatgptSnapshot` 之前插入以下实现：

```ts
// 深度查找字符串键，兼容订阅端点响应结构漂移
function deepFindString(value: unknown, keyPattern: RegExp): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindString(item, keyPattern);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (keyPattern.test(key) && typeof entry === "string" && entry.length > 0) return entry;
      const found = deepFindString(entry, keyPattern);
      if (found) return found;
    }
  }
  return null;
}

// 订阅信息：plan 取 plan_type/plan 等键，续费时间取 renewal/current_period_end 等键
export function parseSubscriptionPayload(
  payload: unknown,
): { plan: string; planRenewAt: string | null } | null {
  const plan = deepFindString(payload, /^(plan_type|plantype|plan|subscription_plan)$/i);
  if (!plan) return null;
  const renewRaw = deepFindString(
    payload,
    /(next_renewal|renewal_date|plan_renewal|current_period_end|renews_at)/i,
  );
  let planRenewAt: string | null = null;
  if (renewRaw) {
    const date = new Date(renewRaw);
    planRenewAt = Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return { plan: plan.toLowerCase(), planRenewAt };
}

// 网页对话额度宽容解析：旧 message_cap 键值形态 + 新分组形态（数组或对象），组名透传不枚举（spec §2）
export function parseWebRateLimitWindows(payload: unknown, now: Date): ProviderWindow[] {
  const windows: ProviderWindow[] = [];
  const seenKeys = new Set<string>();

  const pushGroupWindow = (params: { slug: string; source: Record<string, unknown> }) => {
    const key = `web_5h_${params.slug}`;
    if (seenKeys.has(key)) return;
    let percentUsed = toPercentValue(
      pickNumber(params.source, [
        "used_percent",
        "used_pct",
        "percent_used",
        "percentUsed",
        "usage",
      ]),
    );
    if (percentUsed === null) {
      const used = pickNumber(params.source, ["used", "used_messages", "requests"]);
      const limit = pickNumber(params.source, ["max_cap", "limit", "total", "window_limit"]);
      if (used !== null && limit !== null && limit > 0) {
        percentUsed = Math.round((used / limit) * 1000) / 10;
      }
    }
    const resetAt = pickResetAt(params.source, now);
    if (percentUsed === null && resetAt === null) return;
    seenKeys.add(key);
    windows.push(
      buildPercentWindow({
        key,
        label: `对话 5小时·${params.slug}`,
        percentUsed,
        resetAt,
      }),
    );
  };

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      // 旧形态：<slug>_message_cap = { max_cap, remaining_cap, reset_at }
      if (key.endsWith("_message_cap") && value && typeof value === "object") {
        const source = value as Record<string, unknown>;
        const max = pickNumber(source, ["max_cap", "max", "limit"]);
        const remaining = pickNumber(source, ["remaining_cap", "remaining", "remaining_messages"]);
        if (max === null || max <= 0) continue;
        const used = remaining !== null ? Math.max(0, max - remaining) : null;
        const percentUsed = used !== null ? Math.round((used / max) * 1000) / 10 : null;
        const resetAt = pickResetAt(source, now);
        if (percentUsed === null && resetAt === null) continue;
        const slug = key.replace(/_message_cap$/, "") || "default";
        const windowKey = `web_5h_${slug}`;
        if (seenKeys.has(windowKey)) continue;
        seenKeys.add(windowKey);
        windows.push(
          buildPercentWindow({ key: windowKey, label: `对话 5小时·${slug}`, percentUsed, resetAt }),
        );
      }
    }
    if (windows.length > 0) return windows;

    // 新形态（对象分组）：值对象里带百分比/用量字段
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      pushGroupWindow({ slug: key.length > 0 ? key : "default", source: value as Record<string, unknown> });
    }
    return windows;
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (!item || typeof item !== "object") continue;
      const source = item as Record<string, unknown>;
      const slugRaw = source.slug ?? source.group ?? source.model_family ?? source.name;
      const slug = typeof slugRaw === "string" && slugRaw.length > 0 ? slugRaw : "default";
      pushGroupWindow({ slug, source });
    }
  }
  return windows;
}

// session cookie → accessToken（约 10 天有效）；网页与订阅两条链路共用（spec §2）
type WebSessionResult =
  | { kind: "ok"; accessToken: string }
  | { kind: "cf_challenge" }
  | { kind: "login_required" }
  | { kind: "failed" };

async function fetchWebAccessToken(input: {
  sessionToken: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<WebSessionResult> {
  if (!isTrustedChatgptUrl(webSessionUrl)) return { kind: "failed" };
  try {
    const response = await input.fetchImpl(webSessionUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: `__Secure-next-auth.session-token=${input.sessionToken}`,
        "User-Agent": webUserAgent,
      },
      signal: buildTimeoutSignal(input.requestTimeoutMs),
    });
    if (isCloudflareChallenge(response)) return { kind: "cf_challenge" };
    if (response.status === 401 || response.status === 403) return { kind: "login_required" };
    if (!response.ok) return { kind: "failed" };
    const payload = (await response.json().catch(() => null)) as { accessToken?: unknown } | null;
    // 200 但无 accessToken：视为登录态失效
    if (!payload || typeof payload.accessToken !== "string" || payload.accessToken.length === 0) {
      return { kind: "login_required" };
    }
    return { kind: "ok", accessToken: payload.accessToken };
  } catch {
    return { kind: "failed" };
  }
}

async function fetchWebRateLimits(input: {
  accessToken: string;
  now: Date;
  fetchImpl: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<ChatgptBucketOutcome> {
  if (!isTrustedChatgptUrl(webRateLimitsUrl)) {
    return { ...notConfiguredBucket(), fetchFailed: true };
  }
  try {
    const response = await input.fetchImpl(webRateLimitsUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.accessToken}`,
        "User-Agent": webUserAgent,
      },
      signal: buildTimeoutSignal(input.requestTimeoutMs),
    });
    if (isCloudflareChallenge(response)) {
      return { attempted: true, windows: [], loginRequired: false, cfChallenge: true, fetchFailed: false };
    }
    if (response.status === 401 || response.status === 403) {
      return { attempted: true, windows: [], loginRequired: true, cfChallenge: false, fetchFailed: false };
    }
    if (!response.ok) {
      return { attempted: true, windows: [], loginRequired: false, cfChallenge: false, fetchFailed: true };
    }
    const payload = await response.json().catch(() => null);
    return {
      attempted: true,
      windows: parseWebRateLimitWindows(payload, input.now),
      loginRequired: false,
      cfChallenge: false,
      fetchFailed: false,
    };
  } catch {
    return { attempted: true, windows: [], loginRequired: false, cfChallenge: false, fetchFailed: true };
  }
}

// 订阅链路：候选端点 accounts/check；404/无 plan 结构 → 免费档（正常数据不降级，spec §6）
async function fetchSubscription(input: {
  accessToken: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs?: number;
}): Promise<ChatgptSubscriptionOutcome> {
  if (!isTrustedChatgptUrl(subscriptionCheckUrl)) {
    return { attempted: false, plan: null, planRenewAt: null, notFound: false };
  }
  const failed: ChatgptSubscriptionOutcome = { attempted: true, plan: null, planRenewAt: null, notFound: false };
  try {
    const response = await input.fetchImpl(subscriptionCheckUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.accessToken}`,
        "User-Agent": webUserAgent,
      },
      signal: buildTimeoutSignal(input.requestTimeoutMs),
    });
    if (response.status === 404) {
      return { attempted: true, plan: "free", planRenewAt: null, notFound: true };
    }
    if (!response.ok) {
      return failed;
    }
    const payload = await response.json().catch(() => null);
    const parsed = parseSubscriptionPayload(payload);
    if (!parsed) {
      return { attempted: true, plan: "free", planRenewAt: null, notFound: true };
    }
    return { attempted: true, plan: parsed.plan, planRenewAt: parsed.planRenewAt, notFound: false };
  } catch {
    return failed;
  }
}
```

- [ ] 把 `fetchChatgptSnapshot` 中 web/subscription 段（Task 3 版本的 `const web = notConfiguredBucket(); const subscription = notConfiguredSubscription();` 两行及其注释）替换为：

```ts
  let web = notConfiguredBucket();
  let subscription = notConfiguredSubscription();
  if (hasSessionToken) {
    const session = await fetchWebAccessToken({
      sessionToken: config.sessionToken ?? "",
      fetchImpl,
      requestTimeoutMs: input.requestTimeoutMs,
    });
    if (session.kind === "ok") {
      web = await fetchWebRateLimits({
        accessToken: session.accessToken,
        now: input.now,
        fetchImpl,
        requestTimeoutMs: input.requestTimeoutMs,
      });
      subscription = await fetchSubscription({
        accessToken: session.accessToken,
        fetchImpl,
        requestTimeoutMs: input.requestTimeoutMs,
      });
    } else if (session.kind === "cf_challenge") {
      web = { attempted: true, windows: [], loginRequired: false, cfChallenge: true, fetchFailed: false };
      subscription = { attempted: true, plan: null, planRenewAt: null, notFound: false };
    } else if (session.kind === "login_required") {
      web = { attempted: true, windows: [], loginRequired: true, cfChallenge: false, fetchFailed: false };
      subscription = { attempted: true, plan: null, planRenewAt: null, notFound: false };
    } else {
      web = { attempted: true, windows: [], loginRequired: false, cfChallenge: false, fetchFailed: true };
      subscription = { attempted: true, plan: null, planRenewAt: null, notFound: false };
    }
  }
```

- [ ] 运行 `npm run test:worker -- providers`，预期组一 + 组二全部通过。
- [ ] 运行 `npm run test:worker`，预期全绿。
- [ ] 提交：

```bash
git add worker/providers/chatgpt.ts tests/worker/providers.test.ts
git commit -m "feat(worker): chatgpt 网页对话与订阅链路——session 换 token/双形态解析/404 视为免费档"
```

---

## Task 5：注册进 registry 并同步三处既有断言

注册后 chatgpt 出现在 `/api/providers`、看板与刷新流程。`tests/worker/index.test.ts` 的 createEnv 未配置 CHATGPT_*，provider 直接返回 login_required 且不发任何网络请求，usage stub 无需新增 chatgpt 分支。

**Files:**

- Modify: `worker/providers/registry.ts:1-20`
- Test: `tests/worker/providers.test.ts:14-41`（registry describe）
- Test: `tests/worker/index.test.ts:206-223`（provider 列表）、`:319-342`（usage 卡片数与 totals）、`:682-688`（refresh 卡片数）

**步骤：**

- [ ] 先改测试。`tests/worker/providers.test.ts:16-25` 期望数组加 `"chatgpt"`，`:33` 后加两行断言：

```ts
    expect(listProviders().map((provider) => provider.id)).toEqual([
      "openrouter",
      "opencode-go",
      "xfyun-maas",
      "aliyun-bailian",
      "volc-ark",
      "deepseek",
      "zhipu",
      "ollama",
      "chatgpt",
    ]);
```

```ts
    expect(getProvider("chatgpt")?.name).toBe("ChatGPT");
    expect(isProviderId("chatgpt")).toBe(true);
```

- [ ] `tests/worker/index.test.ts:213-222` 期望数组同样在 `"ollama"` 后加 `"chatgpt"`；`:330` 的 `toHaveLength(8)` 改为 `toHaveLength(9)`；`:333-338` totals 改为 `providers: 9`、`loginRequired: 5`（chatgpt 无凭据计入 login_required，ready 3 / partial 1 不变）；`:685` 的 `toHaveLength(8)` 改为 `toHaveLength(9)`。
- [ ] 运行 `npm run test:worker -- index`，预期 provider 列表 / usage / refresh 三处失败：`toEqual` 差异缺 `"chatgpt"`、`expected 9, received 8`。
- [ ] 修改 `worker/providers/registry.ts`：

```ts
import { openrouter } from "./openrouter";
import { opencodeGo } from "./opencode-go";
import { xfyunMaaS } from "./xfyun-maas";
import { aliyunBailian } from "./aliyun-bailian";
import { volcArk } from "./volc-ark";
import { deepseek } from "./deepseek";
import { zhipu } from "./zhipu";
import { ollama } from "./ollama";
import { chatgpt } from "./chatgpt";
import type { ProviderDefinition, ProviderId } from "../types";

const PROVIDERS: ProviderDefinition[] = [
  openrouter,
  opencodeGo,
  xfyunMaaS,
  aliyunBailian,
  volcArk,
  deepseek,
  zhipu,
  ollama,
  chatgpt,
];
```

- [ ] 运行 `npm run test:worker`，预期全部通过。
- [ ] 提交：

```bash
git add worker/providers/registry.ts tests/worker/providers.test.ts tests/worker/index.test.ts
git commit -m "feat(worker): 注册 chatgpt provider 并同步 provider 数量断言"
```

---

## Task 6：index.ts 集成——env 分支 / 15s 超时 / token 写回 / 桶级窗口补齐

四处改动：(1) `buildProviderConfig` 加 chatgpt 分支（env → config 合并，账号凭据经既有 `getProviderAccountConfigById` 解密 merge，零新增机制）；(2) 刷新链路给 chatgpt 设 `requestTimeoutMs = 15_000`（chatgpt.ts 是该字段的首个真实消费方）；(3) `fetchProviderSnapshot` 消费 `credentialUpdate` → `updateProviderAccountCredentials`，失败仅 `console.warn` 不阻塞快照；(4) `backfillPartialWindows`：持久化前用上一份 ready 快照补齐 partial 快照缺失的同 key 窗口并打 `meta.stale`（spec §6），三链路全失败仍走既有整卡回退。

说明：写回仅在带 accountId 的账号刷新链路（`collectUsageSnapshots` → `fetchProviderSnapshot`）生效；`GET /api/providers/:id/snapshot` 调试路径无账号上下文，不写回。CHATGPT_* 为可选 env secret，未配置时 provider 返回 login_required，不需要修改 `wrangler.toml`。

**Files:**

- Modify: `worker/index.ts:7`（import）、`:96-110`（buildProviderConfig 加分支）、`:259-309`（fetchProviderSnapshot）、`:387-417`（applyLatestReadyFallback 加可选参数）、`:553-575`（handleProviderSnapshot 超时行）、`:602-639`（handleDashboardRefresh）、`:641-729`（handleRefresh）
- Test: `tests/worker/index.test.ts`（末尾追加两个用例）

**步骤：**

- [ ] 在 `tests/worker/index.test.ts` 顶部导入区，把 `import { handleApiRequest } from "../../worker/index";` 替换为：

```ts
import { backfillPartialWindows, handleApiRequest } from "../../worker/index";
```

并把 credentials 导入改为：

```ts
import { decryptCredentialPayload, encryptCredentialPayload } from "../../worker/security/credentials";
```

- [ ] 在文件末尾追加两个失败测试：

```ts
describe("chatgpt 集成", () => {
  const encryptionKey = "0123456789abcdef0123456789abcdef";

  it("backfillPartialWindows 补齐 partial 快照缺失窗口并标记 stale，非 chatgpt/非 partial 不动", () => {
    const previous: ProviderSnapshot = {
      providerId: "chatgpt",
      providerName: "ChatGPT",
      sourceUrl: "https://chatgpt.com",
      status: "ready",
      capturedAt: "2026-10-13T00:00:00.000Z",
      summary: "ready",
      windows: [
        { key: "codex_5h", label: "Codex 5小时", used: 20, limit: 100, percentUsed: 20 },
        { key: "web_5h_default", label: "对话 5小时·default", used: 30, limit: 100, percentUsed: 30 },
      ],
      metrics: {},
      meta: {},
    };
    const chatgptPartial: ProviderSnapshot = {
      ...previous,
      status: "partial",
      capturedAt: "2026-10-14T00:00:00.000Z",
      windows: [{ key: "codex_5h", label: "Codex 5小时", used: 40, limit: 100, percentUsed: 40 }],
      summary: "partial",
    };
    const zhipuPartial: ProviderSnapshot = {
      providerId: "zhipu",
      providerName: "智谱 BigModel",
      sourceUrl: "https://bigmodel.cn/coding-plan/personal/usage",
      status: "partial",
      capturedAt: "2026-10-14T00:00:00.000Z",
      summary: "partial",
      windows: [],
      metrics: {},
      meta: {},
    };

    const result = backfillPartialWindows(
      [chatgptPartial, zhipuPartial],
      new Map([["https://chatgpt.com", previous]]),
    );

    expect(result[0]?.windows).toHaveLength(2);
    expect(result[0]?.windows[1]).toMatchObject({ key: "web_5h_default", meta: { stale: true } });
    expect(result[0]?.meta.staleWindowKeys).toEqual(["web_5h_default"]);
    expect(result[1]).toBe(zhipuPartial);
  });

  it("refresh 刷新 chatgpt 时把轮换后的 token 写回 Supabase", async () => {
    const encrypted = await encryptCredentialPayload(
      { accessToken: "fake-access-token-1", refreshToken: "fake-refresh-token-1", accountId: "fake-account-1" },
      encryptionKey,
    );
    const writes: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    let rateLimitsCalls = 0;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      const method = init?.method ?? "GET";
      if (init?.body) {
        writes.push({ url, method, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      }

      if (url.startsWith("https://supabase.test/rest/v1/provider_preferences")) {
        return new Response(
          JSON.stringify([{ provider_key: "chatgpt", enabled: true, display_order: 1, active_provider_account_id: null }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith("https://supabase.test/rest/v1/provider_accounts") && method === "GET") {
        if (url.includes("id=eq.acc-1")) {
          return new Response(
            JSON.stringify([{ provider_key: "chatgpt", config: {}, source_url: "https://chatgpt.com" }]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify([
            { id: "acc-1", provider_key: "chatgpt", account_label: "默认账号", homepage_enabled: true, homepage_order: 100 },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith("https://supabase.test/rest/v1/provider_account_credentials") && method === "GET") {
        return new Response(
          JSON.stringify([{ encrypted_payload: encrypted.encryptedPayload, nonce: encrypted.nonce, key_version: "v1" }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith("https://supabase.test/rest/v1/usage_snapshots") && method === "GET") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("https://supabase.test/")) {
        return new Response("{}", { status: 201 });
      }
      if (url === "https://auth.openai.com/oauth/token") {
        return new Response(
          JSON.stringify({ access_token: "fake-access-token-2", refresh_token: "fake-refresh-token-2" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://chatgpt.com/backend-api/codex/rate_limits") {
        rateLimitsCalls += 1;
        if (rateLimitsCalls === 1) return new Response("{}", { status: 401 });
        return new Response(
          JSON.stringify({ rate_limits: { codex_5h: { used_percent: 15 } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected ${url}`);
    });

    vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
    try {
      const env = {
        ...createEnv(fetchImpl as typeof fetch),
        SUPABASE_URL: "https://supabase.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
        SUPABASE_USER_ID: "user-1",
        CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
      };
      const response = await handleApiRequest(
        new Request("https://api.monitor.local/api/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerId: "chatgpt" }),
        }),
        env,
      );
      const payload = (await response.json()) as {
        ok: boolean;
        data: { cards: Array<{ providerId: string; status: string; metrics: Record<string, unknown> }> };
      };

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      const card = payload.data.cards[0];
      expect(card).toMatchObject({ providerId: "chatgpt", status: "ready" });
      expect(card?.metrics.codexTokenRefreshed).toBe(true);

      // 写回通道：加密覆盖 provider_account_credentials
      const credWrite = writes.find(
        (write) =>
          write.url.startsWith("https://supabase.test/rest/v1/provider_account_credentials") &&
          write.method === "POST",
      );
      expect(credWrite).toBeDefined();
      expect(credWrite?.body).toMatchObject({ user_id: "user-1", provider_account_id: "acc-1" });
      expect(JSON.stringify(credWrite?.body)).not.toContain("fake-access-token-2");
      const decryptedUpdate = await decryptCredentialPayload(
        {
          encryptedPayload: String(credWrite?.body?.encrypted_payload),
          nonce: String(credWrite?.body?.nonce),
          keyVersion: "v1",
        },
        encryptionKey,
      );
      expect(decryptedUpdate).toEqual({
        accessToken: "fake-access-token-2",
        refreshToken: "fake-refresh-token-2",
      });

      // hint 脱敏同步
      const hintPatch = writes.find(
        (write) => write.method === "PATCH" && write.url.startsWith("https://supabase.test/rest/v1/provider_accounts"),
      );
      expect(hintPatch?.body?.credential_hint).toEqual({
        accessToken: "fake-...en-2",
        refreshToken: "fake-...en-2",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
```

- [ ] 运行 `npm run test:worker -- index`，预期失败：测试文件导入了尚不存在的 `backfillPartialWindows`，vitest 报整个文件收集失败（`does not provide an export named 'backfillPartialWindows'`）。若先临时移除该导入单独跑刷新用例，失败点为 `expect(credWrite).toBeDefined()`——provider 自身已完成 token 刷新（Task 3），但写回通道未接线，Supabase mock 收不到凭据 POST。
- [ ] 修改 `worker/index.ts:7` 导入行：

```ts
import {
  getActiveProviderAccountConfig,
  getProviderAccountConfigById,
  listProviderSettings,
  updateProviderAccountCredentials,
} from "./settings/repository";
```

- [ ] 在 `buildProviderConfig` 的 ollama 分支（:96-103）之后、xfyun 兜底 return 之前插入：

```ts
  if (providerId === "chatgpt") {
    return {
      accessToken: env.CHATGPT_ACCESS_TOKEN,
      refreshToken: env.CHATGPT_REFRESH_TOKEN,
      accountId: env.CHATGPT_ACCOUNT_ID,
      sessionToken: env.CHATGPT_SESSION_TOKEN,
    };
  }
```

- [ ] 替换 `fetchProviderSnapshot`（:259-309）为：

```ts
async function fetchProviderSnapshot(
  env: WorkerEnv,
  providerId: string,
  configOverride?: Record<string, unknown>,
  account?: { accountId?: string; accountLabel?: string },
): Promise<ProviderSnapshot> {
  const provider = getProvider(providerId);
  if (!provider) {
    return createErrorSnapshot(providerId, providerId, "", new Date(), `Unknown provider: ${providerId}`);
  }

  const now = new Date();
  const fetchInput: ProviderFetchInput = {
    now,
    fetchImpl: fetch,
    config: configOverride ?? buildProviderConfig(env, providerId),
  };
  if (providerId === "opencode-go" || providerId === "chatgpt") {
    fetchInput.requestTimeoutMs = 15_000;
    if (providerId === "opencode-go") {
      fetchInput.browser = env.OPENCODE_BROWSER;
    }
  }

  try {
    const result = await provider.fetchSnapshot(fetchInput);
    // chatgpt token 轮换写回：失败仅 warning，不阻塞快照（spec §4）
    if (
      result.credentialUpdate &&
      account?.accountId &&
      env.SUPABASE_URL &&
      env.SUPABASE_SERVICE_ROLE_KEY &&
      env.SUPABASE_USER_ID
    ) {
      try {
        await updateProviderAccountCredentials(
          env,
          env.SUPABASE_USER_ID,
          account.accountId,
          result.credentialUpdate,
          fetch,
        );
      } catch (error) {
        console.warn(
          `[chatgpt] token 写回失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!account?.accountId) {
      return result.snapshot;
    }
    return {
      ...result.snapshot,
      meta: {
        ...result.snapshot.meta,
        accountId: account.accountId,
        accountLabel: account.accountLabel ?? "默认账号",
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown provider error";
    const snapshot = createErrorSnapshot(provider.id, provider.name, provider.sourceUrl, now, message);
    if (!account?.accountId) {
      return snapshot;
    }
    return {
      ...snapshot,
      meta: {
        ...snapshot.meta,
        accountId: account.accountId,
        accountLabel: account.accountLabel ?? "默认账号",
      },
    };
  }
}
```

- [ ] `applyLatestReadyFallback`（:387-417）签名加第四个可选参数并复用（避免与桶级补齐重复查询）：

```ts
async function applyLatestReadyFallback(
  env: WorkerEnv,
  userId: string | null,
  snapshots: ProviderSnapshot[],
  latestReadySnapshots?: Map<string, ProviderSnapshot>,
): Promise<ProviderSnapshot[]> {
  if (snapshots.every((snapshot) => snapshot.status === "ready" && snapshot.windows.length > 0)) {
    return snapshots;
  }

  const fallbacks = latestReadySnapshots ?? (await fetchLatestReadySnapshots(env, userId));
  if (fallbacks.size === 0) {
    return snapshots;
  }

  return snapshots.map((snapshot) => {
    // 与 fetchLatestReadySnapshots 的 key 口径一致:有 accountId 按账号,否则按 source_url
    const accountId = typeof snapshot.meta?.accountId === "string" ? snapshot.meta.accountId : null;
    const fallback = fallbacks.get(accountId ?? "") ?? fallbacks.get(snapshot.sourceUrl);
    if (!fallback) return snapshot;
    if (snapshot.status === "ready" && snapshot.windows.length > 0) return snapshot;
    return {
      ...fallback,
      summary: withFallbackSummary(fallback.summary),
      meta: {
        ...fallback.meta,
        accountId: snapshot.meta?.accountId ?? fallback.meta?.accountId,
        accountLabel: snapshot.meta?.accountLabel ?? fallback.meta?.accountLabel,
        fallbackFrom: snapshot.summary,
        isFallback: true,
        liveStatus: snapshot.status,
        liveSummary: snapshot.summary,
      },
    };
  });
}
```

- [ ] 在 `persistSnapshot`（:419）之前插入桶级补齐函数（导出供测试）：

```ts
// chatgpt 桶级窗口补齐（spec §6）：partial 快照缺失的窗口用上一份 ready 快照补回，
// 补齐窗口打 meta.stale=true；三链路全失败（error）仍由 applyLatestReadyFallback 整卡回退
export function backfillPartialWindows(
  snapshots: ProviderSnapshot[],
  latestReadySnapshots: Map<string, ProviderSnapshot>,
): ProviderSnapshot[] {
  return snapshots.map((snapshot) => {
    if (snapshot.providerId !== "chatgpt" || snapshot.status !== "partial") return snapshot;
    const accountId = typeof snapshot.meta?.accountId === "string" ? snapshot.meta.accountId : null;
    const previous =
      latestReadySnapshots.get(accountId ?? "") ?? latestReadySnapshots.get(snapshot.sourceUrl);
    if (!previous || previous.windows.length === 0) return snapshot;
    const existingKeys = new Set(snapshot.windows.map((window) => window.key));
    const missing = previous.windows.filter((window) => !existingKeys.has(window.key));
    if (missing.length === 0) return snapshot;
    return {
      ...snapshot,
      windows: [
        ...snapshot.windows,
        ...missing.map((window) => ({ ...window, meta: { ...(window.meta ?? {}), stale: true } })),
      ],
      meta: {
        ...snapshot.meta,
        staleWindowKeys: missing.map((window) => window.key),
      },
    };
  });
}
```

- [ ] `handleProviderSnapshot`（:565-567）超时条件改为：

```ts
  if (providerId === "opencode-go" || providerId === "chatgpt") {
    fetchInput.requestTimeoutMs = 15_000;
  }
```

- [ ] `handleDashboardRefresh`（:602-639）中，把

```ts
  const liveSnapshots = await collectUsageSnapshots(env, userId);
  const displaySnapshots = await applyLatestReadyFallback(env, userId, liveSnapshots);

  if (shouldPersist && decision?.allowed) {
    for (const snapshot of liveSnapshots) {
      await persistSnapshot(env, userId, snapshot, decision);
    }
  }
```

替换为：

```ts
  const liveSnapshots = await collectUsageSnapshots(env, userId);
  const latestReadySnapshots = await fetchLatestReadySnapshots(env, userId);
  const backfilledSnapshots = backfillPartialWindows(liveSnapshots, latestReadySnapshots);
  const displaySnapshots = await applyLatestReadyFallback(env, userId, backfilledSnapshots, latestReadySnapshots);

  if (shouldPersist && decision?.allowed) {
    for (const snapshot of backfilledSnapshots) {
      await persistSnapshot(env, userId, snapshot, decision);
    }
  }
```

- [ ] `handleRefresh`（:641-729）中，把

```ts
  const snapshots = await collectUsageSnapshots(env, userId, body.providerId);
  const hasAccountSnapshots = snapshots.some((snapshot) => typeof snapshot.meta.accountId === "string");

  if (hasAccountSnapshots) {
    if (body.persist !== false) {
      for (const snapshot of snapshots) {
        await persistSnapshot(env, userId, snapshot, decision);
      }
    }

    const dashboard = buildUsageDashboard(snapshots, {
```

替换为：

```ts
  const snapshots = await collectUsageSnapshots(env, userId, body.providerId);
  const latestReadySnapshots = await fetchLatestReadySnapshots(env, userId);
  const backfilledSnapshots = backfillPartialWindows(snapshots, latestReadySnapshots);
  const hasAccountSnapshots = backfilledSnapshots.some(
    (snapshot) => typeof snapshot.meta.accountId === "string",
  );

  if (hasAccountSnapshots) {
    if (body.persist !== false) {
      for (const snapshot of backfilledSnapshots) {
        await persistSnapshot(env, userId, snapshot, decision);
      }
    }

    const dashboard = buildUsageDashboard(backfilledSnapshots, {
```

- [ ] 运行 `npm run test:worker -- index`，预期两个新用例通过。
- [ ] 运行 `npm run test:worker`，预期全绿。
- [ ] 提交：

```bash
git add worker/index.ts tests/worker/index.test.ts
git commit -m "feat(worker): index 集成 chatgpt——env 分支/15s 超时/token 写回/桶级窗口补齐"
```

---

## Task 7：前端四处（catalog / 凭据表单 / client 映射与兜底）

spec §7.1/§7.2 全部要点：accent `#10a37f`、tagline「Codex / 对话额度 / 订阅状态」、primaryMetricLabel「Codex 5小时」、四字段密码输入、resetAt 缺失显示「滚动窗口」、planRenewAt null 显示「订阅前无数据」、补齐窗口（meta.stale）label 加「（历史）」后缀、明细指标区四项。对话模型组直接复用 QuotaWindowList 通用渲染，不改 platform-card。

**Files:**

- Modify: `frontend/src/settings/provider-catalog.ts:46-51`（ollama 条目后追加）
- Modify: `frontend/src/settings/credential-form.tsx:16-25`（credentialFields）、`:27-37`（fieldLabel）、`:100`（input type 判定）
- Modify: `frontend/src/api/client.ts:170-179`（ServerProviderWindow 加 meta）、`:348-357`（resolveAccent）、`:359-368`（resolveTagline）、`:370-379`（resolvePrimaryMetricLabel）、`:393-397`（formatOllamaResetAt 条件）、`:414-424`（toQuotaWindow）、`:485-498`（buildDetailMetrics chatgpt 分支）
- Test: `tests/frontend/credentialForm.test.tsx`（追加用例）
- Test: `tests/frontend/apiClient.test.ts`（追加用例）

**步骤：**

- [ ] 在 `tests/frontend/credentialForm.test.tsx` 末尾追加失败测试：

```ts
  it("shows four chatgpt credential fields as password inputs", async () => {
    const onSave = vi.fn(async () => undefined);
    render(
      <CredentialForm
        provider={{
          providerKey: "chatgpt",
          providerName: "ChatGPT",
          sourceUrl: "https://chatgpt.com",
          description: "Codex / 对话额度 / 订阅状态",
        }}
        onSave={onSave}
      />,
    );

    for (const field of ["accessToken", "refreshToken", "accountId", "sessionToken"]) {
      const input = screen.getByLabelText(field) as HTMLInputElement;
      expect(input.type).toBe("password");
    }

    fireEvent.change(screen.getByLabelText("accessToken"), { target: { value: "fake-access-token-1" } });
    fireEvent.change(screen.getByLabelText("accountId"), { target: { value: "fake-account-1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存账号" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          providerKey: "chatgpt",
          credentials: { accessToken: "fake-access-token-1", accountId: "fake-account-1" },
        }),
      ),
    );
  });
```

- [ ] 在 `tests/frontend/apiClient.test.ts` 的 describe 内追加失败测试：

```ts
  it("maps the chatgpt card with plan metrics and per-provider fallbacks", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            kind: "usage_dashboard",
            generatedAt: "2026-10-14T00:00:00.000Z",
            status: "ready",
            summary: "ready",
            totals: { providers: 1, ready: 1, partial: 0, loginRequired: 0, error: 0 },
            cards: [
              {
                providerId: "chatgpt",
                providerName: "ChatGPT",
                sourceUrl: "https://chatgpt.com",
                status: "ready",
                summary: "Codex 窗口已获取；订阅档位 plus",
                capturedAt: "2026-10-14T00:00:00.000Z",
                trend: [],
                windows: [
                  {
                    key: "codex_5h",
                    label: "Codex 5小时",
                    used: 40,
                    limit: 100,
                    percentUsed: 40,
                    resetAt: null,
                  },
                  {
                    key: "web_5h_default",
                    label: "对话 5小时·default",
                    used: 30,
                    limit: 100,
                    percentUsed: 30,
                    resetAt: "2026-10-14T03:00:00.000Z",
                    meta: { stale: true },
                  },
                ],
                metrics: {
                  plan: "plus",
                  planRenewAt: null,
                  codexTokenRefreshed: true,
                  webFetchMethod: "direct",
                },
                meta: {},
              },
            ],
            modelSpends: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const dashboard = await createApiClient({ fetcher: fetcher as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    expect(platform.accent).toBe("#10a37f");
    expect(platform.tagline).toBe("Codex / 对话额度 / 订阅状态");
    expect(platform.primaryMetricLabel).toBe("Codex 5小时");
    // resetAt 缺失 → 滚动窗口；补齐窗口 label 加（历史）后缀
    expect(platform.quotaWindows[0]?.resetAt).toBe("滚动窗口");
    expect(platform.quotaWindows[1]?.label).toBe("对话 5小时·default（历史）");
    expect(platform.detailMetrics).toEqual([
      { label: "订阅档位", value: "plus" },
      { label: "续费日期", value: "订阅前无数据" },
      { label: "Token 刷新", value: "本轮已刷新" },
      { label: "抓取方式", value: "云端直连" },
    ]);
  });
```

- [ ] 运行 `npm run test:frontend -- credentialForm apiClient`，预期两个新用例失败（`Unable to find a label` / `accent` 不匹配）。
- [ ] 修改 `frontend/src/settings/provider-catalog.ts`，在 ollama 条目（:47-51）后追加：

```ts
  {
    providerKey: "chatgpt",
    providerName: "ChatGPT",
    sourceUrl: "https://chatgpt.com",
    description: "Codex / 对话额度 / 订阅状态",
  },
```

- [ ] 修改 `frontend/src/settings/credential-form.tsx:16-25`，在 ollama 分支后加：

```ts
  if (providerKey === "chatgpt") return ["accessToken", "refreshToken", "accountId", "sessionToken"];
```

`:27-37` 的 labels 补四项：

```ts
    accessToken: "Access Token",
    refreshToken: "Refresh Token",
    accountId: "账号 ID（chatgpt-account-id）",
    sessionToken: "网页 Session Token",
```

`:100` 的 input type 判定加 token（四字段全部密码化，spec §7.2）：

```ts
            type={
              field.toLowerCase().includes("cookie") ||
              field.toLowerCase().includes("key") ||
              field.toLowerCase().includes("token")
                ? "password"
                : "text"
            }
```

- [ ] 修改 `frontend/src/api/client.ts`：

`:170-179` ServerProviderWindow 末尾加 meta：

```ts
type ServerProviderWindow = {
  key: string;
  label: string;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  percentUsed?: number | null;
  percentRemaining?: number | null;
  resetAt?: string | null;
  meta?: Record<string, unknown>;
};
```

`:348-357` resolveAccent 加分支（放在 ollama 之前均可）：

```ts
  if (providerId === "chatgpt") return "#10a37f";
```

`:359-368` resolveTagline 加分支：

```ts
  if (providerId === "chatgpt") return "Codex / 对话额度 / 订阅状态";
```

`:370-379` resolvePrimaryMetricLabel 加分支：

```ts
  if (providerId === "chatgpt") return "Codex 5小时";
```

`:393-397` formatOllamaResetAt 的判断改为 ollama 与 chatgpt 共用「滚动窗口」兜底：

```ts
// Ollama/ChatGPT 无重置时间字段，显示"滚动窗口"；其他 provider 走既有逻辑
function formatOllamaResetAt(providerId: string, value: string | null | undefined): string {
  if (providerId !== "ollama" && providerId !== "chatgpt") return formatResetAt(value);
  return value ? formatResetAt(value) : "滚动窗口";
}
```

在 `formatResetAt` 之后新增续费兜底函数：

```ts
// 续费日期 null（免费档/未知档位）显示"订阅前无数据"（spec §7.2）
function formatChatgptPlanRenewAt(value: unknown): string {
  if (typeof value !== "string" || !value) return "订阅前无数据";
  return formatResetAt(value);
}
```

`:414-424` toQuotaWindow 处理补齐窗口的 stale 标记：

```ts
function toQuotaWindow(providerId: string, status: PlatformStatus, window: ServerProviderWindow): QuotaWindow {
  const stale = window.meta?.stale === true;
  return {
    label: stale ? `${window.label}（历史）` : window.label,
    scope: window.label,
    used: window.used ?? 0,
    limit: window.limit ?? 0,
    percentUsed: window.percentUsed ?? null,
    resetAt: formatOllamaResetAt(providerId, window.resetAt),
    status,
  };
}
```

`:485-498` buildDetailMetrics 在 ollama 分支结束（`return items;`）之后、`if (providerId !== "zhipu") return [];` 之前插入 chatgpt 分支：

```ts
  if (providerId === "chatgpt") {
    items.push({
      label: "订阅档位",
      value: typeof metrics.plan === "string" && metrics.plan ? metrics.plan : "未知",
    });
    items.push({ label: "续费日期", value: formatChatgptPlanRenewAt(metrics.planRenewAt) });
    items.push({ label: "Token 刷新", value: metrics.codexTokenRefreshed === true ? "本轮已刷新" : "未刷新" });
    items.push({
      label: "抓取方式",
      value: metrics.webFetchMethod === "snapshot_fallback" ? "快照回退" : "云端直连",
    });
    return items;
  }
```

- [ ] 运行 `npm run test:frontend`，预期全部通过。
- [ ] 运行 `npm run test`，预期全绿。
- [ ] 提交：

```bash
git add frontend/src/settings/provider-catalog.ts frontend/src/settings/credential-form.tsx frontend/src/api/client.ts tests/frontend/credentialForm.test.tsx tests/frontend/apiClient.test.ts
git commit -m "feat(frontend): chatgpt 卡片与凭据表单——OpenAI 绿/四字段/三桶窗口/订阅兜底"
```

---

## Task 8：一次性端点探测脚本（需用户真实环境执行）

实现期确认 spec §2 标注的未验证端点结构。脚本只读 `~/.codex/auth.json`（或 `--auth-json` / `CODEX_AUTH_JSON` 指定路径），输出脱敏结构骨架（字符串只留首尾片段与长度），不含完整 token。token 刷新端点会轮换 refresh token，仅在显式传 `--refresh` 时探测；网页/订阅端点仅在提供 `CHATGPT_SESSION_TOKEN` 环境变量时探测。

**Files:**

- Create: `scripts/probe-chatgpt-endpoints.ts`
- Test: 无自动测试（一次性人工工具，不进 vitest；依赖真实账号）

**步骤：**

- [ ] 创建 `scripts/probe-chatgpt-endpoints.ts`：

```ts
/**
 * ChatGPT 端点一次性探测脚本（需用户真实环境执行）
 *
 * 用 ~/.codex/auth.json 的 token 探测 codex rate_limits / token 刷新 / 网页/订阅端点的
 * 响应结构，输出脱敏结构骨架（不含任何完整 token），供 chatgpt provider 解析器核对。
 *
 * 使用：
 *   node --experimental-strip-types scripts/probe-chatgpt-endpoints.ts
 *   node --experimental-strip-types scripts/probe-chatgpt-endpoints.ts --refresh          # 额外探测刷新端点（会轮换 token）
 *   CHATGPT_SESSION_TOKEN=xxx node --experimental-strip-types scripts/probe-chatgpt-endpoints.ts  # 额外探测网页/订阅端点
 *   CODEX_AUTH_JSON=D:\path\auth.json node --experimental-strip-types scripts/probe-chatgpt-endpoints.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const CODEX_RATE_LIMITS_URL = "https://chatgpt.com/backend-api/codex/rate_limits";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const WEB_SESSION_URL = "https://chatgpt.com/api/auth/session";
const WEB_RATE_LIMITS_URL = "https://chatgpt.com/backend-api/rate_limits";
const SUBSCRIPTION_CHECK_URL = "https://chatgpt.com/backend-api/accounts/check";
// codex CLI 公开 client_id；与 worker/providers/chatgpt.ts 的 defaultCodexClientId 保持一致
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

type CodexAuthJson = {
  tokens?: { access_token?: string; refresh_token?: string; account_id?: string };
  account_id?: string;
};

function loadAuthJson(): { accessToken: string; refreshToken: string | null; accountId: string | null } | null {
  const path = process.env.CODEX_AUTH_JSON
    ? resolve(process.env.CODEX_AUTH_JSON)
    : resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".codex/auth.json");
  if (!existsSync(path)) return null;
  let raw: CodexAuthJson;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as CodexAuthJson;
  } catch {
    return null;
  }
  const accessToken = raw.tokens?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  return {
    accessToken,
    refreshToken: typeof raw.tokens?.refresh_token === "string" ? raw.tokens.refresh_token : null,
    accountId:
      typeof raw.tokens?.account_id === "string"
        ? raw.tokens.account_id
        : typeof raw.account_id === "string"
          ? raw.account_id
          : null,
  };
}

// 脱敏：长字符串只留首尾片段与长度；数组只看前两项
function maskValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= 8) return "***";
    return `${value.slice(0, 4)}...${value.slice(-3)} (${value.length} chars)`;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, 2).map(maskValue);
    return value.length > 2 ? [...head, `(${value.length} items)`] : head;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, maskValue(entry)]));
  }
  return value;
}

async function probe(name: string, url: string, init: RequestInit): Promise<void> {
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    let body: unknown = text.slice(0, 2000);
    try {
      body = maskValue(JSON.parse(text));
    } catch {
      // 非 JSON 原样截断展示
    }
    console.log(`\n=== ${name} → HTTP ${response.status} (cf-mitigated: ${response.headers.get("cf-mitigated") ?? "(none)"}) ===`);
    console.log(JSON.stringify(body, null, 2));
  } catch (error) {
    console.log(`\n=== ${name} → 请求失败: ${error instanceof Error ? error.message : String(error)} ===`);
  }
}

async function main(): Promise<void> {
  const auth = loadAuthJson();
  if (!auth) {
    console.error("[FAIL] 未找到 ~/.codex/auth.json 或缺少 tokens.access_token（请先在 Codex CLI 登录）");
    process.exit(1);
  }
  console.log(`[OK] auth.json 已读取（account_id: ${auth.accountId ?? "(missing)"}）`);

  await probe("codex rate_limits (Bearer + chatgpt-account-id)", CODEX_RATE_LIMITS_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${auth.accessToken}`,
      ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
    },
  });

  if (process.argv.includes("--refresh") && auth.refreshToken) {
    await probe("token refresh（响应含新 token，已脱敏）", CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken,
      }),
    });
  } else {
    console.log("\n[SKIP] 未传 --refresh 或无 refresh token，跳过刷新端点探测（避免轮换）");
  }

  const sessionToken = process.env.CHATGPT_SESSION_TOKEN;
  if (sessionToken) {
    const session = await fetch(WEB_SESSION_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: `__Secure-next-auth.session-token=${sessionToken}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    const sessionPayload = (await session.json().catch(() => null)) as { accessToken?: string } | null;
    console.log(`\n=== web session → HTTP ${session.status}，accessToken: ${sessionPayload?.accessToken ? "已获取" : "未获取"} ===`);
    if (sessionPayload?.accessToken) {
      await probe("web rate_limits (Bearer accessToken)", WEB_RATE_LIMITS_URL, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${sessionPayload.accessToken}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
      });
      await probe("subscription accounts/check (Bearer accessToken)", SUBSCRIPTION_CHECK_URL, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${sessionPayload.accessToken}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
      });
    }
  } else {
    console.log("[SKIP] 未设置 CHATGPT_SESSION_TOKEN，跳过网页/订阅端点探测");
  }

  console.log("\n[DONE] 请把上方结构骨架与 worker/providers/chatgpt.ts 的解析键核对；");
  console.log("      不符时修正解析器键名/常量并同步更新 tests/worker/providers.test.ts 对应断言。");
}

main().catch((err) => {
  console.error("[FAIL] 脚本执行失败:", err);
  process.exit(1);
});
```

- [ ] 运行 `npx tsc --noEmit`，预期 0 错误。
- [ ] 提交：

```bash
git add scripts/probe-chatgpt-endpoints.ts
git commit -m "chore(scripts): 新增 chatgpt 端点一次性探测脚本（脱敏输出）"
```

- [ ] **需用户真实环境执行**：`node --experimental-strip-types scripts/probe-chatgpt-endpoints.ts`，把输出与 `worker/providers/chatgpt.ts` 的解析键核对；若 `codex rate_limits` 实际结构或刷新 client_id 与常量不符，修正 `parseCodexWindows` 键名 / `defaultCodexClientId`，并同步更新 Task 3 中「refreshes the codex token」测试的 client_id 断言后重跑 `npm run test:worker -- providers`。

---

## Task 9：凭据导入脚本（需用户真实环境执行）

照 `scripts/refresh-ollama-cookie.ts` 骨架：读 `~/.codex/auth.json` 提取 token 三元组 → Playwright 复用 `output/chatgpt-browser-profile`（已 gitignore）提取 `__Secure-next-auth.session-token`（未登录等人工 Google 登录，不自动化）→ 试调 codex rate_limits 校验 → AES-GCM 加密 → Supabase REST 按 `provider_key=chatgpt` + `account_label=默认账号` upsert。`--check` 干跑只读不写。范围决策（spec §8 中「可选」项）：`.env` CHATGPT_* 与 Worker secret 同步不纳入第一期——账号凭据通道已满足 Worker 取数，需要时照 ollama 脚本的 `updateEnvKeys` / `updateWorkerSecret` 模式补一个 Task 即可。

**Files:**

- Create: `scripts/import-chatgpt-credentials.ts`
- Test: 无自动测试（依赖真实账号与真实 Supabase；`--check` 干跑即验收 (d)）

**步骤：**

- [ ] 创建 `scripts/import-chatgpt-credentials.ts`：

```ts
/**
 * ChatGPT 凭据一次性导入脚本（需用户真实环境执行）
 *
 * 1. 读取 ~/.codex/auth.json（Codex CLI 登录产物），提取 accessToken / refreshToken / accountId；
 * 2. 复用项目专用浏览器 Profile（output/chatgpt-browser-profile，已 gitignore）打开 chatgpt.com，
 *    已登录则提取 __Secure-next-auth.session-token，未登录等待人工 Google 登录（不自动化登录）；
 * 3. 用 accessToken 试调一次 codex rate_limits，成功才继续；
 * 4. AES-GCM 加密凭据，按 provider_key=chatgpt + account_label=默认账号 upsert 到 Supabase；
 * 5. --check 干跑：只读取与校验，不写库。
 *
 * 使用：
 *   node --experimental-strip-types scripts/import-chatgpt-credentials.ts --check
 *   node --experimental-strip-types scripts/import-chatgpt-credentials.ts [--skip-browser] [--auth-json <路径>]
 *
 * 安全：auth.json 与 cookie 仅在内存中转，不复制进项目目录、不进 git；输出只打印脱敏 hint。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const PROFILE_DIR = resolve(process.cwd(), "output/chatgpt-browser-profile");
const CHATGPT_HOME = "https://chatgpt.com";
const CODEX_RATE_LIMITS_URL = "https://chatgpt.com/backend-api/codex/rate_limits";
const LOGIN_WAIT_MS = 300_000;

function loadEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    throw new Error("未找到 .env（需要 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CREDENTIAL_ENCRYPTION_KEY / SUPABASE_USER_ID）");
  }
  const vars: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

type CodexAuthJson = {
  tokens?: { access_token?: string; refresh_token?: string; account_id?: string };
  account_id?: string;
};

function readCodexAuthJson(path: string): {
  accessToken: string;
  refreshToken: string | null;
  accountId: string | null;
} | null {
  if (!existsSync(path)) return null;
  let raw: CodexAuthJson;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as CodexAuthJson;
  } catch {
    return null;
  }
  const accessToken = raw.tokens?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  return {
    accessToken,
    refreshToken: typeof raw.tokens?.refresh_token === "string" ? raw.tokens.refresh_token : null,
    accountId:
      typeof raw.tokens?.account_id === "string"
        ? raw.tokens.account_id
        : typeof raw.account_id === "string"
          ? raw.account_id
          : null,
  };
}

function maskHint(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

// 从专用 Profile 提取 chatgpt.com 的 __Secure-next-auth.session-token；未登录则等待人工登录
async function extractSessionToken(): Promise<string | null> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    console.log(`[INFO] 打开 ${CHATGPT_HOME} ...`);
    await page.goto(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4_000);

    const readToken = async (): Promise<string | null> => {
      const cookies = await context.cookies("https://chatgpt.com");
      const token = cookies.find((cookie) => cookie.name === "__Secure-next-auth.session-token");
      return token?.value ?? null;
    };

    // 页面无 "Log in" 入口且已拿到 cookie → 已登录
    const immediate = await readToken();
    const loginButtons = await page.locator("text=Log in").count();
    if (immediate && loginButtons === 0) return immediate;

    console.log("");
    console.log("═════════════════════════════════════════════════");
    console.log("  请在打开的浏览器窗口中完成 Google 登录（脚本不自动化登录）");
    console.log(`  登录成功后自动继续，最长等待 ${LOGIN_WAIT_MS / 1000} 秒`);
    console.log("═════════════════════════════════════════════════");
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      const token = await readToken();
      if (token) return token;
      await page.waitForTimeout(2_000);
    }
    console.error(`[FAIL] 登录超时（${LOGIN_WAIT_MS / 1000} 秒）`);
    return null;
  } finally {
    await context.close();
  }
}

// 校验：用导入的 token 试调 codex rate_limits，成功才落库
async function validateCodexToken(
  accessToken: string,
  accountId: string | null,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const response = await fetch(CODEX_RATE_LIMITS_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      },
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}，token 已失效（请在 Codex CLI 重新登录后再导入）` };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// AES-GCM 加密，与 worker/security/credentials.ts 保持一致
async function encryptPayload(
  payload: Record<string, string>,
  rawKey: string,
): Promise<{ encryptedPayload: string; nonce: string; keyVersion: string }> {
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(rawKey);
  if (keyBytes.byteLength !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be 32 UTF-8 bytes");
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext);
  const bytesToB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
  return {
    encryptedPayload: bytesToB64(new Uint8Array(encrypted)),
    nonce: bytesToB64(nonce),
    keyVersion: "v1",
  };
}

// 按 provider_key=chatgpt + account_label=默认账号 写入加密凭据与脱敏 hint
async function upsertChatgptAccountCredentials(
  env: Record<string, string>,
  credentials: Record<string, string>,
): Promise<void> {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
  const userId = env.SUPABASE_USER_ID;

  if (!supabaseUrl || !serviceRoleKey || !encryptionKey || !userId) {
    console.warn("[WARN] 缺少 Supabase 配置（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CREDENTIAL_ENCRYPTION_KEY / SUPABASE_USER_ID），跳过凭据写入");
    return;
  }

  const accountLabel = "默认账号";
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // 1. 查找账号
  const findUrl = new URL("/rest/v1/provider_accounts", supabaseUrl);
  findUrl.searchParams.set("select", "id");
  findUrl.searchParams.set("user_id", `eq.${userId}`);
  findUrl.searchParams.set("provider_key", "eq.chatgpt");
  findUrl.searchParams.set("account_label", `eq.${accountLabel}`);
  findUrl.searchParams.set("limit", "1");

  const findResp = await fetch(findUrl, { headers });
  if (!findResp.ok) {
    console.warn(`[WARN] 查询 Supabase 账号失败: HTTP ${findResp.status}`);
    return;
  }
  const rows = (await findResp.json()) as Array<{ id: string }>;
  let accountId = rows[0]?.id ?? null;

  // 2. 未找到则创建
  if (!accountId) {
    const createResp = await fetch(new URL("/rest/v1/provider_accounts", supabaseUrl), {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: userId,
        provider_key: "chatgpt",
        display_name: accountLabel,
        account_label: accountLabel,
        source_url: CHATGPT_HOME,
        auth_mode: "configured",
        status: "ready",
      }),
    });
    if (!createResp.ok) {
      console.warn(`[WARN] 创建 Supabase 账号失败: HTTP ${createResp.status}`);
      return;
    }
    const created = (await createResp.json()) as Array<{ id: string }>;
    accountId = created[0]?.id ?? null;
    if (accountId) console.log(`[OK] 已创建 chatgpt 账号（label=${accountLabel}）`);
  }
  if (!accountId) {
    console.warn("[WARN] 无法确定账号 ID，跳过凭据写入");
    return;
  }

  // 3. 加密凭据写入 provider_account_credentials（on_conflict=provider_account_id 覆盖）
  const encrypted = await encryptPayload(credentials, encryptionKey);
  const credUrl = new URL("/rest/v1/provider_account_credentials", supabaseUrl);
  credUrl.searchParams.set("on_conflict", "provider_account_id");
  const credResp = await fetch(credUrl, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      user_id: userId,
      provider_account_id: accountId,
      encrypted_payload: encrypted.encryptedPayload,
      nonce: encrypted.nonce,
      key_version: encrypted.keyVersion,
    }),
  });
  console.log(credResp.ok ? "[OK] 加密凭据已写入 provider_account_credentials" : `[WARN] 加密凭据写入失败: HTTP ${credResp.status}`);

  // 4. 同步脱敏 hint 与账号状态
  const hint = Object.fromEntries(Object.entries(credentials).map(([key, value]) => [key, maskHint(value)]));
  const patchResp = await fetch(new URL(`/rest/v1/provider_accounts?id=eq.${accountId}`, supabaseUrl), {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({ credential_hint: hint, status: "ready", auth_mode: "configured" }),
  });
  console.log(patchResp.ok ? "[OK] 账号 credential_hint 已更新" : `[WARN] hint 更新失败: HTTP ${patchResp.status}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const skipBrowser = args.includes("--skip-browser");
  const authJsonIndex = args.indexOf("--auth-json");
  const authJsonPath =
    authJsonIndex >= 0 && args[authJsonIndex + 1]
      ? resolve(args[authJsonIndex + 1]!)
      : resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".codex/auth.json");

  const env = loadEnv();

  const codex = readCodexAuthJson(authJsonPath);
  if (!codex) {
    console.error(`[FAIL] 未读取到 Codex 凭据：${authJsonPath} 缺少 tokens.access_token（请先在 Codex CLI 登录）`);
    process.exit(1);
  }
  console.log(`[OK] auth.json 已读取（accessToken ${maskHint(codex.accessToken)}）`);

  let sessionToken: string | null = null;
  if (skipBrowser) {
    console.warn("[WARN] --skip-browser：跳过网页 session cookie 提取");
  } else {
    sessionToken = await extractSessionToken();
    if (sessionToken) {
      console.log(`[OK] session cookie 已提取（${maskHint(sessionToken)}）`);
    } else {
      console.warn("[WARN] 未提取到 __Secure-next-auth.session-token（可仅用 Codex 凭据继续）");
    }
  }

  console.log("[INFO] 校验 codex token ...");
  const validation = await validateCodexToken(codex.accessToken, codex.accountId);
  if (!validation.ok) {
    console.error(`[FAIL] codex token 校验失败：${validation.error}`);
    process.exit(1);
  }
  console.log(`[OK] codex rate_limits HTTP ${validation.status}`);

  const credentials: Record<string, string> = { accessToken: codex.accessToken };
  if (codex.refreshToken) credentials.refreshToken = codex.refreshToken;
  if (codex.accountId) credentials.accountId = codex.accountId;
  if (sessionToken) credentials.sessionToken = sessionToken;

  if (checkOnly) {
    console.log("\n[--check] 干跑结束，未写入任何数据。将导入的字段：");
    for (const [key, value] of Object.entries(credentials)) {
      console.log(`  ${key} = ${maskHint(value)}`);
    }
    return;
  }

  await upsertChatgptAccountCredentials(env, credentials);
  console.log("\n━━━ 完成 ━━━");
  console.log("看板下次刷新即使用新凭据；Codex token 过期后由 Worker 自动刷新。");
  console.log("session cookie 约 30 天有效，过期后重新运行本脚本（第二期提供续期脚本）。");
}

main().catch((err) => {
  console.error("[FAIL] 脚本执行失败:", err);
  process.exit(1);
});
```

- [ ] 运行 `npx tsc --noEmit`，预期 0 错误。
- [ ] 提交：

```bash
git add scripts/import-chatgpt-credentials.ts
git commit -m "chore(scripts): 新增 chatgpt 凭据导入脚本（auth.json + Profile cookie + --check 干跑）"
```

- [ ] **需用户真实环境执行**（验收 spec §9(d)）：

```bash
node --experimental-strip-types scripts/import-chatgpt-credentials.ts --check
node --experimental-strip-types scripts/import-chatgpt-credentials.ts
```

- [ ] **敏感目录检查**（会话涉及 cookie/token，按仓库安全规则执行）：

```bash
git status
git ls-files | grep -i "chatgpt-browser-profile\|output/"
git fsck --no-reflogs 2>&1 | head -5
```

预期：profile 目录不出现在跟踪列表，无敏感对象。

---

## Task 10：全量回归与手动验收

**Files:**

- Test: 全部既有测试（无新文件）

**步骤：**

- [ ] 运行 `npm run test`，预期全部通过（tests/frontend + tests/worker）。
- [ ] 运行 `npm run build`，预期 `tsc --noEmit` 0 错误且前端构建成功。
- [ ] **需用户真实环境执行**——spec §9 手动验收清单：
  - (a) 上述两条命令通过即满足。
  - (b) 免费账号路径：Supabase 仅配 sessionToken（不配 codex 三元组）→ 看板 chatgpt 卡显示订阅桶 `plan:"free"`、无 crash。状态按 spec §5 状态机：网页链路取到窗口 → `ready`；被 CF 拦截或结构未解析 → `partial`（spec §9(b) 写 partial 的前提即网页链路降级；两种结果均不算验收失败，但 `plan:"free"` 与无 crash 必须成立）。`planRenewAt=null` 显示「订阅前无数据」。
  - (c) 全无凭据：chatgpt 卡 `login_required`；设置页选择 ChatGPT 后表单出现四个密码输入框，填写保存后回显脱敏 hint（`fake-...en-1` 形态）。
  - (d) `node --experimental-strip-types scripts/import-chatgpt-credentials.ts --check` 输出校验结论与待导入字段脱敏清单。
  - 补充：Codex 凭据导入后触发一次刷新（前端刷新按钮或 `POST /api/refresh`），观察 Supabase `provider_account_credentials.updated_at` 变化（token 自动刷新写回生效）；partial 轮次看板窗口出现「（历史）」后缀（桶级补齐生效）。
- [ ] 提交（如有测试修正）：

```bash
git add -A tests
git commit -m "test: chatgpt provider 第一期回归修正"
```

---

## 验收标准 / 测试要点（什么算做完）

**自动验证（CI 可跑）：**

1. `npm run test:worker` 全绿，其中新增：repository 写回 3 例、chatgpt 组一 6 例、组二 5 例、registry 断言、index 集成 2 例（桶级补齐 + token 写回全链路）。
2. `npm run test:frontend` 全绿，其中新增：chatgpt 凭据表单四字段密码化 1 例、chatgpt 卡片映射与三个兜底文案 1 例。
3. `npm run test`、`npm run build` 全部通过。
4. 所有 fixture 均为 `fake-*` 假 token；`grep -r "sk-\|eyJ" tests/` 无真实凭据形态。

**手动验收（需用户真实环境）：**

- spec §9 (a)-(d) 全项，见 Task 10 清单。
- 免费账号缺失语义：codex 窗口不产出、`planRenewAt=null` →「订阅前无数据」、summary 含「当前免费档，无 Codex 窗口数据」。

**测试要点（供 test-engineer 设计回归时参考）：**

- 状态机边界：无凭据 / 仅 codex / 仅 session / 三链路全失败 / CF 质询单桶 / 订阅 404 / 刷新成功但重试仍 401（credentialUpdate 仍须带出）。
- 安全边界：白名单拒绝非 https 与非 chatgpt/openai 域；写回密文不含明文 token；hint 恒为脱敏形态。
- 回归关注点：registry 数量变化对 `/api/usage` totals、`/api/providers` 列表的影响；既有 8 个 provider 行为零变化。

## 风险清单

| 风险 | 应对（已落入计划的位置） |
| --- | --- |
| codex rate_limits 响应结构未验证 | Task 8 探测脚本 + Task 3/4 宽容解析（多键名、ISO/剩余秒数双形态）；不符时只改解析键与测试断言 |
| OAuth 刷新 client_id / 请求体格式未确认 | 常量 `defaultCodexClientId` + JSON body；Task 8 `--refresh` 探测核对；若刷新端点被阻塞，第一期末降级为「重跑导入脚本」（spec 风险表既定） |
| refresh token 轮换导致旧 token 作废 | `fetchCodexWindows` 在刷新成功后即使重试失败也带出 credentialUpdate；所有 merge 返回路径均透传 |
| spec §9(b)「免费账号 partial」与 §5 状态机（web 有数据即 ready）表述存在张力 | 以 §5 状态机为实现准绳，Task 10 验收 (b) 明确两种状态均合格、`plan:"free"` 与无 crash 为硬性项 |
| 写回通道把 service role 边界打穿到 provider 层 | 设计已规避：provider 只经返回值带出，Supabase 写入集中在 index.ts（spec §4 权衡） |
| 桶级补齐窗口与既有整卡回退的交互 | 补齐仅作用于 chatgpt partial 快照且持久化前执行；整卡回退（applyLatestReadyFallback）语义不变，display 仍以 ready 快照优先 |
| 浏览器 Profile / auth.json 泄露进 git | Profile 固定在 `output/`（已 gitignore）；auth.json 绝对路径参数化、仅内存中转；Task 9 末尾强制 git status/ls-files/fsck 检查 |
| AbortSignal.timeout 兼容性 | Workers runtime 与 Node 18+（vitest 环境）均支持；15s 默认值与 opencode-go 约定一致 |
