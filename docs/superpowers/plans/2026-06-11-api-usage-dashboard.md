# API 用量聚合看板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个纯云端的 API 与 Coding Plan 用量聚合看板，前端部署在 Cloudflare Pages，刷新与抓取由 Cloudflare Worker/Browser Run 执行，数据与权限放在 Supabase。

**Architecture:** 前端只负责展示、交互、活跃检测和打开原网页；Worker 提供统一 `/api/usage`、`/api/refresh`、`/api/session/*` 接口，并按 2 分钟节流刷新。Supabase Postgres 保存 provider 配置、标准化快照、quota 窗口、模型花费、刷新事件；Supabase Auth 控制前端访问，Worker 使用 service role 写入数据。

**Tech Stack:** Cloudflare Pages, Cloudflare Workers, Durable Object, KV, Browser Run, Supabase Auth, Supabase Postgres, TypeScript, React, Vite, Tailwind CSS, Vitest, Playwright.

---

## 参考源码使用边界

- `references/onwatch`: 参考 provider 聚合、OpenRouter `/api/v1/auth/key`、快照字段和状态模型，不复制 GPL 代码。
- `references/opencode-quota`: 参考 OpenCode Go `workspaceId + auth cookie` 抓取方式、`rolling/weekly/monthly` quota 窗口、错误状态，不复制 MIT 文件到正式代码，重新实现。
- `references/all-api-hub`: 参考“打开原网页/打开用量页”交互和多平台卡片布局。
- `references/codeburn`: 参考 provider adapter 抽象和统一输出结构。
- `references/one-api`: 参考余额查询、渠道健康状态、OpenRouter credits 补充接口。

## 文件结构

- Create: `package.json`  
  项目脚本、依赖声明。创建前确认当前项目无同名文件。
- Create: `tsconfig.json`  
  TypeScript 严格配置。
- Create: `vite.config.ts`  
  前端构建与测试配置。
- Create: `worker/wrangler.toml.example`  
  Cloudflare 配置模板，不包含真实密钥。
- Create: `worker/src/index.ts`  
  Worker 路由入口。
- Create: `worker/src/env.ts`  
  Worker 环境变量类型。
- Create: `worker/src/http.ts`  
  JSON 响应、错误响应、CORS、鉴权辅助。
- Create: `worker/src/durable/refresh-session.ts`  
  2 分钟刷新节流、10 分钟活跃会话状态。
- Create: `worker/src/providers/types.ts`  
  标准 provider adapter 接口与标准化用量类型。
- Create: `worker/src/providers/openrouter.ts`  
  OpenRouter adapter。
- Create: `worker/src/providers/opencode-go.ts`  
  OpenCode Go adapter。
- Create: `worker/src/providers/xfyun-maas.ts`  
  讯飞 MaaS adapter，第一版支持状态检测和可插拔抓取。
- Create: `worker/src/providers/registry.ts`  
  provider 注册与批量刷新。
- Create: `worker/src/supabase/client.ts`  
  Worker 内部 Supabase REST client。
- Create: `worker/src/supabase/repository.ts`  
  快照、窗口、事件写入与读取。
- Create: `worker/src/browser/live-login.ts`  
  Cloudflare Browser Run 登录修复流程抽象。
- Create: `supabase/migrations/202606110001_usage_dashboard.sql`  
  Supabase 数据库表、索引、RLS。
- Create: `src/main.tsx`  
  前端入口。
- Create: `src/App.tsx`  
  页面骨架。
- Create: `src/api/client.ts`  
  前端 API client。
- Create: `src/hooks/useActiveRefresh.ts`  
  活跃检测、2 分钟轮询、10 分钟停止。
- Create: `src/components/ProviderCard.tsx`  
  平台状态卡。
- Create: `src/components/QuotaWindow.tsx`  
  quota 窗口展示。
- Create: `src/components/UsageTrend.tsx`  
  历史趋势图。
- Create: `src/components/ModelSpendTable.tsx`  
  模型花费表。
- Create: `src/components/OriginalLinks.tsx`  
  打开原网页、修复登录态按钮。
- Create: `src/styles.css`  
  Tailwind 基础样式和看板视觉 token。
- Create: `tests/worker/openrouter.test.ts`
- Create: `tests/worker/opencode-go.test.ts`
- Create: `tests/worker/refresh-session.test.ts`
- Create: `tests/frontend/useActiveRefresh.test.tsx`

---

### Task 1: 项目骨架与依赖

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `src/styles.css`

- [ ] **Step 1: 确认不会覆盖根配置文件**

Run: `Test-Path -LiteralPath 'package.json'; Test-Path -LiteralPath 'tsconfig.json'; Test-Path -LiteralPath 'vite.config.ts'`

Expected: 三行都输出 `False`。如果任一输出 `True`，停止并向用户确认是否覆盖。

- [ ] **Step 2: 写入 `package.json`**

```json
{
  "name": "api-usage-dashboard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "worker:test": "vitest run tests/worker",
    "frontend:test": "vitest run tests/frontend"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "@vitejs/plugin-react": "^4.3.1",
    "lucide-react": "^0.468.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "recharts": "^2.12.7"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.2",
    "@testing-library/react": "^15.0.7",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "happy-dom": "^14.12.3",
    "tailwindcss": "^3.4.4",
    "typescript": "^5.5.4",
    "vite": "^5.4.0",
    "vitest": "^2.0.5",
    "wrangler": "^3.72.0"
  }
}
```

- [ ] **Step 3: 写入 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src", "worker", "tests", "vite.config.ts"]
}
```

- [ ] **Step 4: 写入 `vite.config.ts`**

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
  },
});
```

- [ ] **Step 5: 写入最小前端入口**

`src/main.tsx`

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

`src/App.tsx`

```tsx
export function App() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium text-slate-500">ApiMonitor</p>
          <h1 className="text-2xl font-semibold">API 与 Coding Plan 用量看板</h1>
        </header>
      </section>
    </main>
  );
}
```

