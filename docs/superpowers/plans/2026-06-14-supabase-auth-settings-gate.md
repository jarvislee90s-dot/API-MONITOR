# Supabase Auth Settings Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Supabase 邮箱密码登录态替代配置页里的手填 `Admin Token`，让登录用户才能访问看板和配置，并按当前用户读写供应商账号。

**Architecture:** 前端启动时从 Worker 获取公开 Supabase Auth 配置，创建浏览器端 Supabase client，维护登录/登出/会话恢复状态。所有前端 API 请求统一携带 `Authorization: Bearer <access_token>`；Worker 验证 Supabase JWT 并把当前 `userId` 注入 settings repository，敏感凭据仍只在 Worker 用 `service_role` 写入和读取。

**Tech Stack:** React + TypeScript + Vite、`@supabase/supabase-js`、Cloudflare Worker、Supabase Auth、Supabase Postgres RLS、Vitest、Testing Library。

---

## 需求边界

- 不再让用户手填 `Admin Token` 才能新增或编辑供应商账号。
- 未登录用户只能看到登录页，不能访问 `#/` 看板或 `#/settings` 配置页。
- 登录后前端请求 Worker 时自动带 Supabase access token。
- Worker settings API 不再校验 `x-api-monitor-admin-token`，改为校验 Supabase Bearer token。
- repository 所有 settings 读写都使用当前登录用户 `userId`，不能再使用固定 `SUPABASE_USER_ID`。
- `SUPABASE_SERVICE_ROLE_KEY` 仍只允许存在 Worker 端，前端不能接触。
- 公开给前端的只允许是 `SUPABASE_URL` 和 Supabase publishable/anon key。
- 本计划不改 `.env`、`wrangler.toml`、`package.json`；如部署环境缺少变量，由用户在 Cloudflare 后台或 Wrangler secret 中配置。

## 文件结构

- Create: `frontend/src/auth/auth-client.ts`
  - 封装浏览器 Supabase Auth client、登录、登出、会话监听、获取 access token。
- Create: `frontend/src/auth/login-page.tsx`
  - 登录页 UI，邮箱密码登录，显示错误和加载状态。
- Create: `tests/frontend/authClient.test.ts`
  - 验证 Auth client 会从 Worker 读取公开配置，不泄露 service role。
- Create: `tests/frontend/loginPage.test.tsx`
  - 验证登录页提交、错误提示、登出入口。
- Modify: `frontend/src/api/client.ts`
  - 增加 `/api/auth/config` 请求；把 `authTokenProvider` 注入到所有 API 请求；移除 settings 方法的 `adminToken` 参数。
- Modify: `frontend/src/App.tsx`
  - 增加 Auth gate；未登录展示 `LoginPage`；登录后正常展示看板和配置页。
- Modify: `frontend/src/settings/settings-page.tsx`
  - 删除 `sessionStorage` 中的 `api-monitor-admin-token`、`Admin Token` 输入区、`requestAdminToken()` 逻辑；所有操作直接调用已带登录态的 API。
- Modify: `frontend/src/settings/provider-account-panel.tsx`
  - 把“需要 Admin Token 后才能读取账号和保存配置。”改为登录态语义或移除。
- Modify: `worker/types.ts`
  - 增加公开 Auth 配置环境变量，例如 `SUPABASE_ANON_KEY?: string` 或 `SUPABASE_PUBLISHABLE_KEY?: string`。
- Modify: `worker/index.ts`
  - 增加 `GET /api/auth/config` 公开路由。
- Create: `worker/auth.ts`
  - 解析 `Authorization` header，用 Supabase Auth `getUser(jwt)` 验证用户，返回 `{ userId, email }`。
- Modify: `worker/settings/routes.ts`
  - 用 `requireUser()` 替换 `requireAdmin()`，把 `userId` 传给 repository。
- Modify: `worker/settings/repository.ts`
  - 所有 settings 方法新增 `userId` 参数，读写时使用参数，不再读取 `env.SUPABASE_USER_ID`。
- Modify: `tests/frontend/apiClient.test.ts`
  - 更新 API client 测试，从 admin header 改为 bearer token。
- Modify: `tests/frontend/settingsPage.test.tsx`
  - 删除 Admin Token 相关断言，新增“登录后可直接新增/编辑账号”断言。
- Modify: `tests/worker/settings-routes.test.ts`
  - 更新 settings route 鉴权测试：无 Bearer token 401、无效 token 401、有效 token 使用当前 user id。
