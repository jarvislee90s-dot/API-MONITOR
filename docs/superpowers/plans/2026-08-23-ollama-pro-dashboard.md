# Ollama Pro 用量看板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 Ollama Pro 用量看板：5小时/周额度百分比 + Models used this week（模型名称 + 请求数）列表。

**Architecture:** 复用现有 provider 适配器模式。Worker 端新增 `ollama` provider，用 `.env` 中的 Ollama API Key（`Authorization: Bearer`）调用 `https://ollama.com/api/usage`，把 5小时/周用量与模型请求数解析进 `ProviderSnapshot`（windows + metrics）。前端沿用智谱 3×3 指标卡模式渲染明细指标，模型请求数列表复用 `ModelSpendTable` 呈现。Key 只存云端（Worker secret / Supabase 加密凭据），不暴露给前端。

**Tech Stack:** Cloudflare Workers (TypeScript) / Supabase / React 18 + Vite + Vitest。Ollama 无 cookie 登录问题：API Key 即凭据，无需刷新脚本。

**背景（已在本轮验证）**
- `GET https://ollama.com/api/usage`（`Authorization: Bearer <key>`，key 来自 .env 的 Ollama 变量）返回 200，结构：
```json
{
  "activity": { "cost": "0.00000", "period": { "type": "last_4_weeks", ... }, "models": [] },
  "limits": {
    "session": { "usage": 0.068, "models": [{ "name": "deepseek-v4-flash:0731", "request_count": 239 }, ...] },
    "weekly":  { "usage": 0.007, "models": [ ... 同上 ... ] }
  }
}
```
- `usage` 是 0~1 的小数比例（0.068 = 6.8%），乘以 100 得到百分比。
- 重置时间：已验证多个候选路径（`/api/usage?*`、`/api/limits*`、`/api/quota*`、`/api/plan*`、`/api/billing*`、`/api/me` 等）均无 `resetAt` 字段。Task 0 先用本地 Playwright 对 `ollama.com/settings`（Edge 已登录 profile）抓包确认是否有隐藏接口；若没有，本期窗口 `resetAt` 显示"滚动窗口"，不做估算。
- `.env` 当前 Ollama 变量格式不规范（`OLLAMA PRO` 带空格键名 + 裸 key/URL 行），需规范为 `OLLAMA_KEY` / `OLLAMA_URL`（用户确认后执行）。

---

### Task 0: 规范化 Ollama .env 变量并确认数据源

**Files:**
- Modify: `.env`（需用户确认；改前备份）
- Modify: `.env.example`
- Create: 无

- [ ] **Step 1: 备份并规范化 .env 的 Ollama 变量**

执行前与用户确认。将 .env 中以下内容：

```
OLLAMA PRO
f65e47495bc44a5abb4b1a40d260ba6e.xxxxxxxxxxxxxxxxxxxxxxxx
https://ollama.com/v1
```

替换为：

```
OLLAMA_KEY="<从旧行迁移的 key>"
OLLAMA_URL="https://ollama.com/v1"
OLLAMA_PAGE_URL="https://ollama.com/settings"
```

- [ ] **Step 2: 同步更新 .env.example**

在 `.env.example` 追加：

```
# Ollama Pro
OLLAMA_KEY="ollama-api-key"
OLLAMA_URL="https://ollama.com/v1"
OLLAMA_PAGE_URL="https://ollama.com/settings"
```

- [ ] **Step 3: 用规范化后的变量验证 /api/usage**

在项目根执行（Node ≥ 22，自带 fetch）：

Run: `node -e "fetch('https://ollama.com/api/usage',{headers:{Authorization:'Bearer '+require('fs').readFileSync('.env','utf8').match(/OLLAMA_KEY=\"([^\"]+)\"/)[1]}}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j.limits)))"`
Expected: 输出 `{"session":{...},"weekly":{...}}` 且每个含 `usage` 与 `models[].name/request_count`。