`src/styles.css`

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
}
```

- [ ] **Step 6: 运行类型检查和构建**

Run: `npm run build`

Expected: 构建通过，生成 `dist` 目录。

- [ ] **Step 7: Commit**

当前目录不是 Git 仓库时跳过。若后续初始化 Git，再提交：

```powershell
git add package.json tsconfig.json vite.config.ts src/main.tsx src/App.tsx src/styles.css
git commit -m "chore: scaffold usage dashboard app"
```

---

### Task 2: Supabase 数据模型

**Files:**
- Create: `supabase/migrations/202606110001_usage_dashboard.sql`

- [ ] **Step 1: 写入迁移**

```sql
create table if not exists public.provider_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  provider text not null check (provider in ('openrouter', 'opencode_go', 'xfyun_maas')),
  display_name text not null,
  original_url text not null,
  secret_ref text not null,
  enabled boolean not null default true,
  health_status text not null default 'unknown' check (health_status in ('unknown', 'ok', 'warning', 'error', 'login_required')),
  last_refresh_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.usage_snapshots (
  id uuid primary key default gen_random_uuid(),
  provider_account_id uuid not null references public.provider_accounts(id) on delete cascade,
  captured_at timestamptz not null default now(),
  provider text not null,
  status text not null check (status in ('ok', 'partial', 'error', 'login_required')),
  currency text,
  total_spend numeric,
  total_tokens numeric,
  total_requests numeric,
  raw jsonb not null default '{}'::jsonb
);

create table if not exists public.quota_windows (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.usage_snapshots(id) on delete cascade,
  window_key text not null,
  label text not null,
  used numeric,
  limit_value numeric,
  used_percent numeric,
  remaining_percent numeric,
  reset_at timestamptz,
  raw jsonb not null default '{}'::jsonb
);

create table if not exists public.model_usage_daily (
  id uuid primary key default gen_random_uuid(),
  provider_account_id uuid not null references public.provider_accounts(id) on delete cascade,
  usage_date date not null,
  provider text not null,
  model text not null,
  spend numeric,
  tokens numeric,
  requests numeric,
  raw jsonb not null default '{}'::jsonb,
  unique(provider_account_id, usage_date, model)
);

create table if not exists public.refresh_events (
  id uuid primary key default gen_random_uuid(),
  provider_account_id uuid references public.provider_accounts(id) on delete set null,
  provider text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('started', 'ok', 'partial', 'error', 'login_required', 'skipped')),
  message text,
  details jsonb not null default '{}'::jsonb
);

create index if not exists idx_provider_accounts_owner on public.provider_accounts(owner_id);
create index if not exists idx_usage_snapshots_account_time on public.usage_snapshots(provider_account_id, captured_at desc);
create index if not exists idx_quota_windows_snapshot on public.quota_windows(snapshot_id);
create index if not exists idx_model_usage_daily_account_date on public.model_usage_daily(provider_account_id, usage_date desc);
create index if not exists idx_refresh_events_account_time on public.refresh_events(provider_account_id, started_at desc);

alter table public.provider_accounts enable row level security;
alter table public.usage_snapshots enable row level security;
alter table public.quota_windows enable row level security;
alter table public.model_usage_daily enable row level security;
alter table public.refresh_events enable row level security;

create policy "provider accounts are visible to owner"
on public.provider_accounts for select
using (auth.uid() = owner_id);

create policy "usage snapshots are visible to provider owner"
on public.usage_snapshots for select
using (
  exists (
    select 1 from public.provider_accounts pa
    where pa.id = usage_snapshots.provider_account_id and pa.owner_id = auth.uid()
  )
);

create policy "quota windows are visible to provider owner"
on public.quota_windows for select
using (
  exists (
    select 1
    from public.usage_snapshots us
    join public.provider_accounts pa on pa.id = us.provider_account_id
    where us.id = quota_windows.snapshot_id and pa.owner_id = auth.uid()
  )
);

create policy "model usage is visible to provider owner"
on public.model_usage_daily for select
using (
  exists (
    select 1 from public.provider_accounts pa
    where pa.id = model_usage_daily.provider_account_id and pa.owner_id = auth.uid()
  )
);

create policy "refresh events are visible to provider owner"
on public.refresh_events for select
using (
  provider_account_id is null
  or exists (
    select 1 from public.provider_accounts pa
    where pa.id = refresh_events.provider_account_id and pa.owner_id = auth.uid()
  )
);
```

- [ ] **Step 2: 本地 SQL 静态检查**

Run: `Select-String -LiteralPath 'supabase\migrations\202606110001_usage_dashboard.sql' -Pattern '待办|待定|service_role'`

Expected: 无输出。

- [ ] **Step 3: 应用迁移**

Run: `supabase db push`

Expected: Supabase CLI 显示迁移成功。若未安装 Supabase CLI，停止并记录“迁移未执行”。

---

### Task 3: Worker 基础路由和环境类型

**Files:**
- Create: `worker/wrangler.toml.example`
- Create: `worker/src/env.ts`
- Create: `worker/src/http.ts`
- Create: `worker/src/index.ts`
- Test: `tests/worker/http.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/worker/http.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { jsonResponse, notFound } from "../../worker/src/http";

describe("worker http helpers", () => {
  it("returns json with cors headers", async () => {
    const response = jsonResponse({ ok: true }, 201);
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("returns structured not found response", async () => {
    const response = notFound();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "接口不存在" },
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run worker:test`

Expected: FAIL，提示无法找到 `worker/src/http`。

- [ ] **Step 3: 写 Worker 基础文件**

`worker/src/env.ts`

```ts
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_ANON_KEY: string;
  SESSION_CACHE: KVNamespace;
  REFRESH_SESSION: DurableObjectNamespace;
}
```

`worker/src/http.ts`

```ts
export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
      ...headers,
    },
  });
}

export function errorResponse(code: string, message: string, status = 400) {
  return jsonResponse({ error: { code, message } }, status);
}

