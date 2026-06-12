# 可配置供应商与阿里云百炼 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加独立配置页，让供应商启停、展示顺序、多账号凭据和阿里云百炼接入可以通过云端配置管理，同时保持敏感凭据不暴露给前端。

**Architecture:** 首页继续负责展示与活跃刷新；新增 `/settings` 独立配置页管理供应商偏好和账号。Cloudflare Worker 负责配置 API、凭据加密/解密、provider 抓取；Supabase 保存偏好、账号元数据和加密凭据，前端只读取脱敏字段。现有 `.env` / Worker secrets 作为 fallback，迁移期间不破坏已可用的 OpenRouter、OpenCode Go、讯飞 MaaS。

**Tech Stack:** React, TypeScript, Vite, Cloudflare Worker, Durable Object, Supabase Postgres, Supabase RLS, Web Crypto AES-GCM, Vitest, Wrangler.

---

## Scope Check

本计划覆盖一个聚合功能：供应商配置中心。它包含数据库、Worker API、前端设置页、provider 配置读取和阿里云百炼 provider，但这些都服务同一用户流程：在云端配置供应商并驱动首页展示。任务按可独立验证的小步拆分，任何一步失败都不应破坏当前 env fallback 看板。

本计划不实现网页登录自动化，也不保存网页登录密码。用户如果在 `.env` 里已有阿里云账号密码，本阶段不读取密码字段；阿里云百炼第一版接入采用 dashboard URL + cookie/API URL 模式。

## File Structure

- Modify: `worker/types.ts`  
  扩展 `ProviderId`、Worker env、配置 API 返回类型。
- Modify: `worker/providers/registry.ts`  
  注册 `aliyun-bailian` provider。
- Create: `worker/providers/aliyun-bailian.ts`  
  阿里云百炼 Coding Plan provider，第一版支持 cookie/API URL 配置、登录态判断、标准化窗口解析。
- Create: `worker/security/credentials.ts`  
  Worker AES-GCM 加密/解密、脱敏、配置字段白名单。
- Create: `worker/settings/repository.ts`  
  Supabase REST 读写 provider preferences、provider accounts、credential ciphertext。
- Create: `worker/settings/routes.ts`  
  `/api/settings/*` 路由处理，统一 admin token 鉴权和 JSON 错误。
- Modify: `worker/index.ts`  
  接入 settings routes；刷新时优先读取 Supabase active account，失败或无配置时使用 env fallback。
- Modify: `worker/dashboard.ts`  
  支持按 provider preferences 顺序输出卡片，隐藏 disabled provider。
- Create: `supabase/migrations/202606120001_provider_settings_and_credentials.sql`  
  新增 provider preferences、provider account credentials、索引、RLS、GRANT。
- Modify: `frontend/src/api/client.ts`  
  增加 settings API client、前端类型、北京时间显示保持不变。
- Modify: `frontend/src/App.tsx`  
  增加 hash route：`#/` 首页、`#/settings` 配置页。
- Modify: `frontend/src/components/dashboard-shell.tsx`  
  首页顶端增加配置按钮，跳转 `#/settings`。
- Create: `frontend/src/settings/settings-page.tsx`  
  独立配置页骨架：供应商列表、启用开关、排序、账号面板。
- Create: `frontend/src/settings/provider-order-list.tsx`  
  原生拖拽排序和启停控制。
- Create: `frontend/src/settings/provider-account-panel.tsx`  
  当前供应商账号列表、启用账号、测试连接入口。
- Create: `frontend/src/settings/credential-form.tsx`  
  按 provider 类型展示字段，保存后只显示脱敏值。
- Modify: `frontend/src/styles.css`  
  配置页布局、按钮、表单、拖拽态和移动端样式。
- Modify: `.env.example`  
  增加 `ADMIN_SETUP_TOKEN`、`CREDENTIAL_ENCRYPTION_KEY`、`ALIYUN_BAILIAN_*` 示例，不写真实值。
- Create: `tests/worker/credentials.test.ts`
- Create: `tests/worker/settings-routes.test.ts`
- Modify: `tests/worker/providers.test.ts`
- Modify: `tests/worker/index.test.ts`
- Create: `tests/frontend/settingsPage.test.tsx`
- Modify: `tests/frontend/apiClient.test.ts`