- Modify: `tests/worker/index.test.ts`
  - 增加 `/api/auth/config` 测试；必要时更新仍依赖 `SUPABASE_USER_ID` 的持久化测试。

---

### Task 1: Worker Auth Config Endpoint

**Files:**
- Modify: `worker/types.ts`
- Modify: `worker/index.ts`
- Modify: `tests/worker/index.test.ts`

- [ ] **Step 1: Write failing test for public Auth config**

在 `tests/worker/index.test.ts` 增加测试，验证 Worker 只返回公开配置：

```ts
it("returns public Supabase auth config without service credentials", async () => {
  const response = await worker.fetch(
    new Request("https://api-monitor.local/api/auth/config"),
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "anon-public-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
    } as never,
  );

  await expect(response.json()).resolves.toEqual({
    ok: true,
    data: {
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon-public-key",
    },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd run test:worker -- tests/worker/index.test.ts`

Expected: FAIL because `/api/auth/config` does not exist yet.

- [ ] **Step 3: Add Worker env type**

在 `worker/types.ts` 的 `Env` 中加入公开 key 字段：

```ts
SUPABASE_ANON_KEY?: string;
SUPABASE_PUBLISHABLE_KEY?: string;
```

- [ ] **Step 4: Implement `/api/auth/config`**

在 `worker/index.ts` 主路由中，放在静态资源 fallback 之前：

```ts
if (url.pathname === "/api/auth/config" && request.method === "GET") {
  const publicKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY;
  if (!env.SUPABASE_URL || !publicKey) {
    return errorResponse(500, "missing_auth_config", "Supabase auth config is not configured");
  }

  return successResponse({
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: publicKey,
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm.cmd run test:worker -- tests/worker/index.test.ts`

Expected: PASS for the new Auth config test.

- [ ] **Step 6: Commit**

Run:

```powershell
git add worker/types.ts worker/index.ts tests/worker/index.test.ts
git commit -m "feat: expose public supabase auth config"
```

---

### Task 2: API Client Bearer Token Injection

**Files:**
- Modify: `frontend/src/api/client.ts`
- Modify: `tests/frontend/apiClient.test.ts`

- [ ] **Step 1: Write failing tests for auth config and bearer headers**

在 `tests/frontend/apiClient.test.ts` 替换 admin token 测试，新增：

```ts
it("loads public auth config from the worker", async () => {
  const fetcher = vi.fn(async () =>
    new Response(
      JSON.stringify({
        ok: true,
        data: {
          supabaseUrl: "https://project.supabase.co",
          supabaseAnonKey: "anon-public-key",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

  const api = createApiClient({ fetcher: fetcher as typeof fetch });

  await expect(api.getAuthConfig()).resolves.toEqual({
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon-public-key",
  });
  expect(fetcher).toHaveBeenCalledWith(
    "/api/auth/config",
    expect.objectContaining({ method: "GET" }),
  );
});

it("sends bearer token when reading and saving provider settings", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/settings/providers") && init?.method === "GET") {
      return new Response(JSON.stringify({ ok: true, data: { catalog: [], preferences: [], accounts: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/settings/providers") && init?.method === "PUT") {
      return new Response(JSON.stringify({ ok: true, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });

  const api = createApiClient({
    fetcher: fetcher as typeof fetch,
    authTokenProvider: async () => "user-access-token",
  });

  await api.getProviderSettings();
  await api.saveProviderPreferences([
    { providerKey: "openrouter", enabled: true, displayOrder: 1, activeProviderAccountId: null },
  ]);

  expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
    Authorization: "Bearer user-access-token",
  });
  expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
    Authorization: "Bearer user-access-token",
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm.cmd run test:frontend -- tests/frontend/apiClient.test.ts`

Expected: FAIL because `getAuthConfig` and `authTokenProvider` do not exist yet.

- [ ] **Step 3: Extend API client options**

在 `frontend/src/api/client.ts` 增加类型：

```ts
export interface AuthConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  headers?: HeadersInit;
  authTokenProvider?: () => Promise<string | null>;
}
```

- [ ] **Step 4: Add authenticated header helper**

在 `createApiClient()` 内部 `headers` 声明后加入：

```ts
async function createRequestHeaders(): Promise<HeadersInit> {
  const token = options.authTokenProvider ? await options.authTokenProvider() : null;
  if (!token) return headers;

  return {
    ...headers,
    Authorization: `Bearer ${token}`,
  };
}
```