export function notFound() {
  return errorResponse("not_found", "接口不存在", 404);
}
```

`worker/src/index.ts`

```ts
import type { Env } from "./env";
import { jsonResponse, notFound } from "./http";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return jsonResponse({ ok: true });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return jsonResponse({ ok: true, service: "api-usage-dashboard", hasSupabase: Boolean(env.SUPABASE_URL) });
    }

    return notFound();
  },
};
```

`worker/wrangler.toml.example`

```toml
name = "api-usage-dashboard"
main = "worker/src/index.ts"
compatibility_date = "2026-06-11"

[[kv_namespaces]]
binding = "SESSION_CACHE"
id = "replace-with-kv-id"

[[durable_objects.bindings]]
name = "REFRESH_SESSION"
class_name = "RefreshSession"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RefreshSession"]
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run worker:test`

Expected: PASS。

---

### Task 4: Provider 标准类型

**Files:**
- Create: `worker/src/providers/types.ts`
- Test: `tests/worker/provider-types.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/worker/provider-types.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { normalizePercent } from "../../worker/src/providers/types";

describe("provider types", () => {
  it("clamps percent values", () => {
    expect(normalizePercent(-1)).toBe(0);
    expect(normalizePercent(42.5)).toBe(42.5);
    expect(normalizePercent(101)).toBe(100);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run worker:test`

Expected: FAIL，提示 `normalizePercent` 未定义。

- [ ] **Step 3: 写类型与辅助函数**

`worker/src/providers/types.ts`

```ts
export type ProviderId = "openrouter" | "opencode_go" | "xfyun_maas";

export type ProviderStatus = "ok" | "partial" | "error" | "login_required";

export interface ProviderAccount {
  id: string;
  ownerId: string;
  provider: ProviderId;
  displayName: string;
  originalUrl: string;
  secretRef: string;
}

export interface QuotaWindowSnapshot {
  windowKey: string;
  label: string;
  used?: number;
  limitValue?: number;
  usedPercent?: number;
  remainingPercent?: number;
  resetAt?: string;
  raw?: Record<string, unknown>;
}

export interface ModelUsageSnapshot {
  date: string;
  model: string;
  spend?: number;
  tokens?: number;
  requests?: number;
  raw?: Record<string, unknown>;
}

export interface UsageSnapshot {
  provider: ProviderId;
  accountId: string;
  capturedAt: string;
  status: ProviderStatus;
  currency?: string;
  totalSpend?: number;
  totalTokens?: number;
  totalRequests?: number;
  quotaWindows: QuotaWindowSnapshot[];
  modelUsageDaily: ModelUsageSnapshot[];
  raw: Record<string, unknown>;
}

export interface ProviderSecret {
  apiKey?: string;
  workspaceId?: string;
  authCookie?: string;
  sessionCookie?: string;
}

export interface ProviderAdapter {
  id: ProviderId;
  fetch(account: ProviderAccount, secret: ProviderSecret): Promise<UsageSnapshot>;
}

export function normalizePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run worker:test`

Expected: PASS。

---

### Task 5: OpenRouter Adapter

**Files:**
- Create: `worker/src/providers/openrouter.ts`
- Test: `tests/worker/openrouter.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/worker/openrouter.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { fetchOpenRouterUsage } from "../../worker/src/providers/openrouter";

describe("openrouter adapter", () => {
  it("maps auth key usage into a standard snapshot", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            label: "Openrouter-Free",
            usage: 0.04,
            limit: 10,
            limit_remaining: 9.96,
            is_free_tier: false,
            rate_limit: { requests: 20, interval: "10s" },
            usage_daily: 0.01,
            usage_weekly: 0.03,
            usage_monthly: 0.04
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const snapshot = await fetchOpenRouterUsage(
      {
        id: "acc_1",
        ownerId: "user_1",
        provider: "openrouter",
        displayName: "OpenRouter",
        originalUrl: "https://openrouter.ai/activity",
        secretRef: "openrouter",
      },
      { apiKey: "sk-or-v1-test" },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/auth/key",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer sk-or-v1-test" }),
      }),
    );
    expect(snapshot.status).toBe("ok");
    expect(snapshot.totalSpend).toBe(0.04);
    expect(snapshot.quotaWindows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ windowKey: "daily", used: 0.01 }),
        expect.objectContaining({ windowKey: "monthly", used: 0.04 }),
      ]),
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run worker:test`

Expected: FAIL，提示 `fetchOpenRouterUsage` 不存在。

- [ ] **Step 3: 实现 adapter**

`worker/src/providers/openrouter.ts`

```ts
import type { ProviderAccount, ProviderSecret, UsageSnapshot } from "./types";
import { normalizePercent } from "./types";

interface OpenRouterAuthKeyResponse {
  data: {
    label?: string;
    usage?: number;
    limit?: number | null;
    limit_remaining?: number | null;
    is_free_tier?: boolean;
    rate_limit?: { requests?: number; interval?: string };
    usage_daily?: number;
    usage_weekly?: number;
    usage_monthly?: number;
  };
}

