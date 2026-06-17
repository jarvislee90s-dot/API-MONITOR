# OpenCode Cloud Browser Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 OpenCode Go 在普通 Worker fetch 失效时，自动使用 Cloudflare Browser Run 云端浏览器兜底抓取最新用量，并避免把最近成功快照误写成新的健康数据。

**Architecture:** OpenCode adapter 先执行现有 `workspaceId + authCookie` 轻量 HTML fetch；如果返回登录、错误或没有 usage windows，再在 Cloudflare Worker 内通过 Browser Run binding 打开同一 workspace 页面并解析渲染后的 HTML。刷新接口持久化实时抓取结果，展示接口才应用最近成功快照 fallback。

**Tech Stack:** Cloudflare Workers, Cloudflare Browser Run, `@cloudflare/puppeteer`, Supabase REST, TypeScript, Vitest, React API mapper.

---

## 约束与证据

- 不引入 Cloudflare / Supabase 之外的新服务。
- 不依赖本地 Chrome、Playwright、本地 HTTP 服务或本地常驻进程。
- OpenCode 凭据继续只保存 `workspaceId` 与 `authCookie`，其中 `authCookie` 推荐保存 `auth=...`。
- 不保存 OAuth `code`，因为它通常是一次性登录交换码。
- 不把真实 cookie、session、service role key 写入源码、文档、测试快照或日志。
- Cloudflare 官方 Browser Run 文档说明 Worker 可通过 browser binding 启动云端 Chromium，并用 `@cloudflare/puppeteer` 连接；Wrangler 配置需要 `[browser] binding = "MYBROWSER"` 和 `nodejs_compat` 兼容标志。
- 本计划涉及 `package.json` 和 `wrangler.toml`，执行这些步骤前必须得到用户确认。

## 文件结构

- Modify: `package.json`
  增加 `@cloudflare/puppeteer` devDependency。执行前必须向用户确认。
- Modify: `wrangler.toml`
  增加 Browser Run binding 和 Node.js compatibility flag。执行前必须向用户确认。
- Modify: `worker/types.ts`
  增加 Browser Run binding、OpenCode 抓取方法元数据、ProviderFetchInput browser 注入点。
- Create: `worker/providers/opencode-go-parser.ts`
  抽出 OpenCode HTML 解析逻辑，供普通 fetch 与 Browser Run 共用。
- Create: `worker/providers/opencode-go-browser.ts`
  封装 Cloudflare Browser Run 渲染 HTML 的最小逻辑。
- Modify: `worker/providers/opencode-go.ts`
  实现 fetch 优先、Browser Run 兜底，并写入 `meta.fetchMethod`、`meta.liveFetchStatus`。
- Modify: `worker/index.ts`
  把 `env.OPENCODE_BROWSER` 注入 OpenCode adapter；刷新时先持久化实时快照，再仅为响应展示应用 fallback。
- Modify: `frontend/src/api/client.ts`
  把 `meta.fetchMethod === "browser_rendered"` 显示成“云端浏览器同步”，fallback 继续显示“使用缓存数据”。
- Test: `tests/worker/providers.test.ts`
  覆盖 Browser Run 兜底、无 binding 时的失败状态、解析器共用。
- Test: `tests/worker/index.test.ts`
  覆盖 dashboard refresh 不再持久化 fallback 快照。
- Test: `tests/frontend/apiClient.test.ts`
  覆盖 `browser_rendered` 和 fallback 的前端状态文案。

---

### Task 1: 抽出 OpenCode HTML 解析器

**Files:**
- Create: `worker/providers/opencode-go-parser.ts`
- Modify: `worker/providers/opencode-go.ts`
- Test: `tests/worker/providers.test.ts`

- [ ] **Step 1: 写失败测试，证明解析器可独立解析三类窗口**

在 `tests/worker/providers.test.ts` 顶部新增导入：

```ts
import { parseOpenCodeGoWindows } from "../../worker/providers/opencode-go-parser";
```

在 `describe("opencode-go adapter", () => {` 内新增测试：