- [ ] **Step 4: 探测重置时间数据源（可选但推荐）**

在本地用 Playwright 打开已登录 Ollama 的 Edge profile，监听网络请求：

```ts
// scripts/explore-ollama-settings.ts（临时脚本，完成后删除，不提交）
import { chromium } from "playwright";
const userDataDir = `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\User Data`;
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "msedge", headless: false,
  args: ["--profile-directory=Default"],
});
const page = context.pages()[0] ?? await context.newPage();
await page.goto("https://ollama.com/settings", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(8_000);
for (const req of await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name))) {
  if (/api|usage|limit|quota/i.test(req)) console.log(req);
}
await context.close();
```

预期：若页面存在带 `resetAt` / `resets` 的接口，记录下来并在 Task 1 的 `fetchOllamaSnapshot` 中解析；若没有（当前探测结果表明大概率没有），则本计划窗口 `resetAt` 置 `null`，前端显示"滚动窗口"。

---

### Task 1: Ollama Provider 适配器（TDD）

**Files:**
- Test: `tests/worker/providers.test.ts`（新增 `describe("ollama adapter")`）
- Create: `worker/providers/ollama.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/worker/providers.test.ts` 末尾追加（保持既有 import 风格，文件顶部补 `import { fetchOllamaSnapshot } from "../../worker/providers/ollama";`）：

```ts
describe("ollama adapter", () => {
  const NOW = new Date("2026-08-23T06:00:00.000Z");

  it("returns login_required when api key is missing", async () => {
    const result = await fetchOllamaSnapshot({ now: NOW, config: {} });
    expect(result.snapshot.status).toBe("login_required");
    expect(result.snapshot.metrics).toMatchObject({ hasApiKey: false });
  });

  it("parses session/weekly usage and model request counts", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        activity: { cost: "0.00000", period: { type: "last_4_weeks" }, models: [] },
        limits: {
          session: {
            usage: 0.068,
            models: [
              { name: "deepseek-v4-flash:0731", request_count: 239 },
              { name: "kimi-k2.6", request_count: 10 },
            ],
          },
          weekly: {
            usage: 0.007,
            models: [{ name: "deepseek-v4-flash:0731", request_count: 249 }],
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    const result = await fetchOllamaSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: { apiKey: "ollama-key", apiUrl: "https://ollama.com/v1" },
    });

    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.windows.map((w) => w.key)).toEqual(["rp5h", "weekly"]);
    expect(result.snapshot.windows[0]).toMatchObject({ label: "5小时", used: 6.8, limit: 100, percentUsed: 6.8 });
    expect(result.snapshot.windows[1]).toMatchObject({ label: "每周", used: 0.7, limit: 100, percentUsed: 0.7 });
    expect(result.snapshot.metrics).toMatchObject({
      sessionUsagePercent: 6.8,
      weeklyUsagePercent: 0.7,
      weeklyTotalRequests: 249,
    });
    // 模型列表以 JSON 字符串放进 metrics，供前端渲染
    const parsed = JSON.parse(String(result.snapshot.metrics.weeklyModels));
    expect(parsed).toEqual([{ name: "deepseek-v4-flash:0731", requests: 249 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://ollama.com/api/usage");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer ollama-key" });
  });

  it("rejects a non-ollama api url and never sends the request", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchOllamaSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: { apiKey: "ollama-key", apiUrl: "https://evil.example.com/v1" },
    });
    expect(result.snapshot.status).toBe("error");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps 401/403 to login_required", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    const result = await fetchOllamaSnapshot({
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
      config: { apiKey: "bad-key", apiUrl: "https://ollama.com/v1" },
    });
    expect(result.snapshot.status).toBe("login_required");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/worker/providers.test.ts -t "ollama adapter"`
Expected: FAIL（`Cannot find module '../../worker/providers/ollama'`）

- [ ] **Step 3: 实现 provider**