export async function fetchOpenRouterUsage(
  account: ProviderAccount,
  secret: ProviderSecret,
  fetcher: typeof fetch = fetch,
): Promise<UsageSnapshot> {
  if (!secret.apiKey) {
    return {
      provider: "openrouter",
      accountId: account.id,
      capturedAt: new Date().toISOString(),
      status: "login_required",
      quotaWindows: [],
      modelUsageDaily: [],
      raw: { error: "missing_api_key" },
    };
  }

  const response = await fetcher("https://openrouter.ai/api/v1/auth/key", {
    method: "GET",
    headers: {
      authorization: `Bearer ${secret.apiKey}`,
      accept: "application/json",
      "user-agent": "ApiMonitor/0.1",
    },
  });

  if (response.status === 401) {
    return buildErrorSnapshot(account, "login_required", "unauthorized");
  }

  if (!response.ok) {
    return buildErrorSnapshot(account, "error", `http_${response.status}`);
  }

  const payload = (await response.json()) as OpenRouterAuthKeyResponse;
  const data = payload.data ?? {};
  const limit = typeof data.limit === "number" ? data.limit : undefined;
  const usage = data.usage ?? 0;
  const usedPercent = limit && limit > 0 ? normalizePercent((usage / limit) * 100) : undefined;

  return {
    provider: "openrouter",
    accountId: account.id,
    capturedAt: new Date().toISOString(),
    status: "ok",
    currency: "USD",
    totalSpend: usage,
    quotaWindows: [
      { windowKey: "daily", label: "今日", used: data.usage_daily ?? 0, raw: { unit: "USD" } },
      { windowKey: "weekly", label: "本周", used: data.usage_weekly ?? 0, raw: { unit: "USD" } },
      {
        windowKey: "monthly",
        label: "本月",
        used: data.usage_monthly ?? 0,
        limitValue: limit,
        usedPercent,
        remainingPercent: typeof usedPercent === "number" ? 100 - usedPercent : undefined,
        raw: { unit: "USD", limit_remaining: data.limit_remaining },
      },
    ],
    modelUsageDaily: [],
    raw: data as Record<string, unknown>,
  };
}

function buildErrorSnapshot(
  account: ProviderAccount,
  status: "error" | "login_required",
  error: string,
): UsageSnapshot {
  return {
    provider: "openrouter",
    accountId: account.id,
    capturedAt: new Date().toISOString(),
    status,
    quotaWindows: [],
    modelUsageDaily: [],
    raw: { error },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run worker:test`

Expected: PASS。

---

### Task 6: OpenCode Go Adapter

**Files:**
- Create: `worker/src/providers/opencode-go.ts`
- Test: `tests/worker/opencode-go.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/worker/opencode-go.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { fetchOpenCodeGoUsage } from "../../worker/src/providers/opencode-go";

describe("opencode go adapter", () => {
  it("parses rolling weekly monthly usage from dashboard html", async () => {
    const html = `
      rollingUsage:$R[1]={usagePercent:0,resetInSec:18000}
      weeklyUsage:$R[2]={resetInSec:338400,usagePercent:26}
      monthlyUsage:$R[3]={usagePercent:13,resetInSec:2512800}
    `;
    const fetchMock = vi.fn(async () => new Response(html, { status: 200 }));

    const snapshot = await fetchOpenCodeGoUsage(
      {
        id: "acc_2",
        ownerId: "user_1",
        provider: "opencode_go",
        displayName: "OpenCode Go",
        originalUrl: "https://opencode.ai/workspace/wrk_123/go",
        secretRef: "opencode_go",
      },
      { workspaceId: "wrk_123", authCookie: "auth-token" },
      fetchMock,
      new Date("2026-06-11T00:00:00.000Z"),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://opencode.ai/workspace/wrk_123/go",
      expect.objectContaining({
        headers: expect.objectContaining({ cookie: "auth=auth-token" }),
      }),
    );
    expect(snapshot.status).toBe("ok");
    expect(snapshot.quotaWindows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ windowKey: "rolling", usedPercent: 0, remainingPercent: 100 }),
        expect.objectContaining({ windowKey: "weekly", usedPercent: 26, remainingPercent: 74 }),
        expect.objectContaining({ windowKey: "monthly", usedPercent: 13, remainingPercent: 87 }),
      ]),
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run worker:test`

Expected: FAIL，提示 `fetchOpenCodeGoUsage` 不存在。

- [ ] **Step 3: 实现 adapter**

`worker/src/providers/opencode-go.ts`

```ts
import type { ProviderAccount, ProviderSecret, QuotaWindowSnapshot, UsageSnapshot } from "./types";
import { normalizePercent } from "./types";

const NUMBER = String.raw`(-?\d+(?:\.\d+)?)`;

const WINDOW_PATTERNS = {
  rolling: {
    label: "5 小时滚动",
    pctFirst: new RegExp(String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*usagePercent:${NUMBER}[^}]*resetInSec:${NUMBER}[^}]*\}`),
    resetFirst: new RegExp(String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*resetInSec:${NUMBER}[^}]*usagePercent:${NUMBER}[^}]*\}`),
  },
  weekly: {
    label: "每周用量",
    pctFirst: new RegExp(String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*usagePercent:${NUMBER}[^}]*resetInSec:${NUMBER}[^}]*\}`),
    resetFirst: new RegExp(String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*resetInSec:${NUMBER}[^}]*usagePercent:${NUMBER}[^}]*\}`),
  },
  monthly: {
    label: "每月用量",
    pctFirst: new RegExp(String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*usagePercent:${NUMBER}[^}]*resetInSec:${NUMBER}[^}]*\}`),
    resetFirst: new RegExp(String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*resetInSec:${NUMBER}[^}]*usagePercent:${NUMBER}[^}]*\}`),
  },
} as const;