```ts
  it("parses OpenCode Go usage windows through the shared parser", () => {
    const html = [
      "<html><script>",
      "rollingUsage:$R[10]={usagePercent:6,resetInSec:10200}",
      "weeklyUsage:$R[11]={usagePercent:16,resetInSec:489600}",
      "monthlyUsage:$R[12]={usagePercent:25,resetInSec:1987200}",
      "</script></html>",
    ].join("");

    const windows = parseOpenCodeGoWindows(html, new Date("2026-06-16T07:00:00.000Z"));

    expect(windows.map((window) => window.key)).toEqual(["rolling", "weekly", "monthly"]);
    expect(windows[0]).toMatchObject({
      key: "rolling",
      label: "5h",
      used: 6,
      limit: 100,
      remaining: 94,
      percentUsed: 6,
      percentRemaining: 94,
      resetAt: "2026-06-16T17:50:00+08:00",
    });
    expect(windows[1]).toMatchObject({ key: "weekly", used: 16, remaining: 84 });
    expect(windows[2]).toMatchObject({ key: "monthly", used: 25, remaining: 75 });
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:worker -- tests/worker/providers.test.ts`

Expected: FAIL，错误包含 `Cannot find module '../../worker/providers/opencode-go-parser'`。

- [ ] **Step 3: 创建共享解析器**

新增 `worker/providers/opencode-go-parser.ts`：

```ts
import type { ProviderWindow } from "../types";

export type OpenCodeGoWindowKey = "rolling" | "weekly" | "monthly";

const WINDOW_KEYS: OpenCodeGoWindowKey[] = ["rolling", "weekly", "monthly"];

function toBeijingOffsetIso(date: Date): string {
  const beijingDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return beijingDate.toISOString().replace(/\.\d{3}Z$/, "+08:00");
}

function parseWindow(html: string, key: OpenCodeGoWindowKey): { used: number; resetInSec?: number } | null {
  const pattern = new RegExp(`${key}Usage:\\$R\\[\\d+\\]=\\{([^}]*)\\}`, "i");
  const match = html.match(pattern);
  if (!match?.[1]) return null;

  const body = match[1];
  const usedMatch = body.match(/usagePercent:([0-9]+(?:\.[0-9]+)?)/i);
  const resetMatch = body.match(/resetInSec:([0-9]+(?:\.[0-9]+)?)/i);
  const used = usedMatch ? Number(usedMatch[1]) : Number.NaN;
  if (!Number.isFinite(used)) return null;

  return {
    used,
    resetInSec: resetMatch ? Number(resetMatch[1]) : undefined,
  };
}

export function parseOpenCodeGoWindows(html: string, now: Date): ProviderWindow[] {
  return WINDOW_KEYS.flatMap((key) => {
    const parsed = parseWindow(html, key);
    if (!parsed) return [];

    return [{
      key,
      label: key === "rolling" ? "5h" : key === "weekly" ? "Weekly" : "Monthly",
      used: parsed.used,
      limit: 100,
      remaining: Math.max(0, 100 - parsed.used),
      percentUsed: Math.min(100, parsed.used),
      percentRemaining: Math.max(0, 100 - parsed.used),
      resetAt: parsed.resetInSec
        ? toBeijingOffsetIso(new Date(now.getTime() + parsed.resetInSec * 1000))
        : null,
    }];
  });
}
```

- [ ] **Step 4: 修改 OpenCode adapter 使用共享解析器**

在 `worker/providers/opencode-go.ts` 删除本地 `WindowKey`、`WINDOW_KEYS`、`toBeijingOffsetIso`、`parseWindow`，新增导入：

```ts
import { parseOpenCodeGoWindows } from "./opencode-go-parser";
```

把 `fetchOpenCodeGoSnapshot` 中的 `const parsedWindows = WINDOW_KEYS.flatMap(...)` 整段替换为：

```ts
  const parsedWindows = parseOpenCodeGoWindows(html, input.now);
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test:worker -- tests/worker/providers.test.ts`

Expected: PASS，OpenCode 相关测试全部通过。

- [ ] **Step 6: 提交**

```powershell
git add worker/providers/opencode-go-parser.ts worker/providers/opencode-go.ts tests/worker/providers.test.ts
git commit -m "refactor: share opencode usage parser"
```

---

### Task 2: 增加 Browser Run 渲染适配层

**Files:**
- Modify: `package.json`
- Modify: `wrangler.toml`
- Modify: `worker/types.ts`
- Create: `worker/providers/opencode-go-browser.ts`
- Test: `tests/worker/providers.test.ts`

- [ ] **Step 1: 获取用户确认后修改依赖和 Cloudflare 配置**

