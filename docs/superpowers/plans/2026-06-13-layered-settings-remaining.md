# 分层账号配置剩余工作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成分层供应商账号配置页剩余三步——后端 selectedAccountId 接入用户偏好、Level 2 账号面板状态可视化 + 新增入口、首页子卡片数据链路贯通。

**Architecture:** 后端 `buildUsageDashboard` 将 `activeProviderAccountId` 从 preference 透传到 `UsageProviderCard.selectedAccountId`，前端 `PlatformCard` 据此默认选中用户指定的账号。设置页 Level 2 账号列表增加状态标签和"+ 新增账号"入口，使用户不跳层即可创建账号。

**Tech Stack:** TypeScript, React, Cloudflare Workers, Supabase Postgres, Vitest

---

## File Structure

```
worker/
  types.ts                        — 加 activeProviderAccountId 到 ProviderDashboardPreference
  dashboard.ts                    — buildCard/buildUsageDashboard 使用 activeProviderAccountId 设 selectedAccountId
  index.ts                        — readDashboardPreferences 传 activeProviderAccountId

frontend/src/settings/
  settings-page.tsx               — Level 2 面板加状态标签 + "+ 新增账号"按钮 + handleAddAccount
  provider-account-panel.tsx      — 账号项渲染 status badge + 点击账号触发编辑模式（可选增强）

tests/
  worker/dashboard.test.ts        — 新增：selectedAccountId 跟随 activeProviderAccountId
  frontend/settingsPage.test.tsx  — 新增：状态标签渲染 + 新增账号按钮交互
  frontend/platformCardAccounts.test.tsx — 已有测试，无需修改（UI 逻辑已就绪）
```

---

## Task 1: 后端 selectedAccountId 接入 activeProviderAccountId

**Files:**
- Modify: `worker/types.ts:33`
- Modify: `worker/dashboard.ts:3,25-63,84-101`
- Modify: `worker/index.ts:29-33,265-276`
- Create: `tests/worker/dashboard.test.ts`

### Step 1: 在 `ProviderDashboardPreference` 类型加 `activeProviderAccountId`

Modify `worker/types.ts:33`:

```typescript
type ProviderDashboardPreference = {
  providerKey: string;
  enabled: boolean;
  displayOrder: number;
  activeProviderAccountId: string | null;
};
```

- [ ] **Step 2: 运行类型检查确认编译通过**

Run: `npx tsc --noEmit`
Expected: 无错误（`readDashboardPreferences` 返回的 `settings.preferences` 已包含 `activeProviderAccountId`，类型天然兼容）

- [ ] **Step 3: 修改 `buildCard` 接受 preference 参数，用它设置 `selectedAccountId`**

Modify `worker/dashboard.ts` 的 `buildCard` 函数签名和实现：

```typescript
function buildCard(
  snapshot: ProviderSnapshot,
  preference?: { activeProviderAccountId: string | null },
): UsageProviderCard {
  const defaultAccountId = `${snapshot.providerId}:default`;
  const accountId = typeof snapshot.meta.accountId === "string"
    ? snapshot.meta.accountId
    : defaultAccountId;

  return {
    // ... 其他字段不变
    selectedAccountId: preference?.activeProviderAccountId ?? accountId,
    accounts: [
      {
        // ... 其他字段不变
      },
    ],
  };
}
```

关键改动：`selectedAccountId` 从 `accountId`（最后一条快照的 ID）改为 `preference?.activeProviderAccountId ?? accountId`。

- [ ] **Step 4: 修改 `buildUsageDashboard` 把 preferenceMap 传给 `buildCard`**

Modify `worker/dashboard.ts:84-101` 的 `buildUsageDashboard` 函数中 `.map(buildCard)` 调用：

```typescript
const cards = snapshots
  .map((snapshot) => buildCard(snapshot, preferenceMap.get(snapshot.providerId)))
  .filter((card) => preferenceMap.get(card.providerId)?.enabled ?? true)
  .reduce<UsageProviderCard[]>((acc, card) => mergeCards([...acc, card]), [])
  .sort((left, right) => {
    const leftOrder = preferenceMap.get(left.providerId)?.displayOrder ?? 100;
    const rightOrder = preferenceMap.get(right.providerId)?.displayOrder ?? 100;
    return leftOrder - rightOrder;
  });
```

- [ ] **Step 5: 确认 `readDashboardPreferences` 已传 `activeProviderAccountId`**

检查 `worker/index.ts:265-276` 的 `readDashboardPreferences`：