- [ ] **Step 5: Add `getAuthConfig()` and remove settings admin token arguments**

把 settings API 方法改成如下签名和 header：

```ts
async getAuthConfig(): Promise<AuthConfig> {
  const payload = await requestJson<AuthConfig | ApiEnvelope<AuthConfig>>(
    fetcher,
    buildUrl(options.baseUrl, "/api/auth/config"),
    {
      method: "GET",
      credentials: "include",
      headers,
    },
  );

  return unwrapEnvelope(payload);
},

async getProviderSettings(): Promise<ProviderSettingsPayload> {
  const payload = await requestJson<ProviderSettingsPayload | ApiEnvelope<ProviderSettingsPayload>>(
    fetcher,
    buildUrl(options.baseUrl, "/api/settings/providers"),
    {
      method: "GET",
      credentials: "include",
      headers: await createRequestHeaders(),
    },
  );

  return unwrapEnvelope(payload);
},

async saveProviderPreferences(preferences: ProviderPreference[]): Promise<ProviderPreference[]> {
  const payload = await requestJson<ProviderPreference[] | ApiEnvelope<ProviderPreference[]>>(
    fetcher,
    buildUrl(options.baseUrl, "/api/settings/providers"),
    {
      method: "PUT",
      credentials: "include",
      headers: await createRequestHeaders(),
      body: JSON.stringify({ providers: preferences }),
    },
  );

  return unwrapEnvelope(payload);
},
```

同样更新：

```ts
async saveProviderAccount(account: ProviderAccountInput): Promise<{ id: string }>
async testProviderAccount(accountId: string): Promise<{ ok: boolean; status: string; summary: string }>
async updateProviderAccountDisplay(
  accountId: string,
  input: { homepageEnabled: boolean; homepageOrder: number },
): Promise<{ id: string; homepageEnabled: boolean; homepageOrder: number }>
```

这些方法都使用 `headers: await createRequestHeaders()`，不再发送 `x-api-monitor-admin-token`。

- [ ] **Step 6: Run tests to verify pass**

Run: `npm.cmd run test:frontend -- tests/frontend/apiClient.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add frontend/src/api/client.ts tests/frontend/apiClient.test.ts
git commit -m "feat: send supabase bearer token to api"
```

---

### Task 3: Frontend Auth Client and Login Page

**Files:**
- Create: `frontend/src/auth/auth-client.ts`
- Create: `frontend/src/auth/login-page.tsx`
- Create: `tests/frontend/authClient.test.ts`
- Create: `tests/frontend/loginPage.test.tsx`

- [ ] **Step 1: Write failing Auth client test**

Create `tests/frontend/authClient.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createBrowserAuthClient } from "../../frontend/src/auth/auth-client";

describe("browser auth client", () => {
  it("loads a session and returns its access token", async () => {
    const supabase = {
      auth: {
        getSession: vi.fn(async () => ({
          data: { session: { access_token: "access-token", user: { id: "user-1", email: "me@example.com" } } },
          error: null,
        })),
        onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
        signInWithPassword: vi.fn(),
        signOut: vi.fn(),
      },
    };

    const auth = createBrowserAuthClient(supabase as never);

    await expect(auth.getSession()).resolves.toEqual({
      accessToken: "access-token",
      user: { id: "user-1", email: "me@example.com" },
    });
    await expect(auth.getAccessToken()).resolves.toBe("access-token");
  });
});
```

- [ ] **Step 2: Write failing Login page test**

Create `tests/frontend/loginPage.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoginPage } from "../../frontend/src/auth/login-page";

describe("LoginPage", () => {
  it("submits email and password", async () => {
    const onSignIn = vi.fn(async () => undefined);

    render(<LoginPage onSignIn={onSignIn} loading={false} error={null} />);

    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "me@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret-password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => {
      expect(onSignIn).toHaveBeenCalledWith("me@example.com", "secret-password");
    });
  });

  it("shows login errors", () => {
    render(<LoginPage onSignIn={vi.fn()} loading={false} error="邮箱或密码不正确" />);

    expect(screen.getByText("邮箱或密码不正确")).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npm.cmd run test:frontend -- tests/frontend/authClient.test.ts tests/frontend/loginPage.test.tsx`

Expected: FAIL because files do not exist.

- [ ] **Step 4: Implement Auth client**

