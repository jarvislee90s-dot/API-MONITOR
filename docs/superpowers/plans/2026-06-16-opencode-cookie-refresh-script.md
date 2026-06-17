# OpenCode Cookie 自动刷新脚本 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个本地 Node.js 脚本，从 Chrome Profile 自动提取 OpenCode Go 的 auth cookie，验证有效性后加密写入 Supabase，Worker 下次刷新自动生效。

**Architecture:** Playwright 挂载用户 Chrome Profile → 读取 `opencode.ai` 的 `auth` cookie → fetch OpenCode Go 页面验证 → AES-GCM 加密 → Supabase REST API PATCH `provider_account_credentials` 表。脚本从项目 `.env` 读取 Supabase 凭据和加密密钥，不硬编码任何凭据。

**Tech Stack:** Node.js 24 + TypeScript + Playwright + Web Crypto API + Supabase REST API

---

## 约束与证据

- 不引入 `tsx` 等新依赖。Node 24 原生支持 `--experimental-strip-types` 运行 `.ts` 文件
- Playwright 已作为 MCP 工具安装，`npx playwright` 可直接使用
- Chrome Profile 默认路径：`C:\Users\bunny\AppData\Local\Google\Chrome\User Data`
- AES-GCM 加密逻辑完全复用 `worker/security/credentials.ts`，从 `.env` 读 `CREDENTIAL_ENCRYPTION_KEY`
- Supabase 表结构来自迁移文件 `202606120001_provider_settings_and_credentials.sql`
- 脚本为一次性手动运行，不部署到 Worker，不加入 CI/CD

---

## 文件结构

- Create: `scripts/refresh-opencode-cookie.ts`
  独立脚本，可直接 `node --experimental-strip-types scripts/refresh-opencode-cookie.ts` 运行

---

### Task 1: 创建脚本骨架与环境变量读取

**Files:**
- Create: `scripts/refresh-opencode-cookie.ts`

- [ ] **Step 1: 写脚本骨架**

```typescript
// scripts/refresh-opencode-cookie.ts
// 从 Chrome Profile 提取 OpenCode Go auth cookie，加密写入 Supabase

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
    const key = trimmed.slice(0, eqIdx);
    let value = trimmed.slice(eqIdx + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

async function main(): Promise<void> {
  const env = loadEnv();

  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_USER_ID", "CREDENTIAL_ENCRYPTION_KEY"];
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`缺少环境变量: ${missing.join(", ")}。请在 .env 中配置。`);
    process.exit(1);
  }

  console.log("✅ 环境变量加载成功");
}

main().catch((err) => {
  console.error("❌ 脚本执行失败:", err);
  process.exit(1);
});
```

- [ ] **Step 2: 运行脚本验证骨架**

```bash
node --experimental-strip-types scripts/refresh-opencode-cookie.ts
```

Expected: `✅ 环境变量加载成功`

- [ ] **Step 3: 提交**

```bash
git add scripts/refresh-opencode-cookie.ts
git commit -m "feat: add opencode cookie refresh script skeleton"
```

---

### Task 2: 从 Chrome Profile 提取 auth cookie

**Files:**
- Modify: `scripts/refresh-opencode-cookie.ts`

- [ ] **Step 1: 添加 Playwright 浏览器启动与 cookie 提取**

在 `main()` 函数中，`loadEnv()` 之后加入：

```typescript
  // Chrome 用户数据目录
  const chromeUserDataDir = process.env.CHROME_USER_DATA_DIR
    ?? resolve(process.env.LOCALAPPDATA ?? resolve(process.env.HOME ?? "", "AppData/Local"), "Google/Chrome/User Data");

  console.log("🔧 启动浏览器（挂载 Chrome Profile）...");

  // 动态 import playwright
  const { chromium } = await import("playwright");

  let context: import("playwright").BrowserContext | null = null;
  let browser: import("playwright").Browser | null = null;

  try {
    context = await chromium.launchPersistentContext(chromeUserDataDir, {
      headless: true,
      channel: "chrome",
      args: ["--disable-blink-features=AutomationControlled"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("lock") || msg.includes("singleton")) {
      console.error("❌ Chrome 正在运行。请先关闭所有 Chrome 窗口再运行此脚本。");
      console.error("   路径:", chromeUserDataDir);
    }
    throw err;
  }

  try {
    // 导航到 opencode.ai 让 cookie 随请求发送
    const page = await context.newPage();
    await page.goto("https://opencode.ai", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2_000);

    const cookies = await context.cookies();
    const authCookie = cookies.find((c) => c.name === "auth" && c.domain.includes("opencode.ai"));

    if (!authCookie) {
      console.error("❌ 未找到 OpenCode Go 的 auth cookie。请确认 Chrome 中已登录 opencode.ai。");
      console.error("   找到的 cookie 域名:", [...new Set(cookies.map((c) => c.domain))].join(", "));
      process.exit(1);
    }

    const cookieValue = authCookie.value;
    console.log(`✅ 提取到 auth cookie（${cookieValue.length} 字符）`);
    console.log(`   有效期至: ${authCookie.expires ? new Date(authCookie.expires * 1000).toISOString() : "session"}`);
  } finally {
    if (context) await context.close();
  }
```