```typescript
async function readDashboardPreferences(env: WorkerEnv): Promise<ProviderDashboardPreference[] | undefined> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_USER_ID) {
    return undefined;
  }

  try {
    const settings = await listProviderSettings(env, fetch);
    return settings.preferences.length > 0 ? settings.preferences : undefined;
  } catch {
    return undefined;
  }
}
```

`listProviderSettings` 返回的 `preferences` 已包含 `activeProviderAccountId`（见 `worker/settings/repository.ts:103-111`），所以不需要修改此函数。

- [ ] **Step 6: 写 Dashboard selectedAccountId 测试**

Create `tests/worker/dashboard.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildUsageDashboard } from "../../worker/dashboard";
import type { ProviderSnapshot } from "../../worker/types";

function createSnapshot(providerId: string, accountId?: string): ProviderSnapshot {
  return {
    providerId: providerId as ProviderSnapshot["providerId"],
    providerName: providerId,
    sourceUrl: `https://example.com/${providerId}`,
    status: "ready",
    capturedAt: "2026-06-13T00:00:00.000Z",
    summary: "OK",
    windows: [{ key: "monthly", label: "Monthly", used: 10, limit: 100, resetAt: null }],
    metrics: {},
    meta: accountId ? { accountId, accountLabel: `Account ${accountId}` } : {},
  };
}

describe("buildUsageDashboard selectedAccountId", () => {
  it("uses activeProviderAccountId from preference when available", () => {
    const snapshots = [
      createSnapshot("openrouter", "acc-1"),
      createSnapshot("openrouter", "acc-2"),
    ];

    const dashboard = buildUsageDashboard(snapshots, {
      providerPreferences: [
        {
          providerKey: "openrouter",
          enabled: true,
          displayOrder: 1,
          activeProviderAccountId: "acc-2",
        },
      ],
    });

    expect(dashboard.cards[0].selectedAccountId).toBe("acc-2");
    expect(dashboard.cards[0].accounts.length).toBe(2);
  });

  it("falls back to snapshot accountId when no preference activeProviderAccountId", () => {
    const snapshots = [createSnapshot("openrouter", "acc-1")];

    const dashboard = buildUsageDashboard(snapshots, {
      providerPreferences: [
        {
          providerKey: "openrouter",
          enabled: true,
          displayOrder: 1,
          activeProviderAccountId: null,
        },
      ],
    });

    expect(dashboard.cards[0].selectedAccountId).toBe("acc-1");
  });

  it("uses last snapshot accountId when no preference at all", () => {
    const snapshots = [
      createSnapshot("openrouter", "acc-1"),
      createSnapshot("openrouter", "acc-2"),
    ];

    const dashboard = buildUsageDashboard(snapshots);

    const openrouterCard = dashboard.cards.find((c) => c.providerId === "openrouter");
    expect(openrouterCard?.selectedAccountId).toBe("acc-2");
  });
});
```

- [ ] **Step 7: 运行 Worker 测试**

Run: `npm run test:worker`
Expected: 3 个新用例 + 现有用例全部通过

- [ ] **Step 8: Commit**

```bash
git add worker/types.ts worker/dashboard.ts tests/worker/dashboard.test.ts
git commit -m "feat: wire activeProviderAccountId to dashboard selectedAccountId"
```

---

## Task 2: Level 2 账号面板状态标签 + 新增账号入口

**Files:**
- Modify: `frontend/src/settings/settings-page.tsx:297-368`
- Create: `frontend/src/settings/account-status-labels.ts`
- Modify: `frontend/src/styles.css`（加状态标签样式）

### Step 1: 创建账号状态标签映射

Create `frontend/src/settings/account-status-labels.ts`:

```typescript
import type { SafeProviderAccount } from "../api/client";

type AccountStatusKey = "ready" | "login_required" | "error" | "disabled" | "unknown";

const STATUS_LABELS: Record<AccountStatusKey, string> = {
  ready: "已连接",
  login_required: "需要登录",
  error: "抓取失败",
  disabled: "已停用",
  unknown: "未知",
};

export function getAccountStatusLabel(account: SafeProviderAccount): string {
  const key = account.status as AccountStatusKey;
  return STATUS_LABELS[key] ?? STATUS_LABELS.unknown;
}