Create `frontend/src/auth/auth-client.ts`:

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AuthConfig } from "../api/client";

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface AppAuthSession {
  accessToken: string;
  user: AuthUser;
}

type SupabaseLike = Pick<SupabaseClient, "auth">;

function toAppSession(session: {
  access_token?: string;
  user?: { id?: string; email?: string | null };
} | null): AppAuthSession | null {
  if (!session?.access_token || !session.user?.id) return null;
  return {
    accessToken: session.access_token,
    user: {
      id: session.user.id,
      email: session.user.email ?? null,
    },
  };
}

export function createBrowserAuthClient(supabase: SupabaseLike) {
  return {
    async getSession(): Promise<AppAuthSession | null> {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      return toAppSession(data.session);
    },

    async getAccessToken(): Promise<string | null> {
      const session = await this.getSession();
      return session?.accessToken ?? null;
    },

    async signIn(email: string, password: string): Promise<AppAuthSession | null> {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return toAppSession(data.session);
    },

    async signOut(): Promise<void> {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    },

    onSessionChange(callback: (session: AppAuthSession | null) => void): () => void {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        callback(toAppSession(session));
      });
      return () => data.subscription.unsubscribe();
    },
  };
}

export function createSupabaseBrowserAuthClient(config: AuthConfig) {
  return createBrowserAuthClient(
    createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    }),
  );
}
```

- [ ] **Step 5: Implement Login page**

Create `frontend/src/auth/login-page.tsx`:

```tsx
import { FormEvent, useState } from "react";

interface LoginPageProps {
  loading: boolean;
  error: string | null;
  onSignIn: (email: string, password: string) => Promise<void>;
}

export function LoginPage({ loading, error, onSignIn }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSignIn(email.trim(), password);
  }

  return (
    <main className="app-shell auth-shell">
      <section className="auth-card">
        <p className="eyebrow">ApiMonitor</p>
        <h1>登录后访问用量看板</h1>
        <p className="auth-card__summary">使用 Supabase 账号登录后，才能查看看板和维护供应商账号配置。</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            <span>邮箱</span>
            <input
              type="email"
              value={email}
              autoComplete="email"
              required
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              required
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error ? <div className="auth-error">{error}</div> : null}
          <button className="btn btn--primary" type="submit" disabled={loading}>
            {loading ? "登录中..." : "登录"}
          </button>
        </form>
      </section>
    </main>
  );
}
```

- [ ] **Step 6: Run tests to verify pass**

Run: `npm.cmd run test:frontend -- tests/frontend/authClient.test.ts tests/frontend/loginPage.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add frontend/src/auth/auth-client.ts frontend/src/auth/login-page.tsx tests/frontend/authClient.test.ts tests/frontend/loginPage.test.tsx
git commit -m "feat: add supabase login components"
```

---

### Task 4: App Auth Gate

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`
- Create: `tests/frontend/appAuthGate.test.tsx`

- [ ] **Step 1: Write failing Auth gate tests**

Create `tests/frontend/appAuthGate.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../frontend/src/App";

vi.mock("../../frontend/src/auth/auth-client", () => ({
  createSupabaseBrowserAuthClient: vi.fn(() => ({
    getSession: vi.fn(async () => null),
    getAccessToken: vi.fn(async () => null),
    signIn: vi.fn(),
    signOut: vi.fn(),
    onSessionChange: vi.fn(() => () => undefined),
  })),
}));

describe("App auth gate", () => {
  it("shows login page before a user session exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/auth/config")) {
        return new Response(JSON.stringify({
          ok: true,
          data: { supabaseUrl: "https://project.supabase.co", supabaseAnonKey: "anon-key" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }));

    render(<App />);

    expect(await screen.findByRole("button", { name: "登录" })).toBeTruthy();
    expect(screen.getByText("登录后访问用量看板")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm.cmd run test:frontend -- tests/frontend/appAuthGate.test.tsx`

Expected: FAIL because `App` does not load auth config or render `LoginPage`.

- [ ] **Step 3: Wire Auth gate in App**

在 `frontend/src/App.tsx` 增加 import：

```ts
import { createSupabaseBrowserAuthClient, type AppAuthSession } from "./auth/auth-client";
import { LoginPage } from "./auth/login-page";
```

在 `App()` 内增加状态：

```ts
const [authClient, setAuthClient] = useState<ReturnType<typeof createSupabaseBrowserAuthClient> | null>(null);
const [session, setSession] = useState<AppAuthSession | null>(null);
const [authLoading, setAuthLoading] = useState(true);
const [authError, setAuthError] = useState<string | null>(null);
```

