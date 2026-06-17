# OpenCode Go 本地抓取 + Worker Ingest 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 Worker `/api/ingest/opencode-go` 端点接收外部推送的快照，并新建本地脚本从浏览器抓取 OpenCode Go 用量页解析后推送，绕开 Worker 被 opencode 数据中心 IP 封锁的问题。

**Architecture:** 本地脚本用浏览器 profile 的 auth cookie 抓取 opencode 用量页（国内 IP 可达）→ 复用 `parseOpenCodeGoWindows` 解析 → 构造标准 `ProviderSnapshot` → POST 到 Worker ingest 端点（`X-Ingest-Key` 鉴权）→ Worker 复用 `persistSnapshot` 落库 → 看板展示最近成功快照。

**Tech Stack:** Cloudflare Workers（TypeScript）+ Vitest（@cloudflare/vitest-pool-workers）+ Node 24 `--experimental-strip-types` + Playwright

---

## 约束与证据

- opencode 屏蔽数据中心 IP（判别测试：直连国内 IP 与 Aurora 代理 IP 均 200 命中用量；Cloudflare Worker IP 302 到 login）。设计文档见 `docs/superpowers/specs/2026-06-17-opencode-local-ingest-design.md`
- 解析器已存在：`worker/providers/opencode-go-parser.ts` 的 `parseOpenCodeGoWindows(html, now)`
- 落库函数已存在：`worker/index.ts` 的 `persistSnapshot(env, userId, snapshot, decision)`，decision 传 null 时不记 refresh_event
- HTTP 工具已存在：`worker/http.ts` 的 `successResponse` / `errorResponse` / `readJsonBody`
- 共享类型：`worker/types.ts` 的 `ProviderSnapshot`、`WorkerEnv`、`ProviderStatus`
- 不引入新依赖；脚本用 Node 24 原生 `--experimental-strip-types` 运行
- 浏览器 cookie 提取逻辑已在 `scripts/refresh-opencode-cookie.ts` 验证可用（Edge 优先，`launchPersistentContext` + `channel: "msedge"`），本计划复用其模式
- 不改前端、不改 Durable Object 节流；ingest 是外部推送，不走刷新节流

---

## 文件结构

- Create: `worker/ingest.ts`
  ingest 端点的 handler。单一职责：鉴权 → 校验 snapshot → 调 persistSnapshot。从 `index.ts` 的路由分发调用。
- Modify: `worker/index.ts`
  在 `handleApiRequest` 增加路由分支 `POST /api/ingest/opencode-go` → 调 `handleIngestOpenCodeGo`。import 新 handler。
- Modify: `worker/types.ts`
  `WorkerEnv` 增加 `INGEST_API_KEY?: string`。
- Modify: `.env.example`
  增加 `INGEST_API_KEY` 与 `APIMONITOR_INGEST_URL` 占位说明。
- Create: `scripts/refresh-opencode-usage.ts`
  本地抓取 + 解析 + 推送脚本。
- Create: `tests/worker/ingest.test.ts`
  ingest 端点单元测试：合法落库、鉴权失败、providerId 校验、windows 校验。

---

### Task 1: WorkerEnv 增加 INGEST_API_KEY 字段

**Files:**
- Modify: `worker/types.ts`

- [ ] **Step 1: 在 WorkerEnv 增加 INGEST_API_KEY**

打开 `worker/types.ts`，找到 `WorkerEnv` 接口中 `OPENCODE_GO_API_KEY?: string;` 这一行（约 182 行），在其下方新增一行：

```typescript
  INGEST_API_KEY?: string;
```

修改后该区域应为：

```typescript
  OPENCODE_GO_WORKSPACE_ID?: string;
  OPENCODE_GO_AUTH_COOKIE?: string;
  OPENCODE_GO_API_KEY?: string;
  INGEST_API_KEY?: string;
  OPENCODE_GO_BASE_URL?: string;
```

- [ ] **Step 2: 验证类型检查**

```bash
npm run build
```

Expected: 构建通过，无类型错误。

- [ ] **Step 3: 提交**

```bash
git add worker/types.ts
git commit -m "feat: add INGEST_API_KEY to WorkerEnv"
```