执行前向用户确认：“需要修改 `package.json` 和 `wrangler.toml` 以接入 Cloudflare Browser Run，是否继续？”

确认后，在 `package.json` 的 `devDependencies` 中加入：

```json
"@cloudflare/puppeteer": "^1.1.0"
```

在 `wrangler.toml` 中加入或合并以下配置。若已有 `compatibility_flags`，只追加 `nodejs_compat`，不要删除现有值：

```toml
compatibility_flags = [ "nodejs_compat" ]

[browser]
binding = "OPENCODE_BROWSER"
```

- [ ] **Step 2: 写失败测试，证明 Browser HTML renderer 可注入**

在 `tests/worker/providers.test.ts` 的 OpenCode describe 内新增：

```ts
  it("uses the injected browser renderer when lightweight OpenCode fetch redirects to login", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("", {
        status: 302,
        headers: { location: "https://auth.opencode.ai/authorize?client_id=app" },
      });
    });
    const browserRenderer = vi.fn(async () => {
      return [
        "<html><script>",
        "rollingUsage:$R[10]={usagePercent:6,resetInSec:10200}",
        "weeklyUsage:$R[11]={usagePercent:16,resetInSec:489600}",
        "monthlyUsage:$R[12]={usagePercent:25,resetInSec:1987200}",
        "</script></html>",
      ].join("");
    });

    const result = await fetchOpenCodeGoSnapshot({
      now: new Date("2026-06-16T07:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      browserRenderer,
      config: {
        workspaceId: "wrk_123",
        authCookie: "auth=abc123",
        browserFallbackEnabled: true,
      },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows.map((window) => window.key)).toEqual(["rolling", "weekly", "monthly"]);
    expect(result.snapshot.meta).toMatchObject({
      fetchMethod: "browser_rendered",
      liveFetchStatus: "login_required",
    });
    expect(browserRenderer).toHaveBeenCalledWith({
      sourceUrl: "https://opencode.ai/workspace/wrk_123/go",
      authCookie: "auth=abc123",
      browser: undefined,
    });
  });
```

- [ ] **Step 3: 修改类型，加入 Browser Run 注入点**

在 `worker/types.ts` 中把 `ProviderFetchInput` 改为：

```ts
export type OpenCodeBrowserRenderInput = {
  sourceUrl: string;
  authCookie?: string;
  browser?: Fetcher;
};

export type OpenCodeBrowserRenderer = (input: OpenCodeBrowserRenderInput) => Promise<string>;

export type ProviderFetchInput = {
  now: Date;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  browser?: Fetcher;
  browserRenderer?: OpenCodeBrowserRenderer;
  config?: Record<string, unknown>;
};
```

在 `WorkerEnv` 中加入可选 binding：

```ts
  OPENCODE_BROWSER?: Fetcher;
  OPENCODE_GO_BROWSER_FALLBACK?: string;
```

- [ ] **Step 4: 新增 Browser Run 渲染文件**

新增 `worker/providers/opencode-go-browser.ts`：

```ts
import puppeteer from "@cloudflare/puppeteer";
import { parseHeadersCookie } from "../http";
import type { OpenCodeBrowserRenderInput } from "../types";

function normalizeCookieHeader(rawCookie: string | undefined): string | undefined {
  const cookie = parseHeadersCookie(rawCookie);
  if (!cookie) return undefined;
  return cookie.includes("=") ? cookie : `auth=${cookie}`;
}

function toPageCookies(rawCookie: string | undefined, sourceUrl: string): Array<{ name: string; value: string; url: string }> {
  const cookie = normalizeCookieHeader(rawCookie);
  if (!cookie) return [];

  return cookie
    .split(";")
    .map((part) => part.trim())
    .flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator <= 0) return [];
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1);
      if (!name || name.includes(";")) return [];
      return [{ name, value, url: sourceUrl }];
    });
}

export async function renderOpenCodeGoBrowserHtml(input: OpenCodeBrowserRenderInput): Promise<string> {
  if (!input.browser) {
    throw new Error("OpenCode Browser Run binding is not configured");
  }

  const browser = await puppeteer.launch(input.browser);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    );

    const cookies = toPageCookies(input.authCookie, input.sourceUrl);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
    }

    await page.goto(input.sourceUrl, { waitUntil: "networkidle0", timeout: 20_000 });
    await page.waitForFunction(
      () => document.documentElement.innerHTML.includes("rollingUsage") || document.body.innerText.includes("滚动用量"),
      { timeout: 10_000 },
    ).catch(() => undefined);

    return await page.content();
  } finally {
    await browser.close();
  }
}
```