把 `api` 创建改成携带 token：

```ts
const authClientRef = useRef<ReturnType<typeof createSupabaseBrowserAuthClient> | null>(null);
const api = useMemo(
  () =>
    createApiClient({
      authTokenProvider: async () => authClientRef.current?.getAccessToken() ?? null,
    }),
  [],
);
```

增加初始化：

```ts
useEffect(() => {
  let disposed = false;
  let unsubscribe: (() => void) | null = null;

  async function initAuth() {
    try {
      const config = await api.getAuthConfig();
      const nextAuthClient = createSupabaseBrowserAuthClient(config);
      authClientRef.current = nextAuthClient;
      const nextSession = await nextAuthClient.getSession();
      if (disposed) return;
      setAuthClient(nextAuthClient);
      setSession(nextSession);
      unsubscribe = nextAuthClient.onSessionChange(setSession);
    } catch (error) {
      if (!disposed) {
        setAuthError(error instanceof Error ? error.message : "登录配置加载失败");
      }
    } finally {
      if (!disposed) setAuthLoading(false);
    }
  }

  void initAuth();

  return () => {
    disposed = true;
    unsubscribe?.();
  };
}, [api]);
```

增加登录处理：

```ts
const signIn = useCallback(
  async (email: string, password: string) => {
    if (!authClient) return;
    setAuthLoading(true);
    setAuthError(null);
    try {
      const nextSession = await authClient.signIn(email, password);
      setSession(nextSession);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "登录失败");
    } finally {
      setAuthLoading(false);
    }
  },
  [authClient],
);
```

在渲染看板前加入：

```tsx
if (authLoading && !authClient) {
  return <main className="app-shell auth-shell">正在加载登录状态...</main>;
}

if (!session) {
  return <LoginPage loading={authLoading} error={authError} onSignIn={signIn} />;
}
```

- [ ] **Step 4: Add minimal styles**

在 `frontend/src/styles.css` 增加：

```css
.auth-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
}

.auth-card {
  width: min(420px, calc(100vw - 32px));
  border: 1px solid var(--border);
  border-radius: 24px;
  background: var(--surface);
  box-shadow: var(--shadow);
  padding: 28px;
}

.auth-card__summary {
  color: var(--text-muted);
  line-height: 1.7;
}

.auth-form {
  display: grid;
  gap: 14px;
  margin-top: 20px;
}

.auth-error {
  color: #b91c1c;
  background: #fee2e2;
  border: 1px solid #fecaca;
  border-radius: 12px;
  padding: 10px 12px;
}
```

- [ ] **Step 5: Run Auth gate test**

Run: `npm.cmd run test:frontend -- tests/frontend/appAuthGate.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add frontend/src/App.tsx frontend/src/styles.css tests/frontend/appAuthGate.test.tsx
git commit -m "feat: gate app behind supabase auth"
```

---

### Task 5: Remove Admin Token From Settings UI

**Files:**
- Modify: `frontend/src/settings/settings-page.tsx`
- Modify: `frontend/src/settings/provider-account-panel.tsx`
- Modify: `tests/frontend/settingsPage.test.tsx`

- [ ] **Step 1: Update failing settings tests**

在 `tests/frontend/settingsPage.test.tsx` 做三类替换：

```ts
// 删除所有：
sessionStorage.setItem("api-monitor-admin-token", "admin-token");

// 删除或替换 Admin Token 文案断言：
expect(screen.queryByText("Admin Token")).toBeNull();
expect(screen.queryByText("需要 Admin Token 后才能读取账号和保存配置。")).toBeNull();

// 保存偏好不再传 token：
expect(api.saveProviderPreferences).toHaveBeenCalledWith(
  expect.arrayContaining([
    expect.objectContaining({ providerKey: "openrouter", enabled: true, displayOrder: 1 }),
  ]),
);

// 保存账号不再传 token：
expect(api.saveProviderAccount).toHaveBeenCalledWith(
  expect.objectContaining({ providerKey: "openrouter" }),
);
```

把最后一个测试改为：