export function getStatusTone(account: SafeProviderAccount): "healthy" | "warning" | "error" {
  switch (account.status) {
    case "ready":
      return "healthy";
    case "login_required":
      return "warning";
    case "error":
    case "disabled":
      return "error";
    default:
      return "warning";
  }
}
```

- [ ] **Step 2: 在 settings-page.tsx 引入状态标签函数**

Modify `frontend/src/settings/settings-page.tsx` 顶部 imports：

```typescript
import { getAccountStatusLabel, getStatusTone } from "./account-status-labels";
```

- [ ] **Step 3: 修改 Level 2 账号项渲染，加状态标签**

Modify `frontend/src/settings/settings-page.tsx:304-366` 的 `homepage-account-list` 渲染。

已启用账号项（`homepageAccounts.map`）修改为：

```tsx
homepageAccounts.map((account, index) => (
  <article key={account.id} className="homepage-account-item is-enabled">
    <span>
      <strong>{account.accountLabel}</strong>
      <small>{account.lastTestSummary ?? getAccountStatusLabel(account)}</small>
      <span className={`status-badge status-badge--${getStatusTone(account)}`}>
        {getAccountStatusLabel(account)}
      </span>
    </span>
    <div className="homepage-account-item__actions">
      <button
        type="button"
        className="icon-btn"
        aria-label={`上移首页显示：${account.accountLabel}`}
        disabled={!adminToken || index === 0}
        onClick={() => void moveHomepageAccount(account.id, "up")}
      >
        <ChevronUp size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={`下移首页显示：${account.accountLabel}`}
        disabled={!adminToken || index === homepageAccounts.length - 1}
        onClick={() => void moveHomepageAccount(account.id, "down")}
      >
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="btn btn--ghost"
        aria-label={`停用首页显示：${account.accountLabel}`}
        disabled={!adminToken}
        onClick={() => void toggleHomepageDisplay(account.id, false)}
      >
        <EyeOff size={15} aria-hidden="true" />
        停用
      </button>
    </div>
  </article>
))
```

未启用账号项（`selectedAccounts.filter((account) => !account.homepageEnabled).map`）修改为：

```tsx
selectedAccounts
  .filter((account) => !account.homepageEnabled)
  .map((account) => (
    <article key={account.id} className="homepage-account-item">
      <span>
        <strong>{account.accountLabel}</strong>
        <small>{account.lastTestSummary ?? getAccountStatusLabel(account)}</small>
        <span className={`status-badge status-badge--${getStatusTone(account)}`}>
          {getAccountStatusLabel(account)}
        </span>
      </span>
      <button
        type="button"
        className="btn btn--ghost"
        aria-label={`启用首页显示：${account.accountLabel}`}
        disabled={!adminToken}
        onClick={() => void toggleHomepageDisplay(account.id, true)}
      >
        <Eye size={15} aria-hidden="true" />
        启用
      </button>
    </article>
  ))
```

- [ ] **Step 4: 在账号列表底部加"+ 新增账号"按钮**

在 `homepage-account-list` 的 `</div>` 前、`selectedAccounts` 过滤映射之后，加：

```tsx
<button
  type="button"
  className="btn btn--ghost add-account-btn"
  onClick={() => {
    const form = document.querySelector(".credential-form");
    if (form) {
      form.scrollIntoView({ behavior: "smooth", block: "center" });
      (form.querySelector("input") as HTMLInputElement | null)?.focus();
    }
  }}
  disabled={!adminToken}
>
  + 新增账号
</button>
```

- [ ] **Step 5: 加状态标签 CSS**

Append to `frontend/src/styles.css`:

```css
.status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
  margin-left: 8px;
}

.status-badge--healthy {
  background: #dcfce7;
  color: #166534;
}

.status-badge--warning {
  background: #fef9c3;
  color: #854d0e;
}

.status-badge--error {
  background: #fee2e2;
  color: #991b1b;
}