创建 `worker/providers/ollama.ts`：

```ts
import { clampNumber, toIsoString } from "../http";
import type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult, ProviderSnapshot } from "../types";
import { createResult } from "./types";

type OllamaConfig = {
  apiKey?: string;
  apiUrl?: string;
  pageUrl?: string;
};

type OllamaModelUsage = {
  name?: unknown;
  request_count?: unknown;
};

type OllamaLimitWindow = {
  usage?: unknown;
  models?: OllamaModelUsage[];
};

type OllamaUsagePayload = {
  limits?: {
    session?: OllamaLimitWindow;
    weekly?: OllamaLimitWindow;
  };
};

const defaultPageUrl = "https://ollama.com/settings";
const defaultApiUrl = "https://ollama.com/v1";

// API 域名白名单，防止凭据被发往非预期地址
function isTrustedOllamaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "ollama.com" || url.hostname.endsWith(".ollama.com"));
  } catch {
    return false;
  }
}

// 把 /api/usage 的 usage 小数（0~1）转成百分比数值
function toPercent(value: unknown): number | null {
  const number = clampNumber(value);
  if (typeof number !== "number") return null;
  return Math.round(number * 1000) / 10;
}

// models 归一化为 {name, requests}，按请求数降序
function normalizeModels(window?: OllamaLimitWindow): Array<{ name: string; requests: number }> {
  if (!window?.models?.length) return [];
  return window.models
    .map((item) => {
      const name = typeof item.name === "string" && item.name.length > 0 ? item.name : null;
      const requests = clampNumber(item.request_count);
      if (!name || typeof requests !== "number") return null;
      return { name, requests };
    })
    .filter((item): item is { name: string; requests: number } => item !== null)
    .sort((a, b) => b.requests - a.requests);
}

export async function fetchOllamaSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = (input.config ?? {}) as OllamaConfig;
  const sourceUrl = config.pageUrl?.trim() || defaultPageUrl;

  if (!config.apiKey) {
    return createResult({
      providerId: "ollama",
      providerName: "Ollama Pro",
      sourceUrl,
      status: "login_required",
      capturedAt: now,
      summary: "Ollama 需要 API Key",
      windows: [],
      metrics: { hasApiKey: false },
      meta: { entryUrl: sourceUrl },
    });
  }

  const apiBase = (config.apiUrl?.trim() || defaultApiUrl).replace(/\/+$/, "");
  if (!isTrustedOllamaUrl(apiBase)) {
    return createResult({
      providerId: "ollama",
      providerName: "Ollama Pro",
      sourceUrl,
      status: "error",
      capturedAt: now,
      summary: "Ollama API URL 不安全，已拒绝发送请求",
      windows: [],
      metrics: {},
      meta: { entryUrl: sourceUrl },
    });
  }

  // /v1 是 OpenAI 兼容端点；用量接口固定在 /api/usage
  const usageUrl = apiBase.replace(/\/v1$/, "") + "/api/usage";
  const response = await fetchImpl(usageUrl, {
    method: "GET",
    redirect: "manual",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApiMonitor/0.1",
    },
  });

  if (response.status === 401 || response.status === 403) {
    return createResult({
      providerId: "ollama",
      providerName: "Ollama Pro",
      sourceUrl,
      status: "login_required",
      capturedAt: now,
      summary: `Ollama 返回 HTTP ${response.status}，API Key 可能已失效`,
      windows: [],
      metrics: { httpStatus: response.status },
      meta: { entryUrl: sourceUrl },
    });
  }

  if (!response.ok) {
    return createResult({
      providerId: "ollama",
      providerName: "Ollama Pro",
      sourceUrl,
      status: "error",
      capturedAt: now,
      summary: `Ollama 返回 HTTP ${response.status}`,
      windows: [],
      metrics: { httpStatus: response.status },
      meta: { entryUrl: sourceUrl },
    });
  }

  let payload: OllamaUsagePayload;
  try {
    payload = (await response.json()) as OllamaUsagePayload;
  } catch {
    return createResult({
      providerId: "ollama",
      providerName: "Ollama Pro",
      sourceUrl,
      status: "partial",
      capturedAt: now,
      summary: "Ollama 用量响应解析失败",
      windows: [],
      metrics: {},
      meta: { entryUrl: sourceUrl },
    });
  }

  const session = payload.limits?.session;
  const weekly = payload.limits?.weekly;
  const sessionPercent = toPercent(session?.usage);
  const weeklyPercent = toPercent(weekly?.usage);
  const weeklyModels = normalizeModels(weekly);

  const windows: ProviderSnapshot["windows"] = [];
  if (sessionPercent !== null) {
    windows.push({
      key: "rp5h",
      label: "5小时",
      used: sessionPercent,
      limit: 100,
      remaining: Math.max(0, 100 - sessionPercent),
      percentUsed: sessionPercent,
      percentRemaining: Math.max(0, 100 - sessionPercent),
      resetAt: null, // Ollama API 未提供重置时间，前端显示"滚动窗口"
    });
  }
  if (weeklyPercent !== null) {
    windows.push({
      key: "weekly",
      label: "每周",
      used: weeklyPercent,
      limit: 100,
      remaining: Math.max(0, 100 - weeklyPercent),
      percentUsed: weeklyPercent,
      percentRemaining: Math.max(0, 100 - weeklyPercent),
      resetAt: null,
    });
  }

  if (windows.length === 0 && weeklyModels.length === 0) {
    return createResult({
      providerId: "ollama",
      providerName: "Ollama Pro",
      sourceUrl,
      status: "partial",
      capturedAt: now,
      summary: "Ollama 用量接口未返回可用数据",
      windows: [],
      metrics: {},
      meta: { entryUrl: sourceUrl },
    });
  }

  return createResult({
    providerId: "ollama",
    providerName: "Ollama Pro",
    sourceUrl,
    status: "ready",
    capturedAt: now,
    summary: "Ollama Pro 用量已解析",
    windows,
    metrics: {
      sessionUsagePercent: sessionPercent,
      weeklyUsagePercent: weeklyPercent,
      sessionRequestCount: normalizeModels(session).reduce((sum, m) => sum + m.requests, 0),
      weeklyRequestCount: weeklyModels.reduce((sum, m) => sum + m.requests, 0),
      weeklyModelCount: weeklyModels.length,
      weeklyModels: JSON.stringify(weeklyModels),
    },
    meta: { entryUrl: sourceUrl },
  });
}

export const ollama: ProviderDefinition = {
  id: "ollama",
  name: "Ollama Pro",
  sourceUrl: defaultPageUrl,
  description: "Ollama Pro 用量（5小时/周额度 + 本周模型请求数）",
  fetchSnapshot: fetchOllamaSnapshot,
};
```

