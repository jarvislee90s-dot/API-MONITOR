# API 用量聚合看板 Spec

## 背景

本项目用于聚合查看三个平台的用量信息：

- 讯飞 MaaS Coding Plan: `https://maas.xfyun.cn/packageSubscription`
- OpenCode Go Coding Plan: `https://opencode.ai/workspace/wrk_01KTNPYQAX7HWSC5B04H1NEBRG/go`
- OpenRouter Activity: `https://openrouter.ai/activity`

目标部署形态采用 Cloudflare + Supabase 的纯云端方案：前端可在电脑和手机浏览器访问，不依赖本地常驻 HTTP 服务。

## 核心需求

### 1. 纯云端运行

系统不能依赖用户本地运行抓取服务。前端部署到 Cloudflare Pages；抓取、节流和云端会话由 Cloudflare Worker、Durable Object、KV 和 Browser Run 承担；数据与权限由 Supabase 承担。

### 2. 前端活跃触发刷新

系统不使用 cron 进行定时刷新。前端页面打开后触发读取；用户保持活跃时最多每 2 分钟触发一次刷新；如果前端页面 10 分钟没有点击、滚动、键盘、触摸等交互，则停止自动刷新。

### 3. 统一看板展示

前端需要在一个页面展示三个平台的健康状态、最近刷新时间、核心用量指标和原网页入口。移动端和桌面端都必须可用。

### 4. OpenRouter 数据接入

OpenRouter 优先使用官方 API 或稳定 HTTP API 获取余额、用量、限额和周期统计。密钥只能存放在服务端环境或云端 secret 中，不能暴露给前端。

### 5. OpenCode Go 数据接入

OpenCode Go 第一版使用 `workspaceId + auth cookie` 在云端抓取 dashboard 页面，并解析 `rollingUsage`、`weeklyUsage`、`monthlyUsage` 三个窗口。必须标准化为统一 quota window。

### 6. 讯飞 MaaS 基础接入

讯飞第一版必须支持原网页入口和登录状态提示。若能发现稳定 JSON 接口则接入真实用量；若短期无法稳定抓取，则展示 `login_required` 或 `partial` 状态，并保留后续 Browser Run/页面解析接入点。

### 7. 安全边界

前端不能接触 `.env`、API key、cookie、session、service role key。Worker 写入 Supabase 使用服务端凭据。Supabase 表必须启用 RLS，前端只可读取属于当前用户的数据。

## 次要需求

以下需求重要，但不阻塞第一版可用：

- 历史趋势图：24 小时、7 天、30 天曲线。
- 模型花费表：按模型、日期、平台拆分花费和 token。
- Cloudflare Browser Run Live View：用于修复验证码、GitHub/Google OAuth、讯飞登录态。
- 多账号管理：同一平台多个账号、标签、排序。
- 余额预测：燃烧率、重置前耗尽预测、告警。
- 通知能力：浏览器通知、邮件、Webhook。
- 完整 UI 打磨：更细的图表、筛选、暗色模式、PWA 安装。

## 明确不做

- 不做本地 daemon 或本地 HTTP 服务。
- 不把账号密码或凭据写入前端。
- 不复制参考项目的 GPL/AGPL 代码到正式实现。
- 不使用高频 cron 轮询。
- 不把 One API 作为必需网关；它只作为余额/用量模型参考。

## 技术方案

采用 B 方案：

- Cloudflare Pages 承载 React 前端。
- Cloudflare Worker 提供 `/api/usage`、`/api/refresh`、`/api/session/*`。
- Durable Object 管理 2 分钟刷新节流和 10 分钟活跃窗口。
- KV 保存短期 session 状态、provider secret 引用或加密后的临时凭据。
- Supabase Auth 负责用户身份。
- Supabase Postgres 保存 provider 配置、用量快照、quota 窗口、模型用量和刷新事件。
- Browser Run 用于需要人工登录或页面抓取的平台。

## 数据模型

核心表：

- `provider_accounts`: 平台账号配置、原网页地址、secret 引用、健康状态。
- `usage_snapshots`: 每次抓取的标准化快照。
- `quota_windows`: 5 小时、周、月、余额等窗口数据。
- `model_usage_daily`: 按日期和模型聚合的花费/token/请求。
- `refresh_events`: 刷新开始、成功、失败、需要登录等事件。

## 参考项目映射

- `references/onwatch`: 参考 OpenRouter API、quota snapshot、provider 聚合思路。
- `references/opencode-quota`: 参考 OpenCode Go 页面抓取和窗口字段。
- `references/all-api-hub`: 参考多平台卡片、原网页入口和账号交互。
- `references/codeburn`: 参考 provider adapter 输出抽象。
- `references/one-api`: 参考余额查询和渠道健康状态。

## 第一版验收标准

- 可以在云端部署前端和 Worker。
- 前端打开后能展示三个平台卡片。
- OpenRouter 能返回真实或测试环境下的标准化快照。
- OpenCode Go 能解析 5 小时、周、月三个用量窗口。
- 讯飞 MaaS 至少能展示原网页入口和登录/部分接入状态。
- 用户活跃时最多 2 分钟刷新一次；10 分钟无交互后停止刷新。
- 前端不包含任何真实密钥。
- 数据写入 Supabase 后，可通过 RLS 只读当前用户数据。
