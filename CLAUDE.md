# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 语言规范

- 所有回复、解释、文档使用简体中文
- 代码关键字、文件名、命令名保留英文
- 代码注释使用中文，只在关键逻辑处添加

## 常用命令

```bash
# 安装依赖
npm install

# 本地开发（启动前端 Vite dev server）
npm run dev

# 构建前端（含 TypeScript 类型检查）
npm run build

# 跑所有测试（前端 + Worker）
npm run test

# 只跑前端测试 / Worker 测试
npm run test:frontend
npm run test:worker

# 只跑单个 Worker 测试文件（按文件名过滤）
npm run test:worker -- ingest.test

# 测试 watch 模式
npm run test:watch

# 部署到 Cloudflare Workers（自动先构建前端）
npm run deploy:worker
```

真实端到端测试需要 `.env` 中配置真实凭据：
```bash
RUN_REAL_E2E=1 npx vitest run tests/e2e/real-refresh.test.ts
```

本地维护脚本（Node 24 原生 `--experimental-strip-types` 运行，需 Playwright dev 依赖）：
```bash
# 从浏览器 Profile 提取 opencode cookie 并验证（调试用）
node --experimental-strip-types scripts/refresh-opencode-cookie.ts
# 抓取 opencode 用量页解析后推送到 Worker ingest 端点（看板数据刷新主路径）
node --experimental-strip-types scripts/refresh-opencode-usage.ts
```

## 项目概述

API 与 Coding Plan 用量聚合看板。把 OpenRouter、OpenCode Go、讯飞 MaaS、阿里云百炼的用量状态聚合到一个响应式网页，使用 Supabase 保存快照和配置。Cloudflare + Supabase 纯云端架构，无本地常驻服务。

线上示例：https://apimonitor.jarvislee90s.workers.dev

## 架构

```
浏览器 → Cloudflare Worker
           ├── /api/* → Worker API（TypeScript）
           ├── /* → 前端静态资源（frontend/dist）
           ├── Durable Object（刷新节流：2 分钟冷却，10 分钟空闲停止）
           ├── Supabase Postgres（快照、窗口、刷新事件、配置）
           └── Provider Adapters
                ├── OpenRouter API
                ├── OpenCode Go（云端抓取 + 最近成功快照回退）
                ├── 讯飞 MaaS（coding-plan/list 接口）
                └── 阿里云百炼（默认原网页入口，云端抓取为实验选项）
```

关键设计：
- **Provider Adapter 模式**：每个平台实现统一的 `ProviderDefinition` 接口，`fetchSnapshot()` 返回标准化的 `ProviderSnapshot`
- **配置分层**：`buildProviderConfig(env)` 产出 env 兜底配置；`mergeProviderConfig` 把 Supabase 账号配置（`getActiveProviderAccountConfig` 解密后的）中非空字段覆盖上去。Supabase 加密凭据依赖 `CREDENTIAL_ENCRYPTION_KEY` 解密——**生产当前未配置该 key**，故 Supabase 凭据解密为空，实际回退到 env 明文 secret（`OPENCODE_GO_AUTH_COOKIE` 等）。新增凭据类 secret 时需注意这条回退链
- **快照持久化与回退顺序**：`handleDashboardRefresh` 先 `collectUsageSnapshots` 抓实时并 `persistSnapshot` 落库，再用 `applyLatestReadyFallback` 从 Supabase 取最近成功快照填补失败的 provider。**落库在回退展示之前**，确保回退展示的是上一轮实时数据而非本轮失败数据
- **活跃刷新**：前端检测用户活动触发刷新，不用 cron 轮询
- **凭据加密**：第三方凭据用 AES-GCM 加密后存 Supabase，前端只读脱敏 `credential_hint`
- **Durable Object 节流**：`REFRESH_SESSION` binding，防止频繁刷新（2 分钟冷却、10 分钟空闲停止）
- **OpenCode Go 数据中心 IP 封锁**：opencode 用量页（`/workspace/{id}/go`）屏蔽 Cloudflare 数据中心 IP，Worker 抓取必被 302 重定向到登录页（判别测试：直连国内 IP 与住宅代理 IP 均 200 命中用量，仅 Worker IP 失败）。因此 Worker 端抓取实际失效，看板靠"最近成功快照"展示；实时数据由本地脚本 `scripts/refresh-opencode-usage.ts` 抓取后推送到 `POST /api/ingest/opencode-go`（`X-Ingest-Key` 鉴权，复用 `persistSnapshot` 落库）。ingest 是外部推送，不走 Durable Object 节流

