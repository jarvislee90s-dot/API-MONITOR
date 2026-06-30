# OpenCode Go 双账号刷新支持设计

日期：2026-06-25
状态：待确认

## 背景

OpenCode Go 用量当前通过 `scripts/refresh-opencode-usage.ts` 本地抓取并推送 ingest。
用户新增了第二个账号，两个账号分别登录在不同浏览器：

- 账号1（jarvislee90s）：Chrome，对应 `.env` 的 `OPENCODE_GO_WORKSPACE_ID`
- 账号2（lijiawei_jarvis）：Edge，对应 `.env` 的 `OPENCODE_GO_WORKSPACE2_ID`

现有脚本采用"Edge 优先遍历，找到第一个有 cookie 的浏览器就 break"的单账号模式，
双浏览器下只会一直刷新第一个找到 cookie 的账号，无法覆盖第二个账号。

## 现状分析

数据链路是单向的，前端不存账号配置：

```
刷新脚本推送 → Worker ingest 端点 → persistSnapshot 写 Supabase
                                        ↓ provider_accounts 按 source_url 区分账号
Worker buildProviderConfigs 按账号分别抓取
                                        ↓ /api/usage 返回账号切换卡数据
前端 App.tsx 自动渲染（占位数据被覆盖）
```

关键结论：

1. ingest 端点（`worker/ingest.ts`）和 `persistSnapshot` 已支持多账号：
   - `provider_accounts` 表 upsert 冲突键为 `(user_id, provider_key, source_url)`
   - 不同 workspaceId 产生不同 source_url，天然落成两条账号记录
   - `usage_snapshots` / `quota_windows` 都挂 `provider_account_id` 外键
2. Worker `buildProviderConfigs` 已遍历每个 `homepageEnabled` 账号分别抓取
3. 前端账号数据从 `/api/usage` 拉取，不需要手动存账号配置

因此改造范围集中在脚本端，ingest 端点、Worker 逻辑、数据库结构均不动。

## 设计

### 改动范围

三个文件：

1. `scripts/refresh-opencode-usage.ts`（核心改动）
2. `frontend/src/App.tsx`（首屏占位补全）
3. `.env`（用户新增变量，已完成）

### 账号定义

脚本内定义账号列表，每项绑定浏览器、用户数据目录、workspaceId 环境变量名、标签：

| 序号 | 标签             | 浏览器  | workspaceId 来源              |
| ---- | ---------------- | ------- | ----------------------------- |
| 1    | jarvislee90s     | Chrome  | OPENCODE_GO_WORKSPACE_ID      |
| 2    | lijiawei_jarvis  | Edge    | OPENCODE_GO_WORKSPACE2_ID     |

### 脚本改造（refresh-opencode-usage.ts）

把"浏览器优先遍历，找到第一个 cookie 就 break"改成"账号列表串行处理"：

- 每个账号用绑定的浏览器提取 auth cookie
- 用该账号的 workspaceId 构造 sourceUrl 抓取用量页
- 解析后推送带账号标识的 snapshot：
  - `meta.accountLabel` = 账号标签
  - `sourceUrl` = 该 workspace 的 url（让 Supabase 按 source_url 区分账号）
- 一个账号失败不阻塞另一个，最后汇总成功/失败数
- workspaceId 从对应 `.env` 变量读取，不在脚本里写死

串行而非并行的原因：两个账号共用浏览器进程提取 cookie，并行会争抢 Profile 锁。

### 首屏占位补全（App.tsx）

opencode-go 的 fallback 占位 `accounts` 数组从 1 个补成 2 个：

- 第一个账号 id `opencode-go:default`，label `jarvislee90s`
- 第二个账号 id `opencode-go:account2`，label `lijiawei_jarvis`
- 第二个账号的 sourceUrl 用新 workspaceId

占位数据会被 `/api/usage` 返回的真实数据覆盖，补全仅为避免首屏只有单账号、
刷新后才冒出第二个的跳变。App.tsx 为 GBK 编码，编辑时按 GBK 读写以保持中文不损坏。

### 不改动的部分

- `worker/ingest.ts`：已支持单快照写入，source_url 不同即区分账号
- `worker/index.ts` 的 `persistSnapshot` / `buildProviderConfigs`：已支持多账号
- Supabase 数据库结构：现有表和外键已满足
- `scripts/refresh-opencode-cookie.ts`：用户不再使用此路径

## 验证

- `npm run frontend:test` 确认前端改动不破坏现有测试
- 手动运行 `node --experimental-strip-types scripts/refresh-opencode-usage.ts`
  确认两个账号都被刷新，Supabase 出现两条 opencode-go 账号记录

## 风险

- App.tsx 为 GBK 编码，apply_patch 按 UTF-8 处理可能损坏中文，
  实现时改用 PowerShell 按 GBK 编码读写做精确替换
- 浏览器 Profile 锁：两个账号用不同浏览器，串行处理可避免锁冲突