---

### Task 1: Supabase 配置数据模型

**Files:**
- Create: `supabase/migrations/202606120001_provider_settings_and_credentials.sql`
- Test: `tests/worker/settings-routes.test.ts`

- [ ] **Step 1: 写数据库模型验收测试**

在 `tests/worker/settings-routes.test.ts` 中新增一个纯 SQL 字符串检查测试，先锁定迁移必须包含的安全边界：

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

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
    expect(sql).toContain("alter table public.provider_preferences enable row level security");
    expect(sql).toContain("revoke all on public.provider_account_credentials from anon, authenticated");
    expect(sql).toContain("grant select, insert, update, delete on public.provider_account_credentials to service_role");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:worker -- tests/worker/settings-routes.test.ts`

Expected: FAIL，因为 migration 文件尚不存在。

- [ ] **Step 3: 新增 migration**

创建 `supabase/migrations/202606120001_provider_settings_and_credentials.sql`：

```sql
create table if not exists public.provider_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_key text not null,
  enabled boolean not null default true,
  display_order integer not null default 100,
  active_provider_account_id uuid references public.provider_accounts(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, provider_key)
);

alter table public.provider_accounts
  add column if not exists account_label text not null default '默认账号',
  add column if not exists is_archived boolean not null default false,
  add column if not exists credential_hint jsonb not null default '{}'::jsonb,
  add column if not exists last_test_at timestamptz;

create table if not exists public.provider_account_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_account_id uuid not null references public.provider_accounts(id) on delete cascade,
  encrypted_payload text not null,
  nonce text not null,
  key_version text not null default 'v1',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (provider_account_id)
);

create index if not exists provider_preferences_user_order_idx
  on public.provider_preferences (user_id, display_order, provider_key);

create index if not exists provider_accounts_user_provider_label_idx
  on public.provider_accounts (user_id, provider_key, account_label);

alter table public.provider_preferences enable row level security;
alter table public.provider_account_credentials enable row level security;

drop policy if exists provider_preferences_select_own on public.provider_preferences;
create policy provider_preferences_select_own
  on public.provider_preferences
  for select
  using (auth.uid() = user_id);

drop policy if exists provider_preferences_insert_own on public.provider_preferences;
create policy provider_preferences_insert_own
  on public.provider_preferences
  for insert
  with check (auth.uid() = user_id);

drop policy if exists provider_preferences_update_own on public.provider_preferences;
create policy provider_preferences_update_own
  on public.provider_preferences
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

revoke all on public.provider_account_credentials from anon, authenticated;
grant select, insert, update, delete on public.provider_account_credentials to service_role;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:worker -- tests/worker/settings-routes.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add supabase/migrations/202606120001_provider_settings_and_credentials.sql tests/worker/settings-routes.test.ts
git commit -m "feat: add provider settings schema"
```

---

### Task 2: Worker 凭据加密与脱敏

**Files:**
- Create: `worker/security/credentials.ts`
- Test: `tests/worker/credentials.test.ts`
- Modify: `worker/types.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/worker/credentials.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { decryptCredentialPayload, encryptCredentialPayload, maskCredentialPayload } from "../../worker/security/credentials";