- [ ] **Step 5: 运行测试确认当前失败来自 adapter 尚未调用 renderer**

Run: `npm run test:worker -- tests/worker/providers.test.ts`

Expected: FAIL，新增测试中的 `browserRenderer` 没有被调用或 `meta.fetchMethod` 不存在。

- [ ] **Step 6: 提交**

```powershell
git add package.json wrangler.toml worker/types.ts worker/providers/opencode-go-browser.ts tests/worker/providers.test.ts
git commit -m "feat: add opencode browser renderer"
```

---

### Task 3: 在 OpenCode adapter 中实现 fetch 优先、Browser Run 兜底

**Files:**
- Modify: `worker/providers/opencode-go.ts`
- Test: `tests/worker/providers.test.ts`

- [ ] **Step 1: 写失败测试，证明没有 Browser binding 时保留登录失败**

在 `tests/worker/providers.test.ts` 的 OpenCode describe 内新增：

```ts
  it("keeps login_required when browser fallback is enabled but no renderer or binding is available", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("", {
        status: 302,
        headers: { location: "https://auth.opencode.ai/authorize?client_id=app" },
      });
    });

    const result = await fetchOpenCodeGoSnapshot({
      now: new Date("2026-06-16T07:00:00.000Z"),
      fetchImpl: fetchImpl as typeof fetch,
      config: {
        workspaceId: "wrk_123",
        authCookie: "auth=abc123",
        browserFallbackEnabled: true,
      },
    });

    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.meta).toMatchObject({
      fetchMethod: "worker_fetch",
      browserFallbackAttempted: true,
      browserFallbackStatus: "missing_binding",
    });
  });
```

- [ ] **Step 2: 修改 OpenCode 配置类型**

在 `worker/providers/opencode-go.ts` 中把 `OpenCodeGoConfig` 改为：

```ts
type OpenCodeGoConfig = {
  workspaceId?: string;
  authCookie?: string;
  baseUrl?: string;
  browserFallbackEnabled?: boolean | string;
};
```

新增导入：

```ts
import { renderOpenCodeGoBrowserHtml } from "./opencode-go-browser";
```

新增工具函数：

```ts
function isBrowserFallbackEnabled(value: boolean | string | undefined): boolean {
  return value === true || value === "1" || value === "true";
}
```

- [ ] **Step 3: 在 `fetchOpenCodeGoSnapshot` 中加入兜底逻辑**

在 `fetchOpenCodeGoSnapshot` 内，`const response = await fetchImpl(...)` 前保留现有 config/sourceUrl 逻辑。把 `if (!response.ok) { ... }` 到最终 `return createResult({...})` 的主体改成下面结构：