---

### Task 2: 创建 ingest handler 与类型（TDD）

**Files:**
- Create: `worker/ingest.ts`
- Create: `tests/worker/ingest.test.ts`

- [ ] **Step 1: 写失败测试 — 合法 snapshot 落库**

创建 `tests/worker/ingest.test.ts`：

```typescript
import { describe, expect, it, vi } from "vitest";

import { handleIngestOpenCodeGo } from "../../worker/ingest";
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
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run test:worker -- ingest.test
```

Expected: FAIL — 找不到 `../../worker/ingest` 模块。

- [ ] **Step 3: 实现 ingest handler**

创建 `worker/ingest.ts`：

```typescript
import { errorResponse, readJsonBody, successResponse } from "./http";
import { persistSnapshot } from "./index";
import type { ProviderId, ProviderSnapshot, ProviderStatus, WorkerEnv } from "./types";

const VALID_STATUSES: ProviderStatus[] = ["ready", "partial", "login_required", "disabled", "error"];

type IngestBody = {
  snapshot?: Partial<ProviderSnapshot>;
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function handleIngestOpenCodeGo(request: Request, env: WorkerEnv): Promise<Response> {
  const expectedKey = env.INGEST_API_KEY;
  if (!expectedKey) {
    return errorResponse(503, "ingest_disabled", "Ingest endpoint is not configured");
  }
  const providedKey = request.headers.get("x-ingest-key") ?? "";
  if (!timingSafeEqual(providedKey, expectedKey)) {
    return errorResponse(401, "unauthorized", "Invalid ingest key");
  }

  let body: IngestBody;
  try {
    body = await readJsonBody<IngestBody>(request);
  } catch {
    return errorResponse(400, "invalid_request", "Request body must be JSON");
  }

  const snapshot = body.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return errorResponse(400, "invalid_request", "Missing snapshot in body");
  }
  if (snapshot.providerId !== "opencode-go") {
    return errorResponse(400, "invalid_provider", "Ingest only accepts opencode-go snapshots");
  }
  if (!snapshot.status || !VALID_STATUSES.includes(snapshot.status)) {
    return errorResponse(400, "invalid_request", "Invalid snapshot status");
  }
  if (!Array.isArray(snapshot.windows) || snapshot.windows.length === 0) {
    return errorResponse(400, "invalid_request", "Snapshot must contain at least one window");
  }
  if (!snapshot.capturedAt || typeof snapshot.capturedAt !== "string") {
    return errorResponse(400, "invalid_request", "Snapshot must include capturedAt");
  }

  const normalized: ProviderSnapshot = {
    providerId: "opencode-go" as ProviderId,
    providerName: snapshot.providerName ?? "OpenCode Go",
    sourceUrl: snapshot.sourceUrl ?? "",
    status: snapshot.status,
    capturedAt: snapshot.capturedAt,
    summary: snapshot.summary ?? "OpenCode Go usage windows parsed",
    windows: snapshot.windows,
    metrics: snapshot.metrics ?? {},
    meta: { ...(snapshot.meta ?? {}), fetchMethod: "local_ingest" },
  };

  const userId = env.SUPABASE_USER_ID ?? null;
  await persistSnapshot(env, userId, normalized, null);

  return successResponse({ capturedAt: normalized.capturedAt, providerId: normalized.providerId });
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run test:worker -- ingest.test
```