```ts
it("keeps add account actionable after login without admin token", () => {
  const api = {
    getProviderSettings: vi.fn(),
    saveProviderPreferences: vi.fn(),
    saveProviderAccount: vi.fn(),
    testProviderAccount: vi.fn(),
    updateProviderAccountDisplay: vi.fn(),
  };

  render(<SettingsPage api={api as never} onBack={() => undefined} />);

  const addButton = screen.getByRole("button", {
    name: "+ 新增账号 新增后默认不进首页，测试通过后可启用。",
  });
  expect((addButton as HTMLButtonElement).disabled).toBe(false);

  fireEvent.click(addButton);

  expect(screen.queryByText("需要先保存 Admin Token，才能新增或编辑账号。")).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm.cmd run test:frontend -- tests/frontend/settingsPage.test.tsx`

Expected: FAIL because settings UI still expects Admin Token.

- [ ] **Step 3: Remove Admin Token state and UI**

在 `frontend/src/settings/settings-page.tsx` 删除：

```ts
const tokenStorageKey = "api-monitor-admin-token";
const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem(tokenStorageKey) ?? "");
const [tokenInput, setTokenInput] = useState(adminToken);
const adminTokenInputRef = useRef<HTMLInputElement | null>(null);
```

删除 `saveAdminToken()`、`requestAdminToken()`，并删除 header 里的 `Admin Token` 表单块。

- [ ] **Step 4: Update SettingsPage API calls**

把调用改为无 token：

```ts
const settings = await api.getProviderSettings();
await api.saveProviderPreferences(preferences);
await api.saveProviderAccount(account);
await api.testProviderAccount(accountId);
await api.updateProviderAccountDisplay(accountId, input);
```

把 `addAccount()` 改为只聚焦表单：

```ts
function addAccount() {
  setEditingAccountId(null);
  focusCredentialForm();
}
```

- [ ] **Step 5: Update account panel empty copy**

在 `frontend/src/settings/provider-account-panel.tsx` 把空状态文案改为：

```tsx
<div className="settings-empty">暂无账号，点击“新增账号”后填写该供应商的凭据。</div>
```

- [ ] **Step 6: Run settings tests**

Run: `npm.cmd run test:frontend -- tests/frontend/settingsPage.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add frontend/src/settings/settings-page.tsx frontend/src/settings/provider-account-panel.tsx tests/frontend/settingsPage.test.tsx
git commit -m "feat: remove admin token from settings ui"
```

---

### Task 6: Worker User Auth for Settings Routes

**Files:**
- Create: `worker/auth.ts`
- Modify: `worker/settings/routes.ts`
- Modify: `tests/worker/settings-routes.test.ts`

- [ ] **Step 1: Write failing route auth tests**

在 `tests/worker/settings-routes.test.ts` 替换 admin token 测试：

```ts
it("rejects settings requests without a Supabase bearer token", async () => {
  const response = await handleSettingsRequest(
    new Request("https://api-monitor.local/api/settings/providers", { method: "GET" }),
    baseEnv,
    vi.fn() as never,
  );

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "unauthorized" },
  });
});

it("uses the authenticated Supabase user id for settings reads", async () => {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "auth-user-123", email: "me@example.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/rest/v1/provider_preferences")) {
      expect(url).toContain("user_id=eq.auth-user-123");
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/rest/v1/provider_accounts")) {
      expect(url).toContain("user_id=eq.auth-user-123");
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  });

  const response = await handleSettingsRequest(
    new Request("https://api-monitor.local/api/settings/providers", {
      method: "GET",
      headers: { Authorization: "Bearer user-jwt" },
    }),
    baseEnv,
    fetchImpl as never,
  );

  expect(response.status).toBe(200);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm.cmd run test:worker -- tests/worker/settings-routes.test.ts`

Expected: FAIL because routes still require `x-api-monitor-admin-token`.

- [ ] **Step 3: Implement Worker auth helper**

Create `worker/auth.ts`:

```ts
import { errorResponse } from "./http";

export interface AuthenticatedUser {
  userId: string;
  email: string | null;
}

export interface SupabaseAuthEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
}

export async function requireUser(
  request: Request,
  env: SupabaseAuthEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<{ user: AuthenticatedUser } | { response: Response }> {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  const publicKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY;

  if (!token) {
    return { response: errorResponse(401, "unauthorized", "Supabase login is required") };
  }

  if (!env.SUPABASE_URL || !publicKey) {
    return { response: errorResponse(500, "missing_auth_config", "Supabase auth config is not configured") };
  }

  const response = await fetchImpl(new URL("/auth/v1/user", env.SUPABASE_URL), {
    method: "GET",
    headers: {
      apikey: publicKey,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    return { response: errorResponse(401, "unauthorized", "Supabase login is invalid or expired") };
  }

  const user = await response.json<{ id?: string; email?: string | null }>();
  if (!user.id) {
    return { response: errorResponse(401, "unauthorized", "Supabase login is invalid or expired") };
  }

  return {
    user: {
      userId: user.id,
      email: user.email ?? null,
    },
  };
}
```