```ts
  const html = await response.text();
  const location = response.headers.get("location");
  const redirectedToLogin = response.status >= 300 && response.status < 400 && isOpenCodeAuthUrl(location);
  const fetchStatus = !response.ok
    ? response.status === 401 || response.status === 403 || redirectedToLogin ? "login_required" : "error"
    : "ready";
  const loginRequired = response.ok
    ? isOpenCodeAuthUrl(response.url) || /<title[^>]*>\s*OpenAuth\s*<\/title>|sign in|log in|login|登录|登入/i.test(html)
    : fetchStatus === "login_required";
  const parsedWindows = response.ok && !loginRequired
    ? parseOpenCodeGoWindows(html, input.now)
    : [];
  const fetchSummary = !response.ok
    ? redirectedToLogin
      ? "OpenCode Go dashboard redirected to login"
      : `OpenCode Go dashboard returned HTTP ${response.status}`
    : loginRequired
      ? "OpenCode Go dashboard appears to require login"
      : parsedWindows.length > 0
        ? "OpenCode Go usage windows parsed"
        : "OpenCode Go dashboard loaded but usage windows were not found";

  if (parsedWindows.length > 0) {
    return createResult({
      providerId: "opencode-go",
      providerName: "OpenCode Go",
      sourceUrl,
      status: "ready",
      capturedAt: now,
      summary: "OpenCode Go usage windows parsed",
      windows: parsedWindows,
      metrics: {
        hasRolling: parsedWindows.some((window) => window.key === "rolling"),
        hasWeekly: parsedWindows.some((window) => window.key === "weekly"),
        hasMonthly: parsedWindows.some((window) => window.key === "monthly"),
      },
      meta: { fetchMethod: "worker_fetch" },
    });
  }

  if (isBrowserFallbackEnabled(config.browserFallbackEnabled)) {
    const renderer = input.browserRenderer ?? (input.browser ? renderOpenCodeGoBrowserHtml : null);
    if (!renderer) {
      return createResult({
        providerId: "opencode-go",
        providerName: "OpenCode Go",
        sourceUrl,
        status: fetchStatus === "error" ? "error" : "login_required",
        capturedAt: now,
        summary: fetchSummary,
        windows: [],
        metrics: { httpStatus: response.status },
        meta: {
          fetchMethod: "worker_fetch",
          browserFallbackAttempted: true,
          browserFallbackStatus: "missing_binding",
        },
      });
    }

    try {
      const browserHtml = await renderer({
        sourceUrl,
        authCookie: normalizeOpenCodeCookie(config.authCookie),
        browser: input.browser,
      });
      const browserWindows = parseOpenCodeGoWindows(browserHtml, input.now);
      if (browserWindows.length > 0) {
        return createResult({
          providerId: "opencode-go",
          providerName: "OpenCode Go",
          sourceUrl,
          status: "ready",
          capturedAt: now,
          summary: "OpenCode Go usage windows parsed by Cloudflare Browser Run",
          windows: browserWindows,
          metrics: {
            hasRolling: browserWindows.some((window) => window.key === "rolling"),
            hasWeekly: browserWindows.some((window) => window.key === "weekly"),
            hasMonthly: browserWindows.some((window) => window.key === "monthly"),
          },
          meta: {
            fetchMethod: "browser_rendered",
            liveFetchStatus: fetchStatus === "ready" ? "partial" : fetchStatus,
            liveFetchSummary: fetchSummary,
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Browser Run fallback failed";
      return createResult({
        providerId: "opencode-go",
        providerName: "OpenCode Go",
        sourceUrl,
        status: fetchStatus === "error" ? "error" : "login_required",
        capturedAt: now,
        summary: fetchSummary,
        windows: [],
        metrics: { httpStatus: response.status },
        meta: {
          fetchMethod: "worker_fetch",
          browserFallbackAttempted: true,
          browserFallbackStatus: "error",
          browserFallbackSummary: message,
        },
      });
    }
  }

  return createResult({
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    sourceUrl,
    status: loginRequired ? "login_required" : "partial",
    capturedAt: now,
    summary: fetchSummary,
    windows: [],
    metrics: {
      hasRolling: false,
      hasWeekly: false,
      hasMonthly: false,
    },
    meta: { fetchMethod: "worker_fetch" },
  });
```

- [ ] **Step 4: 运行 OpenCode provider 测试**

Run: `npm run test:worker -- tests/worker/providers.test.ts`

Expected: PASS，包含新增 Browser Run 兜底测试。

- [ ] **Step 5: 提交**

```powershell
git add worker/providers/opencode-go.ts tests/worker/providers.test.ts
git commit -m "feat: fallback opencode to browser run"
```

---

### Task 4: 注入 Cloudflare Browser binding 并修正 fallback 持久化

**Files:**
- Modify: `worker/index.ts`
- Test: `tests/worker/index.test.ts`

- [ ] **Step 1: 写失败测试，证明 dashboard refresh 不持久化 fallback 快照**

在 `tests/worker/index.test.ts` 的 `describe("worker api", () => {` 内新增：

