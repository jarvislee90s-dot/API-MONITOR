# AGENTS.md

## 语言规范

- 所有回复、解释、文档一律使用简体中文。
- 代码关键字、包名、文件名、命令名保留英文。
- 新增代码注释使用中文，且只在关键逻辑处添加。

## 项目目标

本项目是 API 与 Coding Plan 用量聚合看板，当前方案为 Cloudflare + Supabase 纯云端架构。

核心目标：

- 聚合展示讯飞 MaaS Coding Plan、OpenCode Go Coding Plan、OpenRouter Activity。
- 前端可在电脑和手机浏览器访问。
- 不依赖本地常驻 HTTP 服务。
- 不使用 cron 高频刷新；由前端活跃状态触发刷新。
- 用户活跃时最多每 2 分钟刷新一次；10 分钟无交互后停止自动刷新。

## 核心需求优先级

必须优先实现：

- Cloudflare Pages 前端。
- Cloudflare Worker API。
- Supabase Auth 与 Postgres 数据存储。
- Durable Object 或等价机制实现刷新节流。
- OpenRouter API 接入。
- OpenCode Go 双账号 `workspaceId + auth cookie`，Edge 双 Profile 本地抓取 + ingest 推送（绕开 IP 封锁）。
- 讯飞 MaaS 原网页入口和登录状态提示。
- 前端原网页打开按钮。
- 秘钥只保存在云端，不暴露给前端。

可以后置：

- 历史趋势图。
- 模型花费明细表。
- Browser Run Live View 登录修复。
- 多账号管理。
- 用量预测和告警。
- PWA、暗色模式、通知。
- 更精细的 UI 动效。

## 安全规则

- 禁止批量删除。
- 禁止使用 `rm -rf`、`rd /s`、`rmdir /s`、`Remove-Item -Recurse`、`del /s`。
- 删除只能单个文件，删除前必须获得用户确认。
- 禁止 `sudo`、提权、`curl | bash`。
- 禁止泄露密钥、`.env`、`pem`、json 凭据、cookie、session、service role key。
- 不读取 `.env`，除非用户明确要求且说明具体目的。
- 不把真实密钥写入源码、文档、测试快照或日志。
- 不修改系统配置。
- 不在项目目录外写文件。

## 文件操作规则

- 只在当前项目 `E:\LLMproject\ApiMonitor` 内操作。
- 覆盖已有文件前必须确认。
- 不擅自修改 `package.json`、`.gitignore`、`wrangler.toml`、Supabase 配置文件等配置文件。
- 可以新增 `.example`、文档、测试文件和计划文件。
- 手工编辑文件时优先使用 `apply_patch`。
- 保持参考源码在 `references/` 下，不把参考项目代码直接复制到正式实现。

## 命令执行规则

- 执行 bash 命令前必须确认。
- 当前环境优先使用 PowerShell 命令。
- 不运行未知脚本。
- 不擅自安装依赖。
- 运行测试、构建、类型检查前说明目的。
- 任何声称通过、完成、可用之前，必须先运行对应验证命令并检查结果。
- 浏览器自动化前，先手动探索页面 DOM，把所有需要交互的元素摸清楚后再写具体脚本，避免反复试错。

## 参考源码边界

- `references/onwatch`: 只参考 OpenRouter API、快照模型、provider 聚合思路。
- `references/opencode-quota`: 只参考 OpenCode Go 用量窗口抓取思路。
- `references/all-api-hub`: 只参考账号卡片、原网页入口、交互组织。
- `references/codeburn`: 只参考 provider adapter 抽象。
- `references/one-api`: 只参考余额和渠道健康状态模型。
- 不直接复制 GPL/AGPL 代码到正式实现。

## 技术约束

- 前端使用 React + TypeScript + Vite。
- UI 控件使用清晰的按钮、图标、卡片和表格，不做营销落地页。
- 后端 Worker 使用 TypeScript。
- 数据库存储优先使用 Supabase Postgres。
- 登录态修复优先考虑 Cloudflare Browser Run，不引入本地服务。
- API 响应必须使用统一 JSON 错误结构。

## 验证要求

常规验证命令：

- `npm run test`
- `npm run build`
- `npm run worker:test`
- `npm run frontend:test`

当命令无法运行时，必须说明原因和剩余风险。

## 文档索引

- 规格文档：`docs/superpowers/specs/2026-06-11-api-usage-dashboard-spec.md`
- 实施计划：`docs/superpowers/plans/2026-06-11-api-usage-dashboard.md`