- [ ] **Step 4: Replace route admin guard**

在 `worker/settings/routes.ts` 删除 `requireAdmin()`，增加：

```ts
import { requireUser } from "../auth";
```

在 `handleSettingsRequest()` 开头改为：

```ts
const auth = await requireUser(request, env, fetchImpl);
if ("response" in auth) return auth.response;
const { userId } = auth.user;
```

后续 repository 调用改为：

```ts
await listProviderSettings(env, userId, fetchImpl)
await upsertProviderPreferences(env, userId, preference, fetchImpl)
await upsertProviderAccount(env, userId, input, fetchImpl)
await updateProviderAccountDisplay(env, userId, accountId, input, fetchImpl)
await getProviderAccountConfigById(env, userId, accountId, fetchImpl)
```

- [ ] **Step 5: Run route tests**

Run: `npm.cmd run test:worker -- tests/worker/settings-routes.test.ts`

Expected: FAIL only on repository signatures, then continue Task 7.

- [ ] **Step 6: Commit after Task 7 passes**

Do not commit this task alone if TypeScript is failing. Commit together with Task 7.

---

### Task 7: Repository User ID Injection

**Files:**
- Modify: `worker/settings/repository.ts`
- Modify: `tests/worker/settings-routes.test.ts`

- [ ] **Step 1: Update repository function signatures**

在 `worker/settings/repository.ts` 把函数签名改为：

```ts
export async function listProviderSettings(
  env: SettingsRepositoryEnv,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderSettingsPayload>

export async function upsertProviderPreferences(
  env: SettingsRepositoryEnv,
  userId: string,
  preference: ProviderPreference,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderPreference>

export async function upsertProviderAccount(
  env: SettingsRepositoryEnv,
  userId: string,
  input: ProviderAccountInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string }>

export async function updateProviderAccountDisplay(
  env: SettingsRepositoryEnv,
  userId: string,
  accountId: string,
  input: { homepageEnabled: boolean; homepageOrder: number },
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; homepageEnabled: boolean; homepageOrder: number }>

export async function getProviderAccountConfigById(
  env: SettingsRepositoryEnv,
  userId: string,
  accountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderAccountConfig | null>
```

- [ ] **Step 2: Replace fixed env user id**

在 repository 中把所有：

```ts
env.SUPABASE_USER_ID
```

替换为函数参数：

```ts
userId
```

并把缺配置判断从：

```ts
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_USER_ID)
```

改为：

```ts
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)
```

- [ ] **Step 3: Ensure every Supabase query filters by current user**

确认以下 URL 查询全部包含当前 `userId`：

```ts
preferencesUrl.searchParams.set("user_id", `eq.${userId}`);
accountsUrl.searchParams.set("user_id", `eq.${userId}`);
accountUrl.searchParams.set("user_id", `eq.${userId}`);
credUrl.searchParams.set("user_id", `eq.${userId}`);
```

确认 insert/upsert payload 使用：

```ts
user_id: userId,
```

- [ ] **Step 4: Update settings route test env**

在 `tests/worker/settings-routes.test.ts` 的 `baseEnv` 保留兼容字段但不再依赖它：

```ts
const baseEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-public-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  CREDENTIAL_ENCRYPTION_KEY: "test-encryption-key",
};
```

所有请求 helper 增加：

```ts
headers: {
  Authorization: "Bearer user-jwt",
  "content-type": "application/json",
}
```

测试 fetch mock 第一段统一响应 Auth user：

```ts
if (String(input).endsWith("/auth/v1/user")) {
  return new Response(JSON.stringify({ id: "user-123", email: "me@example.com" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 5: Run settings route tests**

Run: `npm.cmd run test:worker -- tests/worker/settings-routes.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 6 and Task 7 together**

Run:

```powershell
git add worker/auth.ts worker/settings/routes.ts worker/settings/repository.ts tests/worker/settings-routes.test.ts
git commit -m "feat: scope settings api to supabase user"
```

---

### Task 8: Update Dashboard Persistence User Scope

**Files:**
- Modify: `worker/index.ts`
- Modify: `tests/worker/index.test.ts`