## 目录结构要点

```
frontend/src/
  ├── App.tsx                # 路由：看板 ↔ 设置页（hash 路由 #/settings）
  ├── api/client.ts          # 调用 Worker API 的客户端
  ├── hooks/useActiveRefresh.ts  # 活跃检测 + 自动刷新
  ├── components/            # Dashboard shell、平台卡片、图表
  └── settings/              # 配置页组件（供应商 → 多账号 → 账号配置）

worker/
  ├── index.ts               # 请求路由，所有 /api/* 端点；buildProviderConfig/mergeProviderConfig/persistSnapshot
  ├── ingest.ts              # POST /api/ingest/opencode-go：接收外部推送快照并落库
  ├── dashboard.ts           # 聚合快照为看板格式
  ├── http.ts                # 统一 JSON 响应/错误/读 body 工具
  ├── types.ts               # 共享类型定义（ProviderSnapshot、WorkerEnv 等）
  ├── providers/             # 各平台 adapter 实现
  │   ├── registry.ts        # provider 注册与查找
  │   └── opencode-go-parser.ts  # OpenCode Go HTML 用量解析（脚本也移植此逻辑）
  ├── durable-object/        # 刷新节流 Durable Object
  ├── settings/              # 配置 API 路由 + Supabase CRUD
  │   ├── routes.ts          # HTTP handlers
  │   └── repository.ts      # Supabase 读写
  └── security/credentials.ts  # AES-GCM 加解密

scripts/                     # 本地维护脚本（Node 24 --experimental-strip-types 运行）
  ├── refresh-opencode-usage.ts  # 抓取 opencode 用量推送 ingest（看板实时数据主路径）
  └── refresh-opencode-cookie.ts # 提取/验证 cookie（更新 secret 方案已废弃，保留参考）

supabase/migrations/         # PostgreSQL 迁移文件
tests/
  ├── frontend/              # 前端 hook、组件测试
  ├── worker/                # Worker 单元测试
  └── e2e/                   # 真实端到端测试（需真实凭据）
```

## 技术栈

- 前端：React 18 + TypeScript + Vite + Tailwind CSS + Recharts
- 后端：Cloudflare Workers（TypeScript）+ Durable Objects
- 数据库：Supabase Postgres（RLS 按 user_id 隔离）
- 测试：Vitest + happy-dom + @testing-library/react + @cloudflare/vitest-pool-workers
- 部署：Wrangler v4 + Cloudflare Static Assets

## 安全规则（必须遵守）

- 禁止批量删除，禁止 `rm -rf`、`rd /s`、`rmdir /s`、`Remove-Item -Recurse`、`del /s`
- 删除只能单个文件，删除前必须确认
- 禁止 `sudo`、提权、`curl | bash`
- 禁止泄露密钥、`.env`、`pem`、json 凭据、cookie、session、service role key
- 不读取 `.env`，除非用户明确要求且说明具体目的
- 不把真实密钥写入源码、文档、测试快照或日志
- 不在项目目录外写文件

## 文件操作规则

- 覆盖文件前必须确认
- 不擅自修改 `package.json`、`.gitignore`、`wrangler.toml` 等配置文件
- 可以新增 `.example`、文档、测试文件和计划文件
- `references/` 下的参考项目代码只参考思路，不直接复制

## 核心需求优先级

优先保证：
- Cloudflare Pages 前端 + Worker API
- Supabase Auth 与 Postgres 数据存储
- Durable Object 刷新节流
- OpenRouter / OpenCode Go / 讯飞 MaaS / 阿里云百炼接入
- 前端原网页打开按钮
- 秘钥只保存在云端，不暴露给前端

可后置：历史趋势图、模型花费明细、多账号管理、用量预测告警、PWA、暗色模式、本地脚本定时自动运行（当前手动触发）

## 技术约束

- API 响应使用统一 JSON 错误结构（`worker/http.ts` 的 `successResponse` / `errorResponse`）
- OpenCode Go 实时数据走本地脚本抓取 + Worker ingest，不走 Browser Run（Browser Run 需付费计划且数据中心 IP 仍被封）
- 阿里云百炼默认只保存原网页入口，云端抓取实验默认不启用