export async function fetchOpenCodeGoUsage(
  account: ProviderAccount,
  secret: ProviderSecret,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<UsageSnapshot> {
  if (!secret.workspaceId || !secret.authCookie) {
    return buildOpenCodeError(account, "login_required", "missing_workspace_or_cookie");
  }

  const url = `https://opencode.ai/workspace/${encodeURIComponent(secret.workspaceId)}/go`;
  const response = await fetcher(url, {
    method: "GET",
    headers: {
      accept: "text/html",
      cookie: `auth=${secret.authCookie}`,
      "user-agent": "Mozilla/5.0 ApiMonitor/0.1",
    },
  });

  if (response.status === 401 || response.status === 403) {
    return buildOpenCodeError(account, "login_required", `http_${response.status}`);
  }

  if (!response.ok) {
    return buildOpenCodeError(account, "error", `http_${response.status}`);
  }

  const html = await response.text();
  const quotaWindows = parseOpenCodeGoWindows(html, now);

  if (quotaWindows.length === 0) {
    return buildOpenCodeError(account, "partial", "usage_windows_not_found");
  }

  return {
    provider: "opencode_go",
    accountId: account.id,
    capturedAt: now.toISOString(),
    status: "ok",
    quotaWindows,
    modelUsageDaily: [],
    raw: { source: "dashboard_html" },
  };
}

export function parseOpenCodeGoWindows(html: string, now: Date): QuotaWindowSnapshot[] {
  return Object.entries(WINDOW_PATTERNS).flatMap(([windowKey, config]) => {
    const parsed = parseWindow(html, config.pctFirst, config.resetFirst);
    if (!parsed) return [];

    const usedPercent = normalizePercent(parsed.usagePercent);
    const resetAt = new Date(now.getTime() + Math.max(0, parsed.resetInSec) * 1000).toISOString();

    return [{
      windowKey,
      label: config.label,
      usedPercent,
      remainingPercent: normalizePercent(100 - usedPercent),
      resetAt,
      raw: { resetInSec: parsed.resetInSec },
    }];
  });
}

function parseWindow(html: string, pctFirst: RegExp, resetFirst: RegExp) {
  const pctMatch = pctFirst.exec(html);
  if (pctMatch) {
    return { usagePercent: Number(pctMatch[1]), resetInSec: Number(pctMatch[2]) };
  }

  const resetMatch = resetFirst.exec(html);
  if (resetMatch) {
    return { usagePercent: Number(resetMatch[2]), resetInSec: Number(resetMatch[1]) };
  }

  return null;
}

function buildOpenCodeError(
  account: ProviderAccount,
  status: "error" | "partial" | "login_required",
  error: string,
): UsageSnapshot {
  return {
    provider: "opencode_go",
    accountId: account.id,
    capturedAt: new Date().toISOString(),
    status,
    quotaWindows: [],
    modelUsageDaily: [],
    raw: { error },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run worker:test`

Expected: PASS。

---

### Task 7: 讯飞 MaaS Adapter 占位与登录状态

**Files:**
- Create: `worker/src/providers/xfyun-maas.ts`
- Test: `tests/worker/xfyun-maas.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/worker/xfyun-maas.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { fetchXfyunMaasUsage } from "../../worker/src/providers/xfyun-maas";

describe("xfyun maas adapter", () => {
  it("reports login_required when no session is configured", async () => {
    const snapshot = await fetchXfyunMaasUsage({
      id: "acc_3",
      ownerId: "user_1",
      provider: "xfyun_maas",
      displayName: "讯飞 MaaS",
      originalUrl: "https://maas.xfyun.cn/packageSubscription",
      secretRef: "xfyun_maas",
    }, {});

    expect(snapshot.status).toBe("login_required");
    expect(snapshot.raw).toEqual({ error: "missing_session_cookie" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run worker:test`

Expected: FAIL，提示 `fetchXfyunMaasUsage` 不存在。

- [ ] **Step 3: 实现第一版 adapter**

`worker/src/providers/xfyun-maas.ts`

```ts
import type { ProviderAccount, ProviderSecret, UsageSnapshot } from "./types";

export async function fetchXfyunMaasUsage(
  account: ProviderAccount,
  secret: ProviderSecret,
): Promise<UsageSnapshot> {
  if (!secret.sessionCookie) {
    return {
      provider: "xfyun_maas",
      accountId: account.id,
      capturedAt: new Date().toISOString(),
      status: "login_required",
      quotaWindows: [],
      modelUsageDaily: [],
      raw: { error: "missing_session_cookie" },
    };
  }

  return {
    provider: "xfyun_maas",
    accountId: account.id,
    capturedAt: new Date().toISOString(),
    status: "partial",
    quotaWindows: [],
    modelUsageDaily: [],
    raw: {
      message: "xfyun_maas_adapter_ready_for_browser_run_or_json_endpoint",
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run worker:test`

Expected: PASS。

---

### Task 8: Provider Registry 与批量刷新

**Files:**
- Create: `worker/src/providers/registry.ts`
- Test: `tests/worker/registry.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/worker/registry.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { getProviderAdapter } from "../../worker/src/providers/registry";

describe("provider registry", () => {
  it("returns adapters for supported providers", () => {
    expect(getProviderAdapter("openrouter").id).toBe("openrouter");
    expect(getProviderAdapter("opencode_go").id).toBe("opencode_go");
    expect(getProviderAdapter("xfyun_maas").id).toBe("xfyun_maas");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run worker:test`

Expected: FAIL，提示 `getProviderAdapter` 不存在。

- [ ] **Step 3: 实现 registry**

`worker/src/providers/registry.ts`

```ts
import { fetchOpenRouterUsage } from "./openrouter";
import { fetchOpenCodeGoUsage } from "./opencode-go";
import { fetchXfyunMaasUsage } from "./xfyun-maas";
import type { ProviderAdapter, ProviderId } from "./types";

const adapters: Record<ProviderId, ProviderAdapter> = {
  openrouter: {
    id: "openrouter",
    fetch: fetchOpenRouterUsage,
  },
  opencode_go: {
    id: "opencode_go",
    fetch: fetchOpenCodeGoUsage,
  },
  xfyun_maas: {
    id: "xfyun_maas",
    fetch: fetchXfyunMaasUsage,
  },
};

export function getProviderAdapter(provider: ProviderId): ProviderAdapter {
  return adapters[provider];
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run worker:test`

Expected: PASS。

---

### Task 9: Supabase Repository

**Files:**
- Create: `worker/src/supabase/client.ts`
- Create: `worker/src/supabase/repository.ts`
- Test: `tests/worker/repository.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/worker/repository.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { createUsageRepository } from "../../worker/src/supabase/repository";

describe("usage repository", () => {
  it("loads provider accounts through Supabase REST", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ id: "acc_1", provider: "openrouter" }]), { status: 200 }),
    );
    const repo = createUsageRepository({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-role",
      fetcher: fetchMock,
    });

    const rows = await repo.listEnabledProviderAccounts();
    expect(rows).toEqual([{ id: "acc_1", provider: "openrouter" }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.supabase.co/rest/v1/provider_accounts?enabled=eq.true&select=*",
      expect.objectContaining({
        headers: expect.objectContaining({ apikey: "service-role" }),
      }),
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run worker:test`

Expected: FAIL，提示 repository 不存在。

- [ ] **Step 3: 实现 repository**

`worker/src/supabase/client.ts`

```ts
export interface SupabaseRestOptions {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetcher?: typeof fetch;
}

export function createSupabaseRestClient(options: SupabaseRestOptions) {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = options.supabaseUrl.replace(/\/$/, "");

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetcher(`${baseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: options.serviceRoleKey,
        authorization: `Bearer ${options.serviceRoleKey}`,
        "content-type": "application/json",
        prefer: "return=representation",
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw new Error(`Supabase REST ${response.status}: ${await response.text()}`);
    }

    return (await response.json()) as T;
  }

  return { request };
}
```

`worker/src/supabase/repository.ts`

```ts
import { createSupabaseRestClient, type SupabaseRestOptions } from "./client";
import type { UsageSnapshot } from "../providers/types";

export function createUsageRepository(options: SupabaseRestOptions) {
  const client = createSupabaseRestClient(options);

  return {
    listEnabledProviderAccounts() {
      return client.request("provider_accounts?enabled=eq.true&select=*");
    },

    insertSnapshot(snapshot: UsageSnapshot) {
      return client.request("usage_snapshots", {
        method: "POST",
        body: JSON.stringify({
          provider_account_id: snapshot.accountId,
          captured_at: snapshot.capturedAt,
          provider: snapshot.provider,
          status: snapshot.status,
          currency: snapshot.currency ?? null,
          total_spend: snapshot.totalSpend ?? null,
          total_tokens: snapshot.totalTokens ?? null,
          total_requests: snapshot.totalRequests ?? null,
          raw: snapshot.raw,
        }),
      });
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run worker:test`

Expected: PASS。

---

### Task 10: Durable Object 刷新节流

**Files:**
- Create: `worker/src/durable/refresh-session.ts`
- Modify: `worker/src/index.ts`
- Test: `tests/worker/refresh-session.test.ts`

- [ ] **Step 1: 写纯函数测试**

`tests/worker/refresh-session.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { shouldRefresh } from "../../worker/src/durable/refresh-session";

describe("refresh session", () => {
  it("refreshes when no previous refresh exists", () => {
    expect(shouldRefresh(undefined, 0, 120000)).toBe(true);
  });

  it("skips refresh inside interval", () => {
    expect(shouldRefresh(1000, 60000, 120000)).toBe(false);
  });

  it("refreshes after interval", () => {
    expect(shouldRefresh(1000, 130000, 120000)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run worker:test`

Expected: FAIL，提示 `shouldRefresh` 不存在。

- [ ] **Step 3: 实现 Durable Object**

`worker/src/durable/refresh-session.ts`

```ts
import { jsonResponse } from "../http";

const REFRESH_INTERVAL_MS = 120_000;
const ACTIVE_TTL_MS = 600_000;

export function shouldRefresh(lastRefreshAt: number | undefined, now: number, intervalMs = REFRESH_INTERVAL_MS) {
  return typeof lastRefreshAt !== "number" || now - lastRefreshAt >= intervalMs;
}

export class RefreshSession {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();

    if (url.pathname.endsWith("/heartbeat")) {
      await this.state.storage.put("lastActiveAt", now);
      return jsonResponse({ ok: true, activeUntil: new Date(now + ACTIVE_TTL_MS).toISOString() });
    }

    if (url.pathname.endsWith("/should-refresh")) {
      const lastActiveAt = await this.state.storage.get<number>("lastActiveAt");
      const lastRefreshAt = await this.state.storage.get<number>("lastRefreshAt");
      const active = typeof lastActiveAt === "number" && now - lastActiveAt <= ACTIVE_TTL_MS;
      const refresh = active && shouldRefresh(lastRefreshAt, now);

      if (refresh) {
        await this.state.storage.put("lastRefreshAt", now);
      }

      return jsonResponse({ active, refresh, lastRefreshAt });
    }

    return jsonResponse({ error: { code: "not_found", message: "会话接口不存在" } }, 404);
  }
}
```

`worker/src/index.ts` 追加导出：

```ts
export { RefreshSession } from "./durable/refresh-session";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run worker:test`

Expected: PASS。

---

### Task 11: Worker Usage API

**Files:**
- Modify: `worker/src/index.ts`

- [ ] **Step 1: 增加 `/api/usage` 和 `/api/refresh` 路由**

在 `worker/src/index.ts` 中加入：

```ts
import { createUsageRepository } from "./supabase/repository";
import { getProviderAdapter } from "./providers/registry";
import type { ProviderAccount, ProviderSecret } from "./providers/types";
```

在 `fetch` 中加入：

```ts
    if (url.pathname === "/api/usage") {
      const repo = createUsageRepository({
        supabaseUrl: env.SUPABASE_URL,
        serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      });
      const accounts = await repo.listEnabledProviderAccounts();
      return jsonResponse({ accounts });
    }

    if (url.pathname === "/api/refresh" && request.method === "POST") {
      const repo = createUsageRepository({
        supabaseUrl: env.SUPABASE_URL,
        serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      });
      const accounts = (await repo.listEnabledProviderAccounts()) as ProviderAccount[];
      const snapshots = [];

      for (const account of accounts) {
        const adapter = getProviderAdapter(account.provider);
        const secret = await loadProviderSecret(env, account.secretRef);
        const snapshot = await adapter.fetch(account, secret);
        await repo.insertSnapshot(snapshot);
        snapshots.push(snapshot);
      }

      return jsonResponse({ snapshots });
    }
```

在文件末尾加入：

```ts
async function loadProviderSecret(env: Env, secretRef: string): Promise<ProviderSecret> {
  const raw = await env.SESSION_CACHE.get(`secret:${secretRef}`, "json");
  return (raw ?? {}) as ProviderSecret;
}
```

- [ ] **Step 2: 运行测试**

Run: `npm run worker:test`

Expected: PASS。

---

### Task 12: 前端活跃刷新 Hook

**Files:**
- Create: `src/hooks/useActiveRefresh.ts`
- Test: `tests/frontend/useActiveRefresh.test.tsx`

- [ ] **Step 1: 写失败测试**

`tests/frontend/useActiveRefresh.test.tsx`

```tsx
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useActiveRefresh } from "../../src/hooks/useActiveRefresh";

describe("useActiveRefresh", () => {
  it("stops polling after idle timeout", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    renderHook(() => useActiveRefresh(refresh, { intervalMs: 120000, idleMs: 600000 }));

    act(() => {
      vi.advanceTimersByTime(120000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(600000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run frontend:test`

Expected: FAIL，提示 hook 不存在。

- [ ] **Step 3: 实现 hook**

`src/hooks/useActiveRefresh.ts`

```ts
import { useEffect, useRef } from "react";

interface ActiveRefreshOptions {
  intervalMs: number;
  idleMs: number;
}

export function useActiveRefresh(
  refresh: () => void | Promise<void>,
  options: ActiveRefreshOptions = { intervalMs: 120000, idleMs: 600000 },
) {
  const lastActiveAtRef = useRef(Date.now());
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const markActive = () => {
      lastActiveAtRef.current = Date.now();
    };

    const events = ["click", "keydown", "scroll", "touchstart", "mousemove"];
    events.forEach((eventName) => window.addEventListener(eventName, markActive, { passive: true }));

    const timer = window.setInterval(() => {
      if (Date.now() - lastActiveAtRef.current >= options.idleMs) return;
      void refreshRef.current();
    }, options.intervalMs);

    return () => {
      window.clearInterval(timer);
      events.forEach((eventName) => window.removeEventListener(eventName, markActive));
    };
  }, [options.idleMs, options.intervalMs]);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run frontend:test`

Expected: PASS。

---

### Task 13: 前端 API Client 与主页面

**Files:**
- Create: `src/api/client.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: 写 API client**

`src/api/client.ts`

```ts
export interface UsageResponse {
  accounts: unknown[];
}

export async function getUsage(): Promise<UsageResponse> {
  const response = await fetch("/api/usage");
  if (!response.ok) {
    throw new Error(`读取用量失败：${response.status}`);
  }
  return (await response.json()) as UsageResponse;
}

export async function refreshUsage(): Promise<void> {
  const response = await fetch("/api/refresh", { method: "POST" });
  if (!response.ok) {
    throw new Error(`刷新用量失败：${response.status}`);
  }
}
```

- [ ] **Step 2: 修改 `src/App.tsx` 使用活跃刷新**

```tsx
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getUsage, refreshUsage } from "./api/client";
import { useActiveRefresh } from "./hooks/useActiveRefresh";

export function App() {
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<unknown[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const usage = await getUsage();
      setAccounts(usage.accounts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取用量失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await refreshUsage();
    await load();
  }, [load]);

  useActiveRefresh(refresh);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6">
        <header className="flex flex-col gap-3 border-b border-slate-200 pb-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-500">ApiMonitor</p>
            <h1 className="text-2xl font-semibold">API 与 Coding Plan 用量看板</h1>
          </div>
          <button
            className="inline-flex h-10 items-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-medium text-white"
            onClick={() => void refresh()}
          >
            <RefreshCw className="h-4 w-4" />
            刷新
          </button>
        </header>

        {error ? <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}
        {loading ? <div className="text-sm text-slate-500">正在读取用量...</div> : null}

        <section className="grid gap-4 md:grid-cols-3">
          {accounts.map((account, index) => (
            <article key={index} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
              <pre className="overflow-auto text-xs text-slate-700">{JSON.stringify(account, null, 2)}</pre>
            </article>
          ))}
        </section>
      </section>
    </main>
  );
}
```

- [ ] **Step 3: 运行前端测试和构建**

Run: `npm run frontend:test; npm run build`

Expected: 测试与构建均通过。

---

### Task 14: 看板组件拆分

**Files:**
- Create: `src/components/ProviderCard.tsx`
- Create: `src/components/QuotaWindow.tsx`
- Create: `src/components/UsageTrend.tsx`
- Create: `src/components/ModelSpendTable.tsx`
- Create: `src/components/OriginalLinks.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: 写 `QuotaWindow`**

```tsx
interface QuotaWindowProps {
  label: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetAt?: string;
}

export function QuotaWindow({ label, usedPercent, remainingPercent, resetAt }: QuotaWindowProps) {
  const pct = Math.max(0, Math.min(100, usedPercent ?? 0));
  return (
    <div className="flex flex-col gap-2 rounded-md border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-slate-700">{label}</span>
        <span className="text-sm tabular-nums text-slate-500">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full bg-blue-600" style={{ width: `${pct}%` }} />
      </div>
      <div className="text-xs text-slate-500">
        剩余 {typeof remainingPercent === "number" ? `${remainingPercent.toFixed(0)}%` : "未知"}
        {resetAt ? ` · 重置 ${new Date(resetAt).toLocaleString()}` : ""}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 写 `ProviderCard`**

```tsx
import { ExternalLink } from "lucide-react";
import { QuotaWindow } from "./QuotaWindow";

interface ProviderCardProps {
  name: string;
  status: string;
  originalUrl: string;
  quotaWindows: Array<{
    label: string;
    usedPercent?: number;
    remainingPercent?: number;
    resetAt?: string;
  }>;
}

export function ProviderCard({ name, status, originalUrl, quotaWindows }: ProviderCardProps) {
  return (
    <article className="flex flex-col gap-4 rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{name}</h2>
          <p className="text-sm text-slate-500">{status}</p>
        </div>
        <a
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-600"
          href={originalUrl}
          target="_blank"
          rel="noreferrer"
          title="打开原网页"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      </div>
      <div className="grid gap-3">
        {quotaWindows.map((window) => (
          <QuotaWindow key={window.label} {...window} />
        ))}
      </div>
    </article>
  );
}
```

- [ ] **Step 3: 写占位趋势和表格组件**

`src/components/UsageTrend.tsx`

```tsx
export function UsageTrend() {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-base font-semibold">历史趋势</h2>
      <p className="mt-2 text-sm text-slate-500">接入历史快照后展示 24 小时、7 天、30 天趋势。</p>
    </section>
  );
}
```

`src/components/ModelSpendTable.tsx`

```tsx
export function ModelSpendTable() {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-base font-semibold">模型花费</h2>
      <p className="mt-2 text-sm text-slate-500">接入 OpenRouter activity 与 OpenCode 模型花费后展示。</p>
    </section>
  );
}
```

`src/components/OriginalLinks.tsx`

```tsx
export function OriginalLinks() {
  const links = [
    ["讯飞 MaaS", "https://maas.xfyun.cn/packageSubscription"],
    ["OpenCode Go", "https://opencode.ai/workspace/wrk_01KTNPYQAX7HWSC5B04H1NEBRG/go"],
    ["OpenRouter", "https://openrouter.ai/activity"],
  ];

  return (
    <section className="flex flex-wrap gap-2">
      {links.map(([label, href]) => (
        <a key={href} className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700" href={href} target="_blank" rel="noreferrer">
          {label}
        </a>
      ))}
    </section>
  );
}
```

- [ ] **Step 4: 在 `App.tsx` 使用组件**

把 JSON `pre` 卡片替换为 `ProviderCard`，并加入 `OriginalLinks`、`UsageTrend`、`ModelSpendTable`。对未知后端数据先用安全空数组转换，避免渲染崩溃。

- [ ] **Step 5: 运行构建**

Run: `npm run build`

Expected: PASS。

---

### Task 15: Cloudflare Browser Run 登录修复接口

**Files:**
- Create: `worker/src/browser/live-login.ts`
- Modify: `worker/src/index.ts`

- [ ] **Step 1: 写接口抽象**

`worker/src/browser/live-login.ts`

```ts
export interface LiveLoginSession {
  provider: string;
  loginUrl: string;
  liveViewUrl: string;
  expiresAt: string;
}

export async function createLiveLoginSession(provider: string, loginUrl: string): Promise<LiveLoginSession> {
  return {
    provider,
    loginUrl,
    liveViewUrl: loginUrl,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
}
```

- [ ] **Step 2: 增加 `/api/session/live-login`**

在 `worker/src/index.ts` 中加入：

```ts
import { createLiveLoginSession } from "./browser/live-login";
```

在 `fetch` 中加入：

```ts
    if (url.pathname === "/api/session/live-login" && request.method === "POST") {
      const body = (await request.json()) as { provider?: string; loginUrl?: string };
      if (!body.provider || !body.loginUrl) {
        return jsonResponse({ error: { code: "bad_request", message: "缺少 provider 或 loginUrl" } }, 400);
      }
      return jsonResponse(await createLiveLoginSession(body.provider, body.loginUrl));
    }
```

- [ ] **Step 3: 后续接入真实 Browser Run**

把 `createLiveLoginSession` 的占位实现替换为 Cloudflare Browser Run 调用，打开目标页面，返回 Live View URL，并在用户登录完成后把 cookie/storage state 写入 KV。实现前先阅读 Cloudflare Browser Run 当前文档。

---

### Task 16: 部署配置与密钥录入说明

**Files:**
- Create: `docs/deployment.md`

- [ ] **Step 1: 写部署文档**

`docs/deployment.md`

```md
# 部署说明

## 环境变量

Cloudflare Worker 需要：

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`

不要把真实密钥提交到仓库。

## KV Secret 格式

OpenRouter:

```json
{
  "apiKey": "sk-or-v1-..."
}
```

OpenCode Go:

```json
{
  "workspaceId": "wrk_...",
  "authCookie": "..."
}
```

讯飞 MaaS:

```json
{
  "sessionCookie": "..."
}
```

## 刷新策略

前端打开后调用 `/api/usage`，用户活跃时每 2 分钟调用 `/api/refresh`。前端 10 分钟无交互后停止轮询。Worker Durable Object 也会按 2 分钟节流，避免多标签重复刷新。

## 原网页入口

前端保留三个原网页按钮：

- 讯飞 MaaS: `https://maas.xfyun.cn/packageSubscription`
- OpenCode Go: `https://opencode.ai/workspace/wrk_01KTNPYQAX7HWSC5B04H1NEBRG/go`
- OpenRouter: `https://openrouter.ai/activity`
```

- [ ] **Step 2: 检查文档不含真实密钥**

Run: `Select-String -LiteralPath 'docs\deployment.md' -Pattern 'sk-or-v1-[A-Za-z0-9]|eyJ|BEGIN PRIVATE KEY|service_role_[A-Za-z0-9]'`

Expected: 无输出。

---

## 验证清单

- [ ] `npm run test` 通过。
- [ ] `npm run build` 通过。
- [ ] Supabase migration 已应用，RLS 已启用。
- [ ] OpenRouter 使用测试 key 能返回标准化 snapshot。
- [ ] OpenCode Go 使用测试 cookie 能返回 rolling/weekly/monthly quota。
- [ ] 讯飞 MaaS 在无 session 时显示 `login_required`，前端提供打开原网页和修复登录态入口。
- [ ] 前端 2 分钟刷新一次，10 分钟无交互停止轮询。
- [ ] 前端移动端宽度下没有文本重叠，Provider 卡片可纵向浏览。

## Self-Review

- Spec coverage: B 方案的 Cloudflare Pages、Worker、Browser Run、Supabase Auth/Postgres、2 分钟节流、10 分钟活跃停止、打开原网页均有任务覆盖。
- Placeholder scan: 文档没有未定义占位，讯飞 adapter 的第一版范围明确为登录状态与可插拔抓取。
- Type consistency: provider id 使用 `openrouter | opencode_go | xfyun_maas`，数据库 check 约束、TypeScript 类型和 registry 保持一致。