注意：上面代码中有意用 `toPercent`，若与仓库既有工具函数冲突，保留局部函数即可（见下 Step 4 修正说明）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/worker/providers.test.ts -t "ollama adapter"`
Expected: 4 passed

> 自检：`toPercent` 已在代码顶部定义（Step 3 示例中展示为函数引用，正式实现时保留上方 `function toPercent(value: unknown): number | null` 定义，勿引入未定义符号）。

- [ ] **Step 5: Commit**

```bash
git add worker/providers/ollama.ts tests/worker/providers.test.ts
git commit -m "feat: Ollama Pro provider 用量适配（5小时/周额度 + 模型请求数）"
```

---

### Task 2: 注册 Ollama Provider 并接入 Worker 配置

**Files:**
- Modify: `worker/types.ts`（`ProviderId` 联合类型 + `WorkerEnv`）
- Modify: `worker/providers/registry.ts`
- Modify: `worker/index.ts`（`buildProviderConfig`）
- Modify: `tests/worker/index.test.ts`（provider 列表断言）

- [ ] **Step 1: 更新类型定义**

`worker/types.ts`：

```ts
export type ProviderId =
  | "openrouter"
  | "opencode-go"
  | "xfyun-maas"
  | "aliyun-bailian"
  | "volc-ark"
  | "deepseek"
  | "zhipu"
  | "ollama";