Expected: 4 个测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add worker/ingest.ts tests/worker/ingest.test.ts
git commit -m "feat: add opencode-go ingest endpoint with auth and validation"
```

---

### Task 3: 在 index.ts 路由分发 ingest 端点

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: import ingest handler**

打开 `worker/index.ts`，在顶部 import 区（约第 8 行 `import { requireUser } from "./auth";` 之后）新增一行：

```typescript
import { handleIngestOpenCodeGo } from "./ingest";
```

- [ ] **Step 2: 增加路由分支**

在 `handleApiRequest` 函数中，找到 `if (request.method === "POST" && url.pathname === "/api/refresh") {` 这一行（约 729 行），在其**上方**新增：

```typescript
  if (request.method === "POST" && url.pathname === "/api/ingest/opencode-go") {
    return handleIngestOpenCodeGo(request, env);
  }
```

- [ ] **Step 3: 验证类型检查**

```bash
npm run build
```

Expected: 构建通过。

- [ ] **Step 4: 跑全部 worker 测试确认无回归**

```bash
npm run test:worker
```

Expected: 所有测试通过，包括新增的 ingest 测试和已有测试。

- [ ] **Step 5: 提交**

```bash
git add worker/index.ts
git commit -m "feat: route POST /api/ingest/opencode-go to ingest handler"
```

---

### Task 4: 配置生产 INGEST_API_KEY secret

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: 更新 .env.example 占位**

打开 `.env.example`，在文件末尾新增：

```
# 本地脚本推送 opencode 用量快照时使用的共享密钥（Worker 端需配置同名 secret）
INGEST_API_KEY="replace-with-random-32-char-secret"
# 本地脚本推送目标（Worker 线上地址）
APIMONITOR_INGEST_URL="https://apimonitor.jarvislee90s.workers.dev"
```

- [ ] **Step 2: 生成密钥并写入本地 .env**

生成一个 32 字符随机密钥并追加到本地 `.env`（不提交 .env）：

```bash
node -e "const c='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';let s='';for(let i=0;i<32;i++)s+=c[Math.floor(Math.random()*c.length)];console.log(s)" >> /dev/null
```

把上面命令输出的密钥，以如下格式手动追加到 `.env`（替换 `<输出>` 为实际密钥）：

```
INGEST_API_KEY=<输出>
APIMONITOR_INGEST_URL=https://apimonitor.jarvislee90s.workers.dev
```

注意：不要把 `.env` 加入 git。

- [ ] **Step 3: 设置生产 Worker secret**

用 Cloudflare API 把同一个密钥写入生产 Worker（复用 `.env` 里的 `CLOUDFLARE_API_TOKEN`，密钥值与上一步相同）。运行：

```bash
node --experimental-strip-types -e "
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const c = readFileSync(resolve(process.cwd(),'.env'),'utf-8');
const get = k => c.split('\n').find(l=>l.startsWith(k+'=')).slice(k.length+1).trim().replace(/^\"|\"$/g,'');
const token = get('CLOUDFLARE_API_TOKEN');
const key = get('INGEST_API_KEY');
const ar = await fetch('https://api.cloudflare.com/client/v4/accounts',{headers:{Authorization:'Bearer '+token}});
const aj = await ar.json();
const aid = aj.result[0].id;
const r = await fetch('https://api.cloudflare.com/client/v4/accounts/'+aid+'/workers/scripts/apimonitor/secrets',{
  method:'PUT',
  headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
  body:JSON.stringify({name:'INGEST_API_KEY',text:key,type:'secret_text'})
});
const j = await r.json();
console.log('INGEST_API_KEY secret set:', j.success);
"
```

Expected: `INGEST_API_KEY secret set: true`

- [ ] **Step 4: 提交 .env.example**

```bash
git add .env.example
git commit -m "docs: add INGEST_API_KEY and APIMONITOR_INGEST_URL to env example"
```

---

### Task 5: 创建本地抓取脚本骨架 + env 读取

**Files:**
- Create: `scripts/refresh-opencode-usage.ts`

- [ ] **Step 1: 写脚本骨架（env 读取 + 浏览器目标）**

创建 `scripts/refresh-opencode-usage.ts`：

```typescript
/**
 * OpenCode Go 用量抓取脚本
 *
 * 功能：从本地浏览器 Profile 提取 auth cookie，抓取 opencode 用量页，
 *       解析为标准快照后推送到 Worker 的 /api/ingest/opencode-go 端点。
 *       绕开 Worker 被 opencode 数据中心 IP 封锁的问题。
 *
 * 前置条件：
 *   1. Edge 或 Chrome 浏览器中已登录 https://opencode.ai
 *   2. 运行前关闭所有浏览器窗口（含后台进程），避免 Profile 锁定
 *   3. .env 中已配置 INGEST_API_KEY、APIMONITOR_INGEST_URL、OPENCODE_GO_WORKSPACE_ID
 *
 * 使用：
 *   node --experimental-strip-types scripts/refresh-opencode-usage.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), ".env");
  const content = readFileSync(envPath, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
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

const localAppData = process.env.LOCALAPPDATA ?? resolve(process.env.HOME ?? "", "AppData/Local");

// 支持的浏览器列表，按优先级排序：Edge 优先（无 DevTools 远程调试限制）
const BROWSER_TARGETS = [
  {
    name: "Edge",
    userDataDir: resolve(localAppData, "Microsoft/Edge/User Data"),
    channel: "msedge" as const,
  },
  {
    name: "Chrome",
    userDataDir: resolve(localAppData, "Google/Chrome/User Data"),
    channel: "chrome" as const,
  },
];

async function main(): Promise<void> {
  const env = loadEnv();
  console.log("✅ 环境变量加载成功");

  const missing = ["INGEST_API_KEY", "APIMONITOR_INGEST_URL", "OPENCODE_GO_WORKSPACE_ID"].filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`缺少环境变量: ${missing.join(", ")}。请在 .env 中配置。`);
    process.exit(1);
  }
  console.log(`   推送目标: ${env.APIMONITOR_INGEST_URL}`);
}

main().catch((err) => {
  console.error("❌ 脚本执行失败:", err);
  process.exit(1);
});
```

- [ ] **Step 2: 运行验证骨架**

```bash
node --experimental-strip-types scripts/refresh-opencode-usage.ts
```

Expected: `✅ 环境变量加载成功` 与 `   推送目标: https://apimonitor.jarvislee90s.workers.dev`

- [ ] **Step 3: 提交**

```bash
git add scripts/refresh-opencode-usage.ts
git commit -m "feat: add opencode usage ingest script skeleton"
```

---

### Task 6: 脚本提取 cookie + 抓取用量页 + 解析

**Files:**
- Modify: `scripts/refresh-opencode-usage.ts`

- [ ] **Step 1: 添加解析函数（移植自 worker/providers/opencode-go-parser.ts）**

在 `BROWSER_TARGETS` 定义之后、`main` 之前，新增解析逻辑（与 Worker 端 parser 保持一致，避免跨 Worker 运行时 import）：

```typescript
// 以下解析逻辑移植自 worker/providers/opencode-go-parser.ts，保持一致
const WINDOW_KEYS = ["rolling", "weekly", "monthly"] as const;
type WindowKey = (typeof WINDOW_KEYS)[number];

function toBeijingOffsetIso(date: Date): string {
  const beijingDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return beijingDate.toISOString().replace(/\.\d{3}Z$/, "+08:00");
}

function parseWindow(html: string, key: WindowKey): { used: number; resetInSec?: number } | null {
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

function parseOpenCodeGoWindows(html: string, now: Date): Array<{
  key: string;
  label: string;
  used: number;
  limit: number;
  remaining: number;
  percentUsed: number;
  percentRemaining: number;
  resetAt: string | null;
}> {
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

- [ ] **Step 2: 在 main 中添加 cookie 提取与用量页抓取**

把 `main` 函数中 `console.log(\`   推送目标: ...\`)` 之后到函数结束的部分，替换为完整的提取+抓取+解析逻辑：

```typescript
  console.log(`   推送目标: ${env.APIMONITOR_INGEST_URL}`);

  const workspaceId = env.OPENCODE_GO_WORKSPACE_ID;
  const sourceUrl = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;

  const { chromium } = await import("playwright");

  let authCookieValue: string | undefined;

  for (const target of BROWSER_TARGETS) {
    const userDataDir = process.env.BROWSER_USER_DATA_DIR ?? target.userDataDir;
    console.log(`🔧 尝试 ${target.name}（${userDataDir}）...`);

    let context: import("playwright").BrowserContext | null = null;
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        channel: target.channel,
        args: ["--disable-blink-features=AutomationControlled"],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("lock") || msg.includes("singleton") || msg.includes("closed")) {
        console.error(`   ⚠️ ${target.name} 启动失败（可能仍在运行或 Profile 被占用）。请完全关闭所有 ${target.name} 进程后重试。`);
        continue;
      }
      console.error(`   ⚠️ ${target.name} 启动失败:`, msg.substring(0, 120));
      continue;
    }

    try {
      const page = await context.newPage();
      await page.goto("https://opencode.ai", { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(2_000);

      const cookies = await context.cookies();
      const authCookie = cookies.find((c) => c.name === "auth" && c.domain.includes("opencode.ai"));
      if (!authCookie) {
        console.log(`   ℹ️ ${target.name} 中未找到 opencode.ai auth cookie`);
        continue;
      }
      authCookieValue = authCookie.value;
      console.log(`✅ 从 ${target.name} 提取到 auth cookie（${authCookieValue.length} 字符）`);
      break;
    } finally {
      await context.close();
    }
  }

  if (!authCookieValue) {
    console.error("❌ 在所有浏览器中均未找到 opencode.ai auth cookie。请确认已登录。");
    process.exit(1);
  }

  // 抓取用量页（本地直连国内 IP 可达）
  console.log("🌐 抓取 OpenCode Go 用量页...");
  const resp = await fetch(sourceUrl, {
    redirect: "manual",
    headers: {
      Cookie: `auth=${authCookieValue}`,
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApiMonitor/0.1",
    },
  });

  if (resp.status >= 300 && resp.status < 400) {
    const location = resp.headers.get("location") ?? "";
    console.error(`❌ 被重定向到登录页: ${location}（cookie 无效或当前出口 IP 被封）`);
    process.exit(1);
  }
  if (!resp.ok) {
    console.error(`❌ 用量页返回 HTTP ${resp.status}`);
    process.exit(1);
  }

  const html = await resp.text();
  const now = new Date();
  const windows = parseOpenCodeGoWindows(html, now);
  if (windows.length === 0) {
    console.error("❌ 页面已加载但未找到用量窗口数据");
    process.exit(1);
  }
  console.log(`✅ 解析到 ${windows.length} 个用量窗口: ${windows.map((w) => `${w.key}=${w.used}%`).join(", ")}`);
```

- [ ] **Step 3: 运行验证抓取+解析**

确保 Edge 已关闭后运行：

```bash
node --experimental-strip-types scripts/refresh-opencode-usage.ts
```

Expected: 输出提取 cookie → 抓取用量页 → `✅ 解析到 3 个用量窗口: rolling=N%, weekly=N%, monthly=N%`（脚本会在推送前因尚未实现推送而结束，属正常）。

- [ ] **Step 4: 提交**

```bash
git add scripts/refresh-opencode-usage.ts
git commit -m "feat: extract cookie and parse opencode usage windows in ingest script"
```

---

### Task 7: 脚本推送快照到 ingest 端点

**Files:**
- Modify: `scripts/refresh-opencode-usage.ts`

- [ ] **Step 1: 在 main 末尾添加构造 snapshot 与 POST 推送**

在 `console.log(\`✅ 解析到 ...\`)` 之后，main 函数末尾（`}` 之前）追加：

```typescript
  // 构造标准快照（字段与 worker/providers/opencode-go.ts 的 createResult 对齐）
  const capturedAt = now.toISOString();
  const snapshot = {
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    sourceUrl,
    status: "ready" as const,
    capturedAt,
    summary: "OpenCode Go usage windows parsed",
    windows,
    metrics: {
      hasRolling: windows.some((w) => w.key === "rolling"),
      hasWeekly: windows.some((w) => w.key === "weekly"),
      hasMonthly: windows.some((w) => w.key === "monthly"),
    },
    meta: { fetchMethod: "local_ingest" },
  };

  // 推送到 Worker ingest 端点
  console.log("📤 推送快照到 Worker ingest 端点...");
  const ingestUrl = `${env.APIMONITOR_INGEST_URL.replace(/\/$/, "")}/api/ingest/opencode-go`;
  const ingestResp = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      "X-Ingest-Key": env.INGEST_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ snapshot }),
  });

  if (ingestResp.status === 401) {
    console.error("❌ 推送鉴权失败：INGEST_API_KEY 与 Worker 端不一致");
    process.exit(1);
  }
  if (!ingestResp.ok) {
    const errorBody = await ingestResp.text();
    console.error(`❌ 推送失败: HTTP ${ingestResp.status} - ${errorBody}`);
    process.exit(1);
  }

  const result = (await ingestResp.json()) as { ok: boolean; data?: { capturedAt: string } };
  console.log(`🎉 完成！快照已推送（capturedAt: ${result.data?.capturedAt ?? capturedAt}）`);
  console.log("   看板下次加载 /api/usage 将展示该快照（最近成功快照回退）。");
```

- [ ] **Step 2: 运行完整脚本（端到端）**

确保 Edge 已关闭，Worker 已部署（Task 8 之后）后运行：

```bash
node --experimental-strip-types scripts/refresh-opencode-usage.ts
```

Expected: 提取 cookie → 抓取 → 解析 → `🎉 完成！快照已推送`。

注：此步骤要求 Task 8 部署已完成；若先跑到此步且 ingest 端点未上线，会收到 404，需先完成 Task 8 再重跑。

- [ ] **Step 3: 提交**

```bash
git add scripts/refresh-opencode-usage.ts
git commit -m "feat: push parsed opencode snapshot to worker ingest endpoint"
```

---

### Task 8: 部署 Worker 并端到端验证

**Files:**
- 无文件改动

- [ ] **Step 1: 部署 Worker**

```bash
npm run deploy:worker
```

Expected: 部署成功，输出 Worker URL `https://apimonitor.jarvislee90s.workers.dev`。

- [ ] **Step 2: 运行脚本推送真实快照**

确保 Edge 已关闭后运行：

```bash
node --experimental-strip-types scripts/refresh-opencode-usage.ts
```

Expected: 全流程通过，`🎉 完成！快照已推送`。

- [ ] **Step 3: 验证看板展示实时数据**

用 Playwright headless chromium 打开看板验证（本地 curl 可能连不上 workers.dev）：

```bash
node --experimental-strip-types -e "
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('https://apimonitor.jarvislee90s.workers.dev/', { waitUntil: 'domcontentloaded', timeout: 30000 });
const data = await page.evaluate(async () => {
  const r = await fetch('/api/usage');
  return r.json();
});
const card = data.data?.cards?.find(c => c.providerId === 'opencode-go');
const acct = card?.accounts?.[0] ?? card;
console.log('status:', acct?.status);
console.log('capturedAt:', acct?.capturedAt);
console.log('meta:', JSON.stringify(acct?.meta ?? {}));
console.log('windows:', JSON.stringify((acct?.windows ?? []).map(w => ({key:w.key, used:w.used, pct:w.percentUsed}))));
await browser.close();
"
```

Expected: `status: ready`；`capturedAt` 为刚才推送的时间（约当前时间）；`meta.fetchMethod` 为 `local_ingest`；windows 为实时用量值。

- [ ] **Step 4: 更新 README 使用说明（可选）**

在 `README.md` 适当位置补充脚本使用说明，描述：cookie 过期时关闭浏览器后运行 `node --experimental-strip-types scripts/refresh-opencode-usage.ts` 即可刷新看板数据。若 README 无合适位置可跳过此步。

---

## 自检结果

- **Spec coverage**：
  - Worker ingest 端点 + 鉴权 + 校验 → Task 2/3 ✅
  - WorkerEnv INGEST_API_KEY → Task 1 ✅
  - 本地脚本抓取+解析+推送 → Task 5/6/7 ✅
  - 配置（.env.example + 生产 secret）→ Task 4 ✅
  - 复用 parseOpenCodeGoWindows → Task 6 Step 1（移植，保持一致）✅
  - 复用 persistSnapshot → Task 2 Step 3 ✅
  - 端到端验证 → Task 8 ✅
  - 安全（ingest 只接受 opencode-go、timing-safe 比较、key 不进前端）→ Task 2 ✅
- **Placeholder scan**：无 TBD/TODO；所有代码步骤含完整代码；命令含 expected 输出。
- **Type consistency**：`ProviderSnapshot` 字段、`persistSnapshot(env, userId, snapshot, null)` 签名、`X-Ingest-Key` header 名、`fetchMethod: "local_ingest"` 在 ingest handler 与脚本中一致；WorkerEnv.INGEST_API_KEY 在 types/ingest/script/.env.example 一致。
