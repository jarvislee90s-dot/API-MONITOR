# OpenCode Go 本地抓取 + Worker Ingest 端点 Design

## 背景

OpenCode Go 的 web 用量页（`/workspace/{id}/go`）会屏蔽数据中心 IP。Cloudflare Worker 的出口 IP 属于数据中心段，请求该页面会被 302 重定向到 `/auth/authorize`（login_required）。而本地直连（国内 IP）和 Aurora 代理出口 IP 均能成功访问。

判别测试结论（2026-06-17）：
- 直连（国内 IP）+ auth cookie → HTTP 200，命中 rollingUsage/weeklyUsage/monthlyUsage ✅
- Aurora 代理出口 IP + auth cookie → HTTP 200，命中用量数据 ✅
- Worker（Cloudflare IP）+ auth cookie → 302 → /auth/authorize ❌

→ 不是 cookie 的 IP 绑定，而是 opencode 封数据中心/Cloudflare IP 段。

因此"刷新 cookie 喂给 Worker"这条路无效（`scripts/refresh-opencode-cookie.ts` 更新 secret 的方案已废弃）。改为：本地抓取 + Worker ingest。

## 目标

本地脚本在可用 IP（直连或 Aurora）下用浏览器 profile 的 auth cookie 抓取 opencode 用量页，解析为标准快照后推送到 Worker 新增的 ingest 端点落库，看板展示实时用量。

## 架构

```
Edge profile cookie
  → 本地 fetch opencode 用量页 (国内 IP, ✅)
  → parseOpenCodeGoWindows(html)   (复用 worker/providers/opencode-go-parser.ts)
  → 构造 ProviderSnapshot { providerId:"opencode-go", status:"ready", windows, ... }
  → POST /api/ingest/opencode-go   (Header: X-Ingest-Key)
  → Worker persistSnapshot → Supabase usage_snapshots / quota_windows
  → 看板 /api/usage 展示（最近成功快照）
```

## 组件

### 1. Worker ingest 端点 `POST /api/ingest/opencode-go`

- 路由：在 `handleApiRequest` 增加分支
- 鉴权：header `X-Ingest-Key` 与 Worker secret `INGEST_API_KEY` 比对；不匹配返回 401
- 入参 body：`{ snapshot: ProviderSnapshot }`
- 校验：
  - `snapshot.providerId === "opencode-go"`（防越权写其他 provider）
  - `snapshot.status` 为合法 ProviderStatus
  - `snapshot.windows` 是数组
- 落库：调用现有 `persistSnapshot(env, env.SUPABASE_USER_ID ?? null, snapshot, null)`（decision 传 null，不记 refresh_event）
- 返回：成功 200 `{ ok: true, capturedAt }`；失败统一 JSON 错误结构

新增类型/secret：
- `WorkerEnv` 增加 `INGEST_API_KEY?: string`
- `wrangler secret put INGEST_API_KEY`

### 2. 本地脚本 `scripts/refresh-opencode-usage.ts`（新建）

职责：抓取 + 解析 + 推送。不更新 Worker secret、不写 Supabase。

- `loadEnv`（复用现有实现，从 `.env` 读 `INGEST_API_KEY`、`OPENCODE_GO_WORKSPACE_ID`、`APIMONITOR_INGEST_URL`）
- 浏览器 cookie 提取：复用 `refresh-opencode-cookie.ts` 的 Edge/Chrome 轮询逻辑（提取 `auth` cookie）
- 抓取用量页：`fetch(https://opencode.ai/workspace/{ws}/go, { redirect:"manual", headers:{Cookie:auth=...} })`
  - 3xx 重定向到 login → 报错退出（cookie 无效或被 IP 封）
  - 非 200 → 报错
- 解析：移植/复用 `parseOpenCodeGoWindows(html, now)`
- 构造 ProviderSnapshot（字段与 `worker/providers/opencode-go.ts` 的 `createResult` 对齐：providerId、providerName、sourceUrl、status:"ready"、capturedAt、summary、windows、metrics、meta）
- POST ingest 端点

注：parser 当前在 `worker/providers/opencode-go-parser.ts`，是 Worker 端 TypeScript。脚本用 `--experimental-strip-types` 运行，可直接 import 该文件（无 Worker 运行时依赖的部分）。若 import 受限于 tsconfig/路径解析，则在脚本内内联一份解析逻辑（与 parser 保持一致）。

### 3. 配置

- `.env` 增加：`INGEST_API_KEY`、`APIMONITOR_INGEST_URL`（=https://apimonitor.jarvislee90s.workers.dev）
- `.env.example` 同步占位
- 生产 Worker secret：`INGEST_API_KEY`（通过 wrangler secret 或 CF API 设置）

## 数据流

正常：
```
extract cookie → fetch 用量页(200) → parse → POST ingest → 200 → 看板展示 ready
```

异常分支：
- cookie 提取失败 → 提示登录，退出 1
- fetch 重定向 login → "cookie 无效或 IP 被封"，退出 1（不推送陈旧数据）
- fetch 非 200 → 报 HTTP 状态，退出 1
- parse 0 windows → "页面已加载但未找到用量窗口"，退出 1
- ingest 401 → "INGEST_API_KEY 不匹配"，退出 1
- ingest 非 200 → 报响应体，退出 1

## 安全

- `INGEST_API_KEY` 仅存在于 Worker secret 和本地 `.env`，不进前端、不进 git
- ingest 端点只接受 opencode-go，拒绝其他 providerId
- 脚本不接触 Supabase service role key，凭据集中在 Worker
- 端点用常量时间比较密钥，防时序攻击

## 测试

- Worker 单元测试（`tests/worker/`）：
  - ingest 合法 snapshot → 200 且调用 persistSnapshot
  - 缺/错 X-Ingest-Key → 401
  - providerId 非 opencode-go → 400
  - 缺 windows → 400
- 脚本端到端：跑通后看板 `/api/usage` 的 opencode-go card status=ready、windows 为实时值、capturedAt 为当下

## 范围与非目标

- 不改前端
- 不改 Durable Object 节流（ingest 不走刷新节流，因为是外部推送的快照）
- 不实现定时自动运行（用户手动触发；定时可后置）
- 旧的 `refresh-opencode-cookie.ts`（更新 secret 方案）保留代码作参考，但其方案已废弃；不在此 spec 内删除

## 依赖

- Node 24 `--experimental-strip-types`
- Playwright（已安装 dev 依赖）
- 现有 `parseOpenCodeGoWindows`、`persistSnapshot`、`ProviderSnapshot` 类型