```ts
  it("persists live refresh snapshots before applying dashboard fallback", async () => {
    const readyOpenCodeSnapshot: ProviderSnapshot = {
      providerId: "opencode-go",
      providerName: "OpenCode Go",
      sourceUrl: "https://opencode.ai/workspace/wrk_123/go",
      status: "ready",
      capturedAt: "2026-06-13T13:27:00.000Z",
      summary: "OpenCode Go usage windows parsed",
      windows: [{ key: "weekly", label: "Weekly", used: 16, limit: 100, remaining: 84 }],
      metrics: {},
      meta: {},
    };
    const usageWrites: unknown[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();

      if (url.includes("/api/v1/auth/key")) {
        return Response.json({ data: { usage: 1, limit: 100, limit_remaining: 99 } });
      }
      if (url.includes("opencode.ai/workspace")) {
        return new Response("<html>No usage markers in this cloud response</html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.includes("maas.xfyun.cn/api/subscription")) {
        return Response.json({ used: 20, limit: 100, remaining: 80 });
      }
      if (url.startsWith("https://supabase.test/rest/v1/usage_snapshots") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        usageWrites.push(body);
        return new Response("", { status: 201 });
      }
      if (url.startsWith("https://supabase.test/rest/v1/usage_snapshots")) {
        return Response.json([{ provider_key: "opencode-go", payload: readyOpenCodeSnapshot }]);
      }
      if (url.startsWith("https://supabase.test/rest/v1/provider_accounts")) return new Response("", { status: 201 });
      if (url.startsWith("https://supabase.test/rest/v1/quota_windows")) return new Response("", { status: 201 });
      if (url.startsWith("https://supabase.test/rest/v1/refresh_events")) return new Response("", { status: 201 });

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
          body: JSON.stringify({ sessionKey: "dashboard" }),
        }),
        env,
      );
      const payload = (await response.json()) as any;
      const persistedOpenCode = usageWrites.find((row: any) => row.provider_key === "opencode-go") as any;
      const displayedOpenCode = payload.data.cards.find((card: any) => card.providerId === "opencode-go");

      expect(response.status).toBe(200);
      expect(displayedOpenCode.meta.isFallback).toBe(true);
      expect(persistedOpenCode.status).toBe("partial");
      expect(persistedOpenCode.payload.meta.isFallback).toBeUndefined();
      expect(persistedOpenCode.captured_at).not.toBe("2026-06-13T13:27:00.000Z");
    } finally {
      vi.unstubAllGlobals();
    }
  });
```

- [ ] **Step 2: 修改 `buildProviderConfig` 注入 browser fallback 开关**

在 `worker/index.ts` 的 OpenCode 配置返回对象中加入：

```ts
      browserFallbackEnabled: env.OPENCODE_GO_BROWSER_FALLBACK,
```

- [ ] **Step 3: 修改 `fetchProviderSnapshot` 注入 Browser binding**

在 `fetchProviderSnapshot` 中，`if (providerId === "opencode-go") {` 块改为：

```ts
  if (providerId === "opencode-go") {
    fetchInput.requestTimeoutMs = 15_000;
    fetchInput.browser = env.OPENCODE_BROWSER;
  }
```

- [ ] **Step 4: 修改 dashboard refresh 先持久化实时快照再应用 fallback**

把 `handleDashboardRefresh` 中：

```ts
  const snapshots = await applyLatestReadyFallback(env, userId, await collectUsageSnapshots(env, userId));

  if (shouldPersist && decision?.allowed) {
    for (const snapshot of snapshots) {
      await persistSnapshot(env, userId, snapshot, decision);
    }
  }

  const dashboard = buildUsageDashboard(snapshots, {
```

替换为：

```ts
  const liveSnapshots = await collectUsageSnapshots(env, userId);
  const displaySnapshots = await applyLatestReadyFallback(env, userId, liveSnapshots);

  if (shouldPersist && decision?.allowed) {
    for (const snapshot of liveSnapshots) {
      await persistSnapshot(env, userId, snapshot, decision);
    }
  }

  const dashboard = buildUsageDashboard(displaySnapshots, {
```

- [ ] **Step 5: 运行 Worker API 测试**

Run: `npm run test:worker -- tests/worker/index.test.ts`

Expected: PASS，新增测试证明写入 Supabase 的 OpenCode 行不是 fallback 快照。

- [ ] **Step 6: 提交**

```powershell
git add worker/index.ts tests/worker/index.test.ts
git commit -m "fix: persist live snapshots before fallback display"
```

---

### Task 5: 前端展示云端浏览器同步状态

**Files:**
- Modify: `frontend/src/api/client.ts`
- Test: `tests/frontend/apiClient.test.ts`

- [ ] **Step 1: 写失败测试，证明 `browser_rendered` 有独立文案**

在 `tests/frontend/apiClient.test.ts` 新增测试：