```

`WorkerEnv` 接口追加：

```ts
  OLLAMA_KEY?: string;
  OLLAMA_URL?: string;
  OLLAMA_PAGE_URL?: string;
```

- [ ] **Step 2: 注册 provider**

`worker/providers/registry.ts`：

```ts
import { ollama } from "./ollama";
// PROVIDERS 数组末尾追加:
  ollama,
```

- [ ] **Step 3: buildProviderConfig 增加 ollama 分支**

`worker/index.ts` 中（`zhipu` 分支之后）：

```ts
  if (providerId === "ollama") {
    return {
      pageUrl: env.OLLAMA_PAGE_URL,
      apiUrl: env.OLLAMA_URL,
      apiKey: env.OLLAMA_KEY,
    };
  }
```

- [ ] **Step 4: 更新 index 测试断言**

`tests/worker/index.test.ts`（`isProviderId` / 列表断言处追加）：

```ts
    expect(getProvider("ollama")?.name).toBe("Ollama Pro");
    expect(isProviderId("ollama")).toBe(true);
```

- [ ] **Step 5: 运行相关测试**

Run: `npx vitest run tests/worker/index.test.ts tests/worker/providers.test.ts`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add worker/types.ts worker/providers/registry.ts worker/index.ts tests/worker/index.test.ts
git commit -m "feat: 注册 Ollama provider 到 registry 与 Worker 配置"
```

---

### Task 3: 前端 Ollama 卡片（指标 + 模型列表）