- [ ] **Step 1: Write failing test for authenticated usage read**

在 `tests/worker/index.test.ts` 增加或更新 `/api/usage` 持久化读取测试，验证带登录态时使用当前用户：

```ts
it("reads persisted usage snapshots for the authenticated user", async () => {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "auth-user-123", email: "me@example.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/rest/v1/usage_snapshots")) {
      expect(url).toContain("user_id=eq.auth-user-123");
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  });

  const response = await worker.fetch(
    new Request("https://api-monitor.local/api/usage", {
      headers: { Authorization: "Bearer user-jwt" },
    }),
    {
      SUPABASE_URL: "https://supabase.test",
      SUPABASE_ANON_KEY: "anon-public-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
    } as never,
    undefined,
    fetchImpl,
  );

  expect(response.status).toBe(200);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm.cmd run test:worker -- tests/worker/index.test.ts`

Expected: FAIL where code still uses `SUPABASE_USER_ID`.

- [ ] **Step 3: Thread optional authenticated user through usage handlers**

在 `worker/index.ts` 对 `/api/usage` 和 `/api/refresh`：

```ts
const auth = await requireUser(request, env, fetch);
if ("response" in auth) return auth.response;
const { userId } = auth.user;
```

把 usage persistence helpers 改为接收 `userId`：

```ts
await readPersistedDashboard(env, userId, fetchImpl)
await persistUsageSnapshot(env, userId, snapshot, fetchImpl)
```

所有 `usage_snapshots`、`quota_windows`、`model_usage_daily`、`refresh_events` 的 `user_id` 都写入当前 `userId`。

- [ ] **Step 4: Keep local bootstrap safe**

如果缺少 Supabase auth config，返回统一错误：

```ts
return errorResponse(401, "unauthorized", "Supabase login is required");
```

前端未登录不会调用这些接口；该错误用于防止绕过登录页直接访问 API。

- [ ] **Step 5: Run worker index tests**

Run: `npm.cmd run test:worker -- tests/worker/index.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add worker/index.ts tests/worker/index.test.ts
git commit -m "feat: scope usage data to authenticated user"
```

---

### Task 9: Full Verification and Browser Check

**Files:**
- No source changes expected.
- Optional screenshot output: `output/playwright/supabase-auth-settings-gate.png`

- [ ] **Step 1: Run frontend tests**

Run: `npm.cmd run test:frontend`

Expected: PASS. Known non-fatal Recharts warnings may still print.

- [ ] **Step 2: Run worker tests**

Run: `npm.cmd run test:worker`

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run: `npm.cmd run test`

Expected: PASS.

- [ ] **Step 4: Run production build**

Run: `npm.cmd run build`

Expected: PASS. Known Vite chunk-size warning may still print.

- [ ] **Step 5: Browser verify login gate**

Run local app:

```powershell
npm.cmd run dev
```

Use Browser or Playwright MCP:

1. Open `http://localhost:5173/#/settings`.
2. Verify login page appears with title `登录后访问用量看板`.
3. Enter a real Supabase email and password manually in the browser.
4. Verify redirect/session enters settings page.
5. Verify `Admin Token` input is absent.
6. Verify Level 1 provider cards are visible.
7. Verify Level 2 account cards are visible.
8. Verify `+ 新增账号` can focus/open the credential form.
9. Save screenshot to `output/playwright/supabase-auth-settings-gate.png`.

- [ ] **Step 6: Optional deploy**

Only after tests/build pass and user confirms deployment:

Run: `npm.cmd run deploy:worker`

Expected: Wrangler deploy succeeds and prints a new Worker version ID.

---

## Plan Self-Review

- Spec coverage:
  - 登录页：Task 3、Task 4。
  - 未登录禁止访问看板和配置：Task 4、Task 8。
  - settings API 不再用 Admin Token：Task 2、Task 5、Task 6。
  - 当前用户隔离：Task 6、Task 7、Task 8。
  - service role 不进前端：Task 1、Task 3、Task 6、Task 7。
  - 测试和浏览器验证：Task 1-9。
- Placeholder scan:
  - 本计划未保留占位说明或延后实现项。
  - 每个实现步骤给出目标代码或明确替换规则。
- Type consistency:
  - 前端统一使用 `AuthConfig`、`AppAuthSession`、`authTokenProvider`。
  - Worker 统一使用 `requireUser()` 返回的 `userId`。
  - settings repository 统一把 `userId` 作为第二参数。