describe("credential security helpers", () => {
  const key = "0123456789abcdef0123456789abcdef";

  it("encrypts, decrypts, and masks provider credentials", async () => {
    const payload = {
      apiKey: "sk-or-secret-value",
      authCookie: "auth=secret-cookie; theme=light",
      workspaceId: "wrk_123",
    };

    const encrypted = await encryptCredentialPayload(payload, key);
    expect(encrypted.encryptedPayload).not.toContain("sk-or-secret-value");
    expect(encrypted.encryptedPayload).not.toContain("secret-cookie");

    await expect(decryptCredentialPayload(encrypted, key)).resolves.toEqual(payload);
    expect(maskCredentialPayload(payload)).toEqual({
      apiKey: "sk-or...alue",
      authCookie: "auth=...ight",
      workspaceId: "wrk_123",
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:worker -- tests/worker/credentials.test.ts`

Expected: FAIL，提示找不到 `worker/security/credentials`。

- [ ] **Step 3: 实现 Worker Web Crypto 加密工具**

创建 `worker/security/credentials.ts`：

```ts
export type CredentialPayload = Record<string, string | number | boolean | null>;

export type EncryptedCredentialPayload = {
  encryptedPayload: string;
  nonce: string;
  keyVersion: "v1";
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importAesKey(rawKey: string): Promise<CryptoKey> {
  const bytes = new TextEncoder().encode(rawKey);
  if (bytes.byteLength !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be exactly 32 UTF-8 bytes");
  }
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptCredentialPayload(
  payload: CredentialPayload,
  rawKey: string,
): Promise<EncryptedCredentialPayload> {
  const key = await importAesKey(rawKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    encryptedPayload: toBase64(new Uint8Array(encrypted)),
    nonce: toBase64(iv),
    keyVersion: "v1",
  };
}

export async function decryptCredentialPayload(
  encrypted: EncryptedCredentialPayload,
  rawKey: string,
): Promise<CredentialPayload> {
  const key = await importAesKey(rawKey);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(encrypted.nonce) },
    key,
    fromBase64(encrypted.encryptedPayload),
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as CredentialPayload;
}

function maskSecret(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

export function maskCredentialPayload(payload: CredentialPayload): CredentialPayload {
  const masked: CredentialPayload = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value !== "string") {
      masked[key] = value;
      continue;
    }
    masked[key] = /apiKey|cookie|token|secret|password/i.test(key) ? maskSecret(value) : value;
  }
  return masked;
}
```

- [ ] **Step 4: 扩展 Worker env 类型**

在 `worker/types.ts` 的 `WorkerEnv` 中加入：

```ts
ADMIN_SETUP_TOKEN?: string;
CREDENTIAL_ENCRYPTION_KEY?: string;
ALIYUN_BAILIAN_PAGE_URL?: string;
ALIYUN_BAILIAN_API_URL?: string;
ALIYUN_BAILIAN_AUTH_COOKIE?: string;
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test:worker -- tests/worker/credentials.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add worker/security/credentials.ts worker/types.ts tests/worker/credentials.test.ts
git commit -m "feat: encrypt provider credentials in worker"
```

---

### Task 3: Settings Repository 与 Admin Token 鉴权

**Files:**
- Create: `worker/settings/repository.ts`
- Create: `worker/settings/routes.ts`
- Modify: `worker/index.ts`
- Test: `tests/worker/settings-routes.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/worker/settings-routes.test.ts` 增加：

```ts
import { describe, expect, it, vi } from "vitest";
import { handleSettingsRequest } from "../../worker/settings/routes";

describe("settings routes", () => {
  it("rejects settings writes without admin token", async () => {
    const response = await handleSettingsRequest(
      new Request("https://app.test/api/settings/providers", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providers: [] }),
      }),
      {
        ADMIN_SETUP_TOKEN: "local-admin",
      } as never,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
  });

  it("returns provider settings without encrypted credential values", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("provider_preferences")) {
        return new Response(JSON.stringify([{ provider_key: "opencode-go", enabled: true, display_order: 2 }]), { status: 200 });
      }
      if (String(url).includes("provider_accounts")) {
        return new Response(JSON.stringify([{ id: "acc-1", provider_key: "opencode-go", account_label: "主账号", credential_hint: { authCookie: "auth=...abcd" }, status: "ready" }]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });

    const response = await handleSettingsRequest(
      new Request("https://app.test/api/settings/providers", {
        headers: { "x-api-monitor-admin-token": "local-admin" },
      }),
      {
        ADMIN_SETUP_TOKEN: "local-admin",
        SUPABASE_URL: "https://supabase.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role",
        SUPABASE_USER_ID: "00000000-0000-0000-0000-000000000001",
      } as never,
      fetchImpl as typeof fetch,
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain("encrypted_payload");
    expect(payload.data.accounts[0]).toMatchObject({
      providerKey: "opencode-go",
      accountLabel: "主账号",
      credentialHint: { authCookie: "auth=...abcd" },
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:worker -- tests/worker/settings-routes.test.ts`

Expected: FAIL，提示找不到 settings routes。

- [ ] **Step 3: 实现 settings repository**

创建 `worker/settings/repository.ts`，导出 `listProviderSettings`、`upsertProviderPreferences`、`upsertProviderAccount`、`getActiveProviderAccountConfig`。所有函数接收 `fetchImpl`，使用 Supabase REST：

```ts
export type SafeProviderAccount = {
  id: string;
  providerKey: string;
  accountLabel: string;
  sourceUrl: string;
  status: string;
  statusMessage: string | null;
  credentialHint: Record<string, unknown>;
};

export function createSupabaseHeaders(serviceRoleKey: string): HeadersInit {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}
```

具体查询使用：

```ts
new URL("/rest/v1/provider_preferences", env.SUPABASE_URL);
new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
new URL("/rest/v1/provider_account_credentials", env.SUPABASE_URL);
```

- [ ] **Step 4: 实现 settings routes**

创建 `worker/settings/routes.ts`：

```ts
import { errorResponse, successResponse } from "../http";
import type { WorkerEnv } from "../types";
import { listProviderSettings } from "./repository";

function requireAdmin(request: Request, env: WorkerEnv): Response | null {
  if (!env.ADMIN_SETUP_TOKEN) return errorResponse(500, "missing_admin_token", "ADMIN_SETUP_TOKEN is not configured");
  if (request.headers.get("x-api-monitor-admin-token") !== env.ADMIN_SETUP_TOKEN) {
    return errorResponse(401, "unauthorized", "Admin token is required");
  }
  return null;
}

export async function handleSettingsRequest(
  request: Request,
  env: WorkerEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/settings/providers") {
    return successResponse(await listProviderSettings(env, fetchImpl));
  }

  return errorResponse(404, "not_found", "Unknown settings route");
}
```

- [ ] **Step 5: 接入 `worker/index.ts`**

在 `handleApiRequest` 中加入，放在 `/api/providers` 前后都可以：

```ts
if (url.pathname.startsWith("/api/settings/")) {
  return handleSettingsRequest(request, env);
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm run test:worker -- tests/worker/settings-routes.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交**

```powershell
git add worker/settings worker/index.ts tests/worker/settings-routes.test.ts
git commit -m "feat: add settings API guard and repository"
```

---

### Task 4: Settings 写入 API 与 active account 配置读取

**Files:**
- Modify: `worker/settings/repository.ts`
- Modify: `worker/settings/routes.ts`
- Modify: `worker/index.ts`
- Test: `tests/worker/settings-routes.test.ts`
- Test: `tests/worker/index.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/worker/index.test.ts` 增加一个用例：当 Supabase settings 中存在 active OpenCode account 时，`/api/refresh` 使用数据库配置；无配置时继续使用 env fallback。

测试 fetch mock 需要区分：

```ts
if (url.includes("provider_preferences")) return Response.json([{ provider_key: "opencode-go", enabled: true, display_order: 1, active_provider_account_id: "acc-1" }]);
if (url.includes("provider_accounts")) return Response.json([{ id: "acc-1", provider_key: "opencode-go", source_url: "https://opencode.ai/workspace/wrk_db/go", config: { workspaceId: "wrk_db" }, credential_hint: { authCookie: "auth=...abcd" } }]);
if (url.includes("provider_account_credentials")) return Response.json([{ encrypted_payload: encrypted.encryptedPayload, nonce: encrypted.nonce, key_version: "v1" }]);
```

断言 OpenCode fetch URL 是 `https://opencode.ai/workspace/wrk_db/go`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:worker -- tests/worker/index.test.ts`

Expected: FAIL，因为 refresh 尚不读 settings。

- [ ] **Step 3: 实现写入 API**

在 `worker/settings/routes.ts` 增加：

```ts
if (request.method === "PUT" && url.pathname === "/api/settings/providers") {
  return successResponse(await upsertProviderPreferences(env, await readJsonBody(request), fetchImpl));
}

if (request.method === "POST" && url.pathname === "/api/settings/accounts") {
  return successResponse(await upsertProviderAccount(env, await readJsonBody(request), fetchImpl));
}

if (request.method === "POST" && url.pathname.match(/^\/api\/settings\/accounts\/[^/]+\/test$/)) {
  const accountId = url.pathname.split("/")[4];
  return successResponse(await testProviderAccount(env, accountId, fetchImpl));
}
```

`upsertProviderAccount` 必须：

1. 校验 provider 字段白名单。
2. 用 `encryptCredentialPayload` 加密 credential payload。
3. 把脱敏后的 `credential_hint` 写入 `provider_accounts`。
4. 把密文写入 `provider_account_credentials`。

- [ ] **Step 4: refresh 读取 active account**

在 `worker/index.ts` 中新增 `buildProviderConfigs(env)`，规则：

1. 如果 Supabase settings 可用，读取 enabled provider，按 display_order 排序。
2. 每个 provider 只使用 active account。
3. 解密 credentials 后和 account.config 合并为 provider config。
4. 如果 settings 不可用或 provider 没有 active account，回退到现有 `buildProviderConfig(env, providerId)`。

返回类型：

```ts
type ProviderRuntimeConfig = {
  providerId: ProviderId;
  config: Record<string, unknown>;
  sourceUrl?: string;
};
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test:worker -- tests/worker/index.test.ts tests/worker/settings-routes.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add worker/index.ts worker/settings tests/worker/index.test.ts tests/worker/settings-routes.test.ts
git commit -m "feat: use configured provider accounts for refresh"
```

---

### Task 5: 前端独立配置页与配置按钮

**Files:**
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/dashboard-shell.tsx`
- Create: `frontend/src/settings/settings-page.tsx`
- Create: `frontend/src/settings/provider-order-list.tsx`
- Create: `frontend/src/settings/provider-account-panel.tsx`
- Create: `frontend/src/settings/credential-form.tsx`
- Modify: `frontend/src/styles.css`
- Test: `tests/frontend/settingsPage.test.tsx`
- Test: `tests/frontend/apiClient.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/frontend/settingsPage.test.tsx`：

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../../frontend/src/settings/settings-page";

describe("SettingsPage", () => {
  it("renders provider switches, account panel, and saves provider order", async () => {
    const api = {
      getProviderSettings: vi.fn(async () => ({
        catalog: [
          { providerKey: "openrouter", providerName: "OpenRouter" },
          { providerKey: "opencode-go", providerName: "OpenCode Go" },
        ],
        preferences: [
          { providerKey: "openrouter", enabled: true, displayOrder: 2, activeProviderAccountId: "acc-openrouter" },
          { providerKey: "opencode-go", enabled: true, displayOrder: 1, activeProviderAccountId: "acc-opencode" },
        ],
        accounts: [
          { id: "acc-opencode", providerKey: "opencode-go", accountLabel: "主账号", status: "ready", credentialHint: { authCookie: "auth=...abcd" } },
        ],
      })),
      saveProviderPreferences: vi.fn(async () => undefined),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    expect(await screen.findByText("OpenCode Go")).toBeInTheDocument();
    expect(screen.getByText("主账号")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(api.saveProviderPreferences).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:frontend -- tests/frontend/settingsPage.test.tsx`

Expected: FAIL，因为 `SettingsPage` 不存在。

- [ ] **Step 3: 扩展前端 API client**

在 `frontend/src/api/client.ts` 增加：

```ts
export type ProviderPreference = {
  providerKey: string;
  enabled: boolean;
  displayOrder: number;
  activeProviderAccountId: string | null;
};

export type SafeProviderAccount = {
  id: string;
  providerKey: string;
  accountLabel: string;
  status: string;
  credentialHint: Record<string, unknown>;
};
```

在 `createApiClient` 返回对象中增加：

```ts
async getProviderSettings(adminToken: string) {
  const payload = await requestJson(fetcher, buildUrl(options.baseUrl, "/api/settings/providers"), {
    method: "GET",
    headers: { ...headers, "x-api-monitor-admin-token": adminToken },
  });
  return unwrapEnvelope(payload);
}
```

同时增加 `saveProviderPreferences`、`saveProviderAccount`、`testProviderAccount`。

- [ ] **Step 4: 实现 hash route**

在 `frontend/src/App.tsx` 增加：

```ts
const [route, setRoute] = useState(() => window.location.hash || "#/");
useEffect(() => {
  const onHashChange = () => setRoute(window.location.hash || "#/");
  window.addEventListener("hashchange", onHashChange);
  return () => window.removeEventListener("hashchange", onHashChange);
}, []);
```

当 `route === "#/settings"` 时渲染：

```tsx
<SettingsPage api={api} onBack={() => { window.location.hash = "#/"; }} />
```

- [ ] **Step 5: 顶部增加配置按钮**

在 `frontend/src/components/dashboard-shell.tsx` 的 `.actions` 中加入：

```tsx
<a className="btn btn--ghost" href="#/settings">配置</a>
```

- [ ] **Step 6: 实现配置页组件**

`settings-page.tsx` 负责：

1. 首次进入时读取 `sessionStorage.getItem("api-monitor-admin-token")`。
2. 没有 token 时显示输入框，保存到 sessionStorage。
3. 读取 settings。
4. 传给 `ProviderOrderList` 和 `ProviderAccountPanel`。

`provider-order-list.tsx` 使用原生 drag events，不引入新依赖：

```tsx
<button type="button" draggable onDragStart={...} onDrop={...}>拖动</button>
```

- [ ] **Step 7: 运行前端测试**

Run: `npm run test:frontend -- tests/frontend/settingsPage.test.tsx tests/frontend/apiClient.test.ts`

Expected: PASS。

- [ ] **Step 8: 提交**

```powershell
git add frontend/src tests/frontend
git commit -m "feat: add provider settings page"
```

---

### Task 6: 阿里云百炼 provider

**Files:**
- Create: `worker/providers/aliyun-bailian.ts`
- Modify: `worker/providers/registry.ts`
- Modify: `worker/types.ts`
- Modify: `frontend/src/api/client.ts`
- Test: `tests/worker/providers.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/worker/providers.test.ts` 增加：

```ts
import { fetchAliyunBailianSnapshot } from "../../worker/providers/aliyun-bailian";

describe("aliyun-bailian adapter", () => {
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
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:worker -- tests/worker/providers.test.ts`

Expected: FAIL，提示找不到 `aliyun-bailian` provider。

- [ ] **Step 3: 实现 provider**

创建 `worker/providers/aliyun-bailian.ts`：

```ts
import { parseHeadersCookie, toIsoString } from "../http";
import type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult } from "../types";
import { createResult } from "./types";

type AliyunBailianConfig = {
  pageUrl?: string;
  apiUrl?: string;
  authCookie?: string;
};

const DEFAULT_PAGE_URL = "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/coding-plan";

export async function fetchAliyunBailianSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = (input.config ?? {}) as AliyunBailianConfig;
  const sourceUrl = config.pageUrl ?? DEFAULT_PAGE_URL;

  if (!config.authCookie) {
    return createResult({
      providerId: "aliyun-bailian",
      providerName: "阿里云百炼",
      sourceUrl,
      status: "login_required",
      capturedAt: now,
      summary: "Missing Aliyun Bailian auth cookie",
      windows: [],
      metrics: {},
      meta: {},
    });
  }

  if (!config.apiUrl) {
    return createResult({
      providerId: "aliyun-bailian",
      providerName: "阿里云百炼",
      sourceUrl,
      status: "partial",
      capturedAt: now,
      summary: "阿里云百炼看板入口已配置，等待补充稳定 JSON 用量接口",
      windows: [],
      metrics: { hasAuthCookie: true },
      meta: {},
    });
  }

  const response = await fetchImpl(config.apiUrl, {
    headers: {
      Cookie: parseHeadersCookie(config.authCookie) ?? "",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 ApiMonitor/0.1",
    },
  });

  const payload = await response.json() as {
    data?: {
      planName?: string;
      windows?: Array<{ key: string; label: string; used: number; limit: number; resetAt?: string }>;
    };
  };

  if (!response.ok) {
    return createResult({
      providerId: "aliyun-bailian",
      providerName: "阿里云百炼",
      sourceUrl,
      status: response.status === 401 || response.status === 403 ? "login_required" : "error",
      capturedAt: now,
      summary: `阿里云百炼接口返回 HTTP ${response.status}`,
      windows: [],
      metrics: { httpStatus: response.status },
      meta: {},
    });
  }

  const windows = (payload.data?.windows ?? []).map((window) => ({
    key: window.key,
    label: window.label,
    used: window.used,
    limit: window.limit,
    remaining: Math.max(0, window.limit - window.used),
    resetAt: window.resetAt ?? null,
  }));

  return createResult({
    providerId: "aliyun-bailian",
    providerName: "阿里云百炼",
    sourceUrl,
    status: windows.length > 0 ? "ready" : "partial",
    capturedAt: now,
    summary: windows.length > 0 ? "阿里云百炼 Coding Plan 用量已解析" : "阿里云百炼接口未返回窗口数据",
    windows,
    metrics: { planName: payload.data?.planName ?? "Coding Plan" },
    meta: {},
  });
}

export const aliyunBailian: ProviderDefinition = {
  id: "aliyun-bailian",
  name: "阿里云百炼",
  sourceUrl: DEFAULT_PAGE_URL,
  description: "阿里云百炼 Coding Plan 用量入口和可配置 API 抓取",
  fetchSnapshot: fetchAliyunBailianSnapshot,
};
```

- [ ] **Step 4: 注册 provider**

更新 `worker/types.ts`：

```ts
export type ProviderId = "openrouter" | "opencode-go" | "xfyun-maas" | "aliyun-bailian";
```

更新 `worker/providers/registry.ts`：

```ts
import { aliyunBailian } from "./aliyun-bailian";

const PROVIDERS: ProviderDefinition[] = [openrouter, opencodeGo, xfyunMaaS, aliyunBailian];
```

- [ ] **Step 5: 前端展示映射**

在 `frontend/src/api/client.ts` 的 `resolveAccent`、`resolveTagline`、`resolvePrimaryMetricLabel` 中加入：

```ts
if (providerId === "aliyun-bailian") return "#7c3aed";
```

```ts
if (providerId === "aliyun-bailian") return "Coding Plan / 百炼控制台";
```

```ts
if (providerId === "aliyun-bailian") return "当前套餐";
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm run test:worker -- tests/worker/providers.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交**

```powershell
git add worker/providers worker/types.ts frontend/src/api/client.ts tests/worker/providers.test.ts
git commit -m "feat: add aliyun bailian provider"
```

---

### Task 7: 配置驱动首页顺序与隐藏 disabled provider

**Files:**
- Modify: `worker/dashboard.ts`
- Modify: `worker/index.ts`
- Test: `tests/worker/index.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/worker/index.test.ts` 增加用例：

```ts
it("orders dashboard cards by provider preferences and hides disabled providers", async () => {
  const dashboard = buildUsageDashboard(
    [
      createSnapshot(openrouterSnapshot),
      createSnapshot(opencodeSnapshot),
      createSnapshot(xfyunSnapshot),
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
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:worker -- tests/worker/index.test.ts`

Expected: FAIL，因为 `providerPreferences` 参数尚不存在。

- [ ] **Step 3: 实现排序过滤**

在 `worker/dashboard.ts` 增加：

```ts
type ProviderDashboardPreference = {
  providerKey: string;
  enabled: boolean;
  displayOrder: number;
};
```

扩展 `buildUsageDashboard` options：

```ts
providerPreferences?: ProviderDashboardPreference[];
```

在 `cards` 生成后应用：

```ts
const preferenceMap = new Map(options.providerPreferences?.map((item) => [item.providerKey, item]));
const cards = snapshots
  .map(buildCard)
  .filter((card) => preferenceMap.get(card.providerId)?.enabled ?? true)
  .sort((a, b) => {
    const left = preferenceMap.get(a.providerId)?.displayOrder ?? 100;
    const right = preferenceMap.get(b.providerId)?.displayOrder ?? 100;
    return left - right;
  });
```

- [ ] **Step 4: 从 settings repository 传 preferences**

在 `worker/index.ts` 的 `handleUsage` 和 `handleDashboardRefresh` 中读取 preferences 并传入 `buildUsageDashboard`。读取失败时传 `undefined`，保持现有顺序。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test:worker -- tests/worker/index.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add worker/dashboard.ts worker/index.ts tests/worker/index.test.ts
git commit -m "feat: order dashboard by provider settings"
```

---

### Task 8: 环境示例、文档和端到端验证

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/deployment.md`
- Test: all tests

- [ ] **Step 1: 更新 `.env.example`**

加入：

```dotenv
ADMIN_SETUP_TOKEN="change-me-admin-token"
CREDENTIAL_ENCRYPTION_KEY="32-byte-local-dev-secret-value"
ALIYUN_BAILIAN_PAGE_URL="https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/coding-plan"
ALIYUN_BAILIAN_API_URL=""
ALIYUN_BAILIAN_AUTH_COOKIE=""
```

- [ ] **Step 2: 更新 README**

新增“配置中心”章节，写明：

```md
## 配置中心

访问 `#/settings` 打开独立配置页。首次进入需要输入 `ADMIN_SETUP_TOKEN`，该 token 只保存在浏览器 sessionStorage。

配置页可以管理供应商启停、展示顺序、多账号和连接测试。前端不会读取明文 API Key 或 Cookie；凭据提交到 Worker 后使用 `CREDENTIAL_ENCRYPTION_KEY` 加密，再存入 Supabase。

当前不保存网页登录密码。需要验证码、GitHub、Google 或阿里云网页登录的平台，请从浏览器复制 Cookie 或补充稳定 JSON API URL。
```

- [ ] **Step 3: 更新部署文档**

在 `docs/deployment.md` 增加 Cloudflare secrets：

```powershell
$env:ADMIN_SETUP_TOKEN="..."
$env:ADMIN_SETUP_TOKEN | npx wrangler@4 secret put ADMIN_SETUP_TOKEN

$env:CREDENTIAL_ENCRYPTION_KEY="32-byte-local-dev-secret-value"
$env:CREDENTIAL_ENCRYPTION_KEY | npx wrangler@4 secret put CREDENTIAL_ENCRYPTION_KEY
```

- [ ] **Step 4: 运行全量测试**

Run: `npm run test`

Expected: 所有测试 PASS。

- [ ] **Step 5: 构建**

Run: `npm run build`

Expected: 构建成功；允许 Vite chunk size warning。

- [ ] **Step 6: 部署**

Run: `npm run deploy:worker`

Expected: Wrangler 输出 deployed URL。

- [ ] **Step 7: 线上验证**

Run:

```powershell
$body = @{ sessionKey = ('settings-e2e-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); persist = $false } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri 'https://apimonitor.jarvislee90s.workers.dev/api/refresh' -Method Post -ContentType 'application/json' -Body $body
```

Expected:

- `data.status` 为 `ready` 或 `partial`。
- OpenRouter、OpenCode Go、讯飞 MaaS 仍然可用。
- 阿里云百炼在未配置 API URL 时为 `partial`，配置 API URL 后可返回 `ready`。

- [ ] **Step 8: 提交**

```powershell
git add .env.example README.md docs/deployment.md
git commit -m "docs: describe configurable provider setup"
```

---

## Self-Review

- Spec coverage: 计划覆盖独立配置页、供应商启停、拖拽排序、多账号、Supabase 加密保存、Worker 解密抓取、前端脱敏、阿里云百炼 provider 和 env fallback。
- Placeholder scan: 本计划没有未定项或空泛延后步骤；阿里云百炼第一版明确为 `apiUrl` 可配置的 JSON 抓取，未配置时返回 `partial`。
- Type consistency: provider key 使用 `providerKey`，数据库字段使用 `provider_key`；前端安全账号类型使用 `SafeProviderAccount`；Worker provider id 为 `aliyun-bailian`。
- Risk note: `ADMIN_SETUP_TOKEN` 是当前单用户部署的配置保护边界。若后续开放多人使用，应把 settings API 鉴权替换为 Supabase Auth session + RLS，并移除浏览器 sessionStorage admin token 模式。