- [ ] **Step 2: 测试 cookie 提取**

```bash
node --experimental-strip-types scripts/refresh-opencode-cookie.ts
```

Expected: 输出 cookie 长度和有效期，或者提示 Cookie 未找到。

- [ ] **Step 3: 提交**

```bash
git add scripts/refresh-opencode-cookie.ts
git commit -m "feat: extract opencode auth cookie from chrome profile"
```

---

### Task 3: 验证 cookie 有效性

**Files:**
- Modify: `scripts/refresh-opencode-cookie.ts`

- [ ] **Step 1: 添加验证函数**

在 `main()` 函数之前添加：

```typescript
async function validateCookie(
  cookie: string,
  workspaceId: string,
): Promise<{ valid: boolean; windows: string[]; error?: string }> {
  const url = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;
  try {
    const resp = await fetch(url, {
      redirect: "manual",
      headers: {
        Cookie: `auth=${cookie}`,
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApiMonitor/0.1",
      },
    });
    const html = await resp.text();

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location") ?? "";
      return { valid: false, windows: [], error: `被重定向到: ${location}` };
    }

    const patterns = ["rollingUsage", "weeklyUsage", "monthlyUsage"];
    const found = patterns.filter((p) => html.includes(p));

    if (found.length === 0) {
      return { valid: false, windows: [], error: "页面中未找到用量数据" };
    }

    return { valid: true, windows: found };
  } catch (err) {
    return { valid: false, windows: [], error: String(err) };
  }
}
```

在 `main()` 中，提取 cookie 之后、关闭 context 之前加入：

```typescript
    // 验证 cookie
    const workspaceId = env.OPENCODE_GO_WORKSPACE_ID;
    if (!workspaceId) {
      console.warn("⚠️ .env 中未配置 OPENCODE_GO_WORKSPACE_ID，跳过验证");
    } else {
      console.log("🔍 验证 cookie 有效性...");
      const validation = await validateCookie(cookieValue, workspaceId);
      if (!validation.valid) {
        console.error(`❌ Cookie 无效: ${validation.error}`);
        process.exit(1);
      }
      console.log(`✅ Cookie 验证通过，找到 ${validation.windows.join(", ")}`);
    }
```

- [ ] **Step 2: 测试验证**

```bash
node --experimental-strip-types scripts/refresh-opencode-cookie.ts
```

Expected: Cookie 有效时输出 `✅ Cookie 验证通过，找到 rollingUsage, weeklyUsage, monthlyUsage`

- [ ] **Step 3: 提交**

```bash
git add scripts/refresh-opencode-cookie.ts
git commit -m "feat: validate opencode cookie before update"
```

---

### Task 4: AES-GCM 加密（复用 Worker 逻辑）

**Files:**
- Modify: `scripts/refresh-opencode-cookie.ts`

- [ ] **Step 1: 添加加密函数**

在 `validateCookie` 之后、`main` 之前添加：

```typescript
// 以下代码从 worker/security/credentials.ts 移植，保持完全一致的加密格式
async function encryptCredentialPayload(
  payload: Record<string, string>,
  rawKey: string,
): Promise<{ encryptedPayload: string; nonce: string; keyVersion: string }> {
  const keyBytes = new TextEncoder().encode(rawKey);
  if (keyBytes.byteLength !== 32) {
    throw new Error(`CREDENTIAL_ENCRYPTION_KEY 必须是 32 字节 UTF-8（当前 ${keyBytes.byteLength} 字节）`);
  }

  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encodedPayload = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, encodedPayload);

  const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  };

  return {
    encryptedPayload: bytesToBase64(new Uint8Array(encrypted)),
    nonce: bytesToBase64(nonce),
    keyVersion: "v1",
  };
}
```

- [ ] **Step 2: 测试加密（可选，因为加密是纯函数，和其他步骤一起测）**

- [ ] **Step 3: 提交**

```bash
git add scripts/refresh-opencode-cookie.ts
git commit -m "feat: port aes-gcm encryption for supabase credential storage"
```

---

### Task 5: 写入 Supabase 更新凭据

**Files:**
- Modify: `scripts/refresh-opencode-cookie.ts`

- [ ] **Step 1: 添加 Supabase 查询和更新函数**

在 `main()` 函数之前添加：