```ts
  it("maps browser-rendered OpenCode snapshots to connected cloud browser state", async () => {
    const fetcher = vi.fn(async () => Response.json({
      ok: true,
      data: {
        kind: "usage_dashboard",
        generatedAt: "2026-06-16T07:00:00.000Z",
        status: "ready",
        summary: "ready",
        cards: [{
          providerId: "opencode-go",
          providerName: "OpenCode Go",
          sourceUrl: "https://opencode.ai/workspace/wrk_123/go",
          status: "ready",
          summary: "OpenCode Go usage windows parsed by Cloudflare Browser Run",
          capturedAt: "2026-06-16T07:00:00.000Z",
          trend: [],
          windows: [{ key: "rolling", label: "5h", used: 6, limit: 100, remaining: 94 }],
          metrics: {},
          meta: { fetchMethod: "browser_rendered" },
          selectedAccountId: "opencode-go:default",
          accounts: [],
        }],
        modelSpends: [],
        totals: { providers: 1, ready: 1, partial: 0, loginRequired: 0, error: 0 },
      },
    }));
    const client = createApiClient({ fetcher: fetcher as unknown as typeof fetch });

    const dashboard = await client.getUsageDashboard();

    expect(dashboard.platforms[0]).toMatchObject({
      status: "healthy",
      loginState: "云端浏览器同步",
    });
  });
```

- [ ] **Step 2: 修改前端映射函数**

在 `frontend/src/api/client.ts` 新增：

```ts
function resolveLoginState(status: ServerProviderStatus, meta?: Record<string, unknown>): string {
  if (meta?.isFallback === true) return "使用缓存数据";
  if (meta?.fetchMethod === "browser_rendered") return "云端浏览器同步";
  if (status === "login_required") return "需要登录";
  if (status === "error") return "抓取失败";
  if (status === "partial") return "部分可用";
  return "已连接";
}
```

把账号映射中的 `loginState: ...` 整段替换为：

```ts
        loginState: resolveLoginState(account.status, account.meta),
```

把卡片映射中的 `loginState: ...` 整段替换为：

```ts
      loginState: resolveLoginState(card.status, card.meta),
```

- [ ] **Step 3: 运行前端 API client 测试**

Run: `npm run test:frontend -- tests/frontend/apiClient.test.ts`

Expected: PASS，fallback 仍显示“使用缓存数据”，browser rendered 显示“云端浏览器同步”。

- [ ] **Step 4: 提交**

```powershell
git add frontend/src/api/client.ts tests/frontend/apiClient.test.ts
git commit -m "feat: show opencode browser sync state"
```

---

### Task 6: 完整验证与部署前检查

**Files:**
- Modify: none
- Test: existing test suite

- [ ] **Step 1: 运行 OpenCode provider 聚焦测试**

Run: `npm run test:worker -- tests/worker/providers.test.ts`

Expected: PASS。

- [ ] **Step 2: 运行 Worker API 聚焦测试**

Run: `npm run test:worker -- tests/worker/index.test.ts`

Expected: PASS。

- [ ] **Step 3: 运行前端 API mapper 聚焦测试**

Run: `npm run test:frontend -- tests/frontend/apiClient.test.ts`

Expected: PASS。

- [ ] **Step 4: 运行常规验证**

Run: `npm run test`

Expected: PASS。

Run: `npm run build`

Expected: PASS。

- [ ] **Step 5: 部署前人工检查**

检查以下配置存在于 Cloudflare Worker 环境中：

```text
OPENCODE_GO_WORKSPACE_ID
OPENCODE_GO_AUTH_COOKIE
OPENCODE_GO_BROWSER_FALLBACK=1
CREDENTIAL_ENCRYPTION_KEY
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_USER_ID
OPENCODE_BROWSER binding
```

不要把这些值打印到日志，不要写入 `.env`、文档或测试快照。

- [ ] **Step 6: 最终提交**

```powershell
git status --short
git commit -m "feat: add opencode cloud browser fallback"
```

如果 Task 1-5 已经分别提交，最终提交只应包含验证中产生的必要文档调整；如果没有剩余变更，跳过本步骤。

---

## 自检结果

- Spec coverage: 覆盖纯云端运行、OpenCode Go 最新数据、Cloudflare Browser Run 兜底、Supabase 快照持久化、前端状态展示。
- Placeholder scan: 没有占位词或未展开的“以后实现”步骤。
- Type consistency: `ProviderFetchInput.browser`、`ProviderFetchInput.browserRenderer`、`meta.fetchMethod`、`meta.liveFetchStatus` 在任务间命名一致。
- Scope check: 本计划只处理 OpenCode Go 获取最新数据和 fallback 持久化问题，不扩展其他 provider。