**Files:**
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/components/model-spend-table.tsx`
- Modify: `frontend/src/settings/provider-catalog.ts`
- Modify: `frontend/src/settings/credential-form.tsx`
- Modify: `tests/frontend/apiClient.test.ts`（或新增 `tests/frontend/ollamaMapping.test.ts`）

- [ ] **Step 1: 写前端映射测试（TDD）**

在 `tests/frontend/apiClient.test.ts` 追加用例（沿用文件既有 server→client 映射测试写法）：

```ts
it("maps ollama card windows, detail metrics and model list", async () => {
  const server = {
    kind: "usage_dashboard",
    generatedAt: "2026-08-23T06:00:00.000Z",
    status: "ready",
    summary: "Ollama Pro: ready",
    cards: [
      {
        providerId: "ollama",
        providerName: "Ollama Pro",
        sourceUrl: "https://ollama.com/settings",
        status: "ready",
        summary: "Ollama Pro 用量已解析",
        capturedAt: "2026-08-23T06:00:00.000Z",
        trend: [],
        windows: [
          { key: "rp5h", label: "5小时", used: 6.8, limit: 100, percentUsed: 6.8, resetAt: null },
          { key: "weekly", label: "每周", used: 0.7, limit: 100, percentUsed: 0.7, resetAt: null },
        ],
        metrics: {
          sessionUsagePercent: 6.8,
          weeklyUsagePercent: 0.7,
          weeklyRequestCount: 249,
          weeklyModels: JSON.stringify([
            { name: "deepseek-v4-flash:0731", requests: 239 },
            { name: "kimi-k2.6", requests: 10 },
          ]),
        },
        meta: {},
        selectedAccountId: "ollama:default",
        accounts: [],
      },
    ],
    modelSpends: [],
    totals: { providers: 1, ready: 1, partial: 0, loginRequired: 0, error: 0 },
  };

  const client = createApiClient({ baseUrl: "http://test", fetcher: async () => new Response(JSON.stringify(server)) });
  const dashboard = await client.getUsageDashboard();
  const platform = dashboard.platforms[0];

  expect(platform.quotaWindows.map((w) => w.label)).toEqual(["5小时", "每周"]);
  expect(platform.quotaWindows[0]).toMatchObject({ used: 6.8, resetAt: "滚动窗口" });
  expect(platform.modelSpends).toEqual([
    { model: "deepseek-v4-flash:0731", requests: 239, tokens: 0, spendUsd: 0, share: 239 / 249 },
    { model: "kimi-k2.6", requests: 10, tokens: 0, spendUsd: 0, share: 10 / 249 },
  ]);
  const detail = platform.detailMetrics.map((m) => m.label);
  expect(detail).toContain("5小时用量");
  expect(detail).toContain("本周用量");
  expect(detail).toContain("本周请求数");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/frontend -t "ollama"`
Expected: FAIL（`modelSpends` 仍为空、`resetAt` 为"待同步"、detailMetrics 为空）

- [ ] **Step 3: 实现前端映射**

`frontend/src/api/client.ts`：

a) `resolveAccent` 追加：

```ts
  if (providerId === "ollama") return "#7c3aed";
```

b) `resolveTagline` 追加：

```ts
  if (providerId === "ollama") return "Ollama Pro 用量 / 5小时周额度";
```

c) `resolvePrimaryMetricLabel` 追加：

```ts
  if (providerId === "ollama") return "5小时额度";
```

d) `toQuotaWindow` 的 `resetAt` 保持，但映射处处理 null：

在 `formatResetAt` 前插入：

```ts
function formatOllamaResetAt(providerId: string, value: string | null | undefined): string {
  if (providerId !== "ollama") return formatResetAt(value);
  return value ? formatResetAt(value) : "滚动窗口";
}
```

`toQuotaWindow` 增加 providerId 参数（改动处 `toQuotaWindow(status, window)` → `toQuotaWindow(providerId, status, window)`，同步更新两处调用）。

e) `buildDetailMetrics` 增加 ollama 分支（`providerId === "zhipu"` 前判断）：

```ts
  if (providerId === "ollama") {
    const push = (label: string, value: unknown, formatter?: (n: number) => string) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      items.push({
        label,
        value: formatter ? formatter(value) : `${Math.round(value * 10) / 10}%`,
      });
    };
    push("5小时用量", metrics.sessionUsagePercent);
    push("本周用量", metrics.weeklyUsagePercent);
    push("本周请求数", metrics.weeklyRequestCount, (n) => new Intl.NumberFormat("zh-CN").format(n));
    push("本周模型数", metrics.weeklyModelCount, (n) => new Intl.NumberFormat("zh-CN").format(n));
    return items;
  }
```

f) `mapServerDashboard` 中 ollama 的 `modelSpends` 由 metrics 推导：

```ts
function resolveModelSpends(providerId: string, metrics: Record<string, unknown>): ModelSpendRow[] {
  if (providerId !== "ollama") return [];
  const raw = typeof metrics.weeklyModels === "string" ? metrics.weeklyModels : "[]";
  let models: Array<{ name: string; requests: number }> = [];
  try { models = JSON.parse(raw); } catch { models = []; }
  const total = models.reduce((sum, m) => sum + m.requests, 0);
  return models.map((m) => ({
    model: m.name,
    requests: m.requests,
    tokens: 0,
    spendUsd: 0,
    share: total > 0 ? m.requests / total : 0,
  }));
}
```

在 mapServerDashboard 的 return 中把 `modelSpends: []` 改为：

```ts
      modelSpends: resolveModelSpends(card.providerId, card.metrics),
```

（同时保留函数名 `resolveModelSpends` 与上面一致，勿拼错。）

- [ ] **Step 4: ModelSpendTable 空值显示优化**

`frontend/src/components/model-spend-table.tsx`：

```tsx
<td>{row.tokens > 0 ? formatNumber(row.tokens) : "—"}</td>
<td>{row.spendUsd > 0 ? formatCurrency(row.spendUsd) : "—"}</td>
```

表头不变；Ollama 卡片将显示"模型 / 请求 / Token / 花费 / 占比"（Token 与花费列显示"—"）。

- [ ] **Step 5: 目录与凭据表单**

`frontend/src/settings/provider-catalog.ts` 追加：

```ts
  {
    providerKey: "ollama",
    providerName: "Ollama Pro",
    sourceUrl: "https://ollama.com/settings",
    description: "用量 / 5小时周额度 / 模型请求数",
  },
```

`frontend/src/settings/credential-form.tsx` 的 `credentialFields` 追加：

```ts
  if (providerKey === "ollama") return ["apiKey", "apiUrl"];
```

- [ ] **Step 6: 运行前端测试**

Run: `npm run test:frontend`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/components/model-spend-table.tsx frontend/src/settings/provider-catalog.ts frontend/src/settings/credential-form.tsx tests/frontend
git commit -m "feat: Ollama Pro 看板前端（5小时/周指标 + 模型请求列表）"
```

---

### Task 4: 全量验证

**Files:** 无

- [ ] **Step 1: 全量测试**

Run: `npm run test`
Expected: 0 failures

- [ ] **Step 2: 构建与类型检查**

Run: `npm run build`
Expected: 构建成功，无 TS 报错

Run: `npx vitest run tests/worker -t "ollama"`（worker 定向再确认）
Expected: PASS

- [ ] **Step 3: 检查 git 状态与敏感文件**

Run: `git status --short`、`git ls-files | rg -i "ollama|\.env$"`
Expected: 仅新增计划内文件；`.env` 不在跟踪列表；无 `scripts/explore-ollama-settings.ts` 残留

- [ ] **Step 4: Commit（如未提交）**

```bash
git add -A
git commit -m "feat: Ollama Pro 看板（provider + 前端 + 测试）"
```

---

### Task 5: 部署与凭据落地（需用户执行/确认）

**Files:** 无（配置操作）

- [ ] **Step 1: Worker secret 设置**

在本地执行（Ollama Key 直接作为 secret，不写入源码）：

```bash
cmd /c "npx wrangler secret put OLLAMA_KEY"
```

输入 .env 中 `OLLAMA_KEY` 的值。同时在 `wrangler.toml` 的 `vars` 中确认 `OLLAMA_URL`（非敏感，可放 vars 或 secret；`OLLAMA_PAGE_URL` 同理）。

- [ ] **Step 2: 看板验证**

打开前端看板，确认：
- 出现 "Ollama Pro" 卡片（5小时 / 每周两个窗口，显示百分比与"滚动窗口"重置说明）
- 指标卡显示 5小时用量%、本周用量%、本周请求数、本周模型数
- 模型表格按请求数降序列出本周使用过的模型（含请求数）
- 卡片"打开看板"跳转 `https://ollama.com/settings`

---

## Self-Review（已完成）

- **Spec 覆盖**：5小时额度（Task 1 windows rp5h）✔；周额度（weekly）✔；Models used this week 列表（Task 3 resolveModelSpends + ModelSpendTable）✔；账号/密码仅存 .env 与 Worker secret、Key 不暴露前端（Task 5 + provider 白名单）✔。
- **占位符检查**：无 TBD/TODO；所有代码步骤给出完整代码与预期输出。
- **类型一致性**：`weeklyModels` 始终为 JSON 字符串（provider 写入、前端解析）；`resolveModelSpends` 名称在 Task 3 Step 3 中统一；`toQuotaWindow` 增加 providerId 参数后两处调用同步更新。
- **已知限制（诚实声明）**：Ollama `/api/usage` 未暴露重置时间字段，本期窗口展示"滚动窗口"；若 Task 0 抓包发现额外接口，可在 Task 1 中补充 `resetAt` 解析。