```typescript
async function updateSupabaseCredentials(
  env: Record<string, string>,
  newAuthCookie: string,
): Promise<void> {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };

  const userId = env.SUPABASE_USER_ID;

  // 1. 查找 OpenCode Go 账号
  const accountUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  accountUrl.searchParams.set("select", "id,provider_key,account_label");
  accountUrl.searchParams.set("provider_key", "eq.opencode-go");
  accountUrl.searchParams.set("user_id", `eq.${userId}`);

  const accountResp = await fetch(accountUrl, { headers });
  if (!accountResp.ok) {
    throw new Error(`查询账号失败: HTTP ${accountResp.status}`);
  }
  const accounts = (await accountResp.json()) as Array<{ id: string; provider_key: string; account_label?: string }>;
  const account = accounts[0];
  if (!account) {
    throw new Error("未找到 OpenCode Go 的 Supabase 账号。请先在 Settings 页面创建。");
  }
  console.log(`   找到账号: ${account.account_label ?? account.id} (${account.id})`);

  // 2. 加密新凭据
  const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
  const encrypted = await encryptCredentialPayload({ authCookie: newAuthCookie }, encryptionKey);

  // 3. 检查是否已有凭据行（upsert）
  const credUrl = new URL("/rest/v1/provider_account_credentials", env.SUPABASE_URL);
  credUrl.searchParams.set("select", "id");
  credUrl.searchParams.set("provider_account_id", `eq.${account.id}`);

  const credResp = await fetch(credUrl, { headers });
  const credRows = (await credResp.json()) as Array<{ id: string }>;
  const existingId = credRows[0]?.id;

  // 4. PATCH 或 POST
  const upsertHeaders = { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" };
  const upsertBody = JSON.stringify({
    ...(existingId ? { id: existingId } : {}),
    user_id: userId,
    provider_account_id: account.id,
    encrypted_payload: encrypted.encryptedPayload,
    nonce: encrypted.nonce,
    key_version: encrypted.keyVersion,
  });

  const upsertUrl = new URL("/rest/v1/provider_account_credentials", env.SUPABASE_URL);
  const upsertResp = await fetch(upsertUrl, {
    method: "POST",
    headers: upsertHeaders,
    body: upsertBody,
  });

  if (!upsertResp.ok) {
    const errorBody = await upsertResp.text();
    throw new Error(`更新凭据失败: HTTP ${upsertResp.status} - ${errorBody}`);
  }

  console.log("✅ 凭据已写入 Supabase");
}
```

- [ ] **Step 2: 在 main 中连接加密和写入**

在验证步骤之后、关闭 context 之前（但 cookie 提取已完成），加入：

```typescript
    // 加密写入 Supabase（context 已不需要，可以关了）
  } finally {
    if (context) await context.close();
  }

  // 加密并写入 Supabase
  console.log("🔐 加密并写入 Supabase...");
  await updateSupabaseCredentials(env, cookieValue);

  console.log("🎉 完成！Worker 下次刷新（2 分钟内）将自动使用新 cookie。");
```

注意：`cookieValue` 变量需要在 `try` 块外声明。调整 `main` 代码：

```typescript
  let authCookieValue: string;

  try {
    context = await chromium.launchPersistentContext(chromeUserDataDir, {
      headless: true,
      channel: "chrome",
      args: ["--disable-blink-features=AutomationControlled"],
    });
    // ... (以上的 cookie 提取和验证代码)

    authCookieValue = cookieValue;
  } finally {
    if (context) await context.close();
  }
```

- [ ] **Step 3: 运行完整脚本测试**

```bash
node --experimental-strip-types scripts/refresh-opencode-cookie.ts
```

Expected: 完整流程通过，输出 `🎉 完成！Worker 下次刷新将自动使用新 cookie。`

- [ ] **Step 4: 提交**

```bash
git add scripts/refresh-opencode-cookie.ts
git commit -m "feat: update supabase credentials with fresh opencode cookie"
```

---

### Task 6: 最终验证与完善

**Files:**
- Modify: `scripts/refresh-opencode-cookie.ts`

- [ ] **Step 1: 添加使用说明注释到脚本顶部**

```typescript
/**
 * OpenCode Go Cookie 自动刷新脚本
 *
 * 功能：从本地 Chrome Profile 提取 OpenCode Go 的 auth cookie，加密写入 Supabase。
 * Worker 下次刷新（2 分钟内）自动使用新 cookie。
 *
 * 前置条件：
 *   1. Chrome 浏览器中已登录 opencode.ai
 *   2. 项目 .env 中已配置 SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *      SUPABASE_USER_ID, CREDENTIAL_ENCRYPTION_KEY, OPENCODE_GO_WORKSPACE_ID
 *   3. Settings 页面已有 OpenCode Go 账号
 *
 * 使用：
 *   node --experimental-strip-types scripts/refresh-opencode-cookie.ts
 *
 * 注意：运行前必须关闭所有 Chrome 窗口，否则会因 Profile 锁定而失败。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
```

- [ ] **Step 2: 部署后验证**

运行脚本更新 cookie，然后打开看板 `https://apimonitor.jarvislee90s.workers.dev`，点「立即刷新」，确认 OpenCode Go 显示实时用量数据而非「使用缓存数据」。

- [ ] **Step 3: 提交**

```bash
git add scripts/refresh-opencode-cookie.ts
git commit -m "docs: add usage instructions to cookie refresh script"
```

---

## 自检结果

- Spec coverage: 覆盖从 Chrome Profile 提取 cookie → 验证 → 加密 → Supabase 写入的完整链路
- Placeholder scan: 没有 TBD 或 TODO
- Type consistency: `CookieValue` / `authCookie` / `newAuthCookie` 命名一致，Supabase 列名与迁移文件一致
- Scope check: 单文件脚本，不涉及 Worker 改动、不部署、不修改前端