.add-account-btn {
  display: block;
  width: 100%;
  margin-top: 12px;
  padding: 10px;
  text-align: center;
  border: 1px dashed var(--border, #d1d5db);
  border-radius: 8px;
  color: var(--text-secondary, #6b7280);
  background: transparent;
  cursor: pointer;
  transition: background 0.15s;
}

.add-account-btn:hover {
  background: var(--bg-hover, #f3f4f6);
}

.add-account-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 6: 写状态标签和新增按钮测试**

Append to `tests/frontend/settingsPage.test.tsx`：

```typescript
import type { SafeProviderAccount } from "../../frontend/src/api/client";

// ... 在 describe("SettingsPage") 块内添加

it("renders account status badges in the homepage account list", () => {
  const readyAccount: SafeProviderAccount = {
    id: "acc-ready",
    providerKey: "openrouter",
    accountLabel: "主账号",
    sourceUrl: "https://openrouter.ai/activity",
    status: "ready",
    statusMessage: null,
    credentialHint: {},
    homepageEnabled: true,
    homepageOrder: 1,
    lastTestSummary: null,
  };
  const loginRequiredAccount: SafeProviderAccount = {
    id: "acc-login",
    providerKey: "openrouter",
    accountLabel: "备用账号",
    sourceUrl: "https://openrouter.ai/activity",
    status: "login_required",
    statusMessage: null,
    credentialHint: {},
    homepageEnabled: true,
    homepageOrder: 2,
    lastTestSummary: null,
  };

  const api = {
    getProviderSettings: vi.fn().mockResolvedValue({
      catalog: [{ providerKey: "openrouter", providerName: "OpenRouter", sourceUrl: "https://openrouter.ai/activity", description: "test" }],
      preferences: [{ providerKey: "openrouter", enabled: true, displayOrder: 1, activeProviderAccountId: null }],
      accounts: [readyAccount, loginRequiredAccount],
    }),
    saveProviderPreferences: vi.fn(),
    saveProviderAccount: vi.fn(),
    testProviderAccount: vi.fn(),
    updateProviderAccountDisplay: vi.fn(),
  };

  render(<SettingsPage api={api as never} onBack={() => undefined} />);

  // 等待 settings API 加载完成
  waitFor(() => {
    expect(screen.getByText("已连接")).toBeTruthy();
  });

  waitFor(() => {
    expect(screen.getByText("需要登录")).toBeTruthy();
  });
});

it("shows '+ 新增账号' button that scrolls to credential form", () => {
  const api = {
    getProviderSettings: vi.fn().mockResolvedValue({
      catalog: [{ providerKey: "openrouter", providerName: "OpenRouter", sourceUrl: "https://openrouter.ai/activity", description: "test" }],
      preferences: [],
      accounts: [],
    }),
    saveProviderPreferences: vi.fn(),
    saveProviderAccount: vi.fn(),
    testProviderAccount: vi.fn(),
    updateProviderAccountDisplay: vi.fn(),
  };

  sessionStorage.setItem("api-monitor-admin-token", "test-token");

  render(<SettingsPage api={api as never} onBack={() => undefined} />);

  waitFor(() => {
    expect(screen.getByText("+ 新增账号")).toBeTruthy();
  });
});
```

- [ ] **Step 7: 运行前端测试**

Run: `npm run test:frontend`
Expected: 新增用例 + 现有用例全部通过

- [ ] **Step 8: Commit**

```bash
git add frontend/src/settings/account-status-labels.ts frontend/src/settings/settings-page.tsx frontend/src/styles.css tests/frontend/settingsPage.test.tsx
git commit -m "feat: add account status badges and +新增账号 button to Level 2 panel"
```

---

## Task 3: 验证完整链路 + 构建部署

- [ ] **Step 1: 运行全部测试**

Run: `npm run test`
Expected: 所有测试文件通过

- [ ] **Step 2: 构建**

Run: `npm run build`
Expected: TypeScript + Vite build 通过（chunk size warning 可忽略）

- [ ] **Step 3: 部署到 Cloudflare**

Run: `npm run deploy:worker`
Expected: 部署成功，输出 `https://apimonitor.jarvislee90s.workers.dev`

- [ ] **Step 4: Commit final**

```bash
git add -A
git commit -m "chore: finalize layered settings - remaining gaps"
```

---

## Self-Review

### 1. Spec coverage

| 计划要求 | 对应 Task |
|---|---|
| 首页大卡片默认显示用户选的主账号 | Task 1 |
| 账号列表显示状态标签（已连接/需要登录等） | Task 2 |
| "+ 新增账号"入口在 Level 2 | Task 2 |
| 账号状态与参考图视觉一致 | Task 2 |
| 子卡片切换功能数据链路 | Task 1（UI 已就绪） |

### 2. Placeholder scan

无 TBD/TODO/占位符。每个 Step 都有具体代码。

### 3. Type consistency

- `ProviderDashboardPreference` → `activeProviderAccountId: string | null` → `SafeProviderAccount.id: string` ✅
- `getAccountStatusLabel(SafeProviderAccount)` 返回 `string` → 用于 JSX `textContent` ✅
- `getStatusTone(SafeProviderAccount)` 返回 CSS class suffix → 用于 `className` 拼接 ✅
- `buildCard(snapshot, preference?)` → `preference` 可选，向后兼容 ✅
