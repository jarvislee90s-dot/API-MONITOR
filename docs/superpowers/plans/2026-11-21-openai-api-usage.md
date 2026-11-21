# OpenAI API 用量实施计划

依据 [已确认的 OpenAI API 额度看板设计](E:/LLMproject/ApiMonitor/docs/superpowers/specs/2026-11-21-openai-api-usage-design.md)。新增独立 OpenAI API 卡，展示全组织已入账费用、US$100 额度和文本模型 Top 5。由子代理直接实施，由独立子代理审查和回归验证，最终保留 localhost 预览。实际组织对账、云部署与线上迁移留待后续启用。

## 跨端契约

沿用 `{ ok: true, data: UsageDashboard }`。在 `cards[]` 增加 `providerId: "openai-api"`、`providerName: "OpenAI API"` 的组织卡，`sourceUrl` 为 `https://platform.openai.com/settings/organization/analytics/overview`。`accounts`、`windows`、`trend` 为空数组，`metrics` 为空对象。Worker 与前端共用 `meta.openaiApi` 的类型。

| 字段 | 类型和口径 |
| --- | --- |
| `period.start`、`period.end` | UTC ISO 8601，起点包含、终点排他。每月 15 日 00:00 UTC 换期。`end` 是下次重置时刻。 |
| `costs.value` | `number \| null`，整个组织全部项目已入账 USD 金额。成功空结果为 `0`。 |
| `usage.value` | `{ requests, inputTokens, outputTokens, topModels } \| null`。前三项为整个组织本期文本模型总量，成功空结果为 `0` 和 `[]`。 |
| `usage.value.topModels[]` | `{ model, requests, tokens, share }`。按 Token 降序，同量按模型名固定字典序，最多 5 条。`share` 为 0 到 1 的比例，分母为全组织本期文本模型 Token，总量为 0 时比例为 0。 |
| `costs.status`、`usage.status` | `ready` 为当期最近一次刷新成功。`stale` 为最近一次失败且有当期成功值。`unavailable` 为没有当期成功值，此时 `value: null`。 |
| `costs.updatedAt`、`usage.updatedAt` | 各自最近成功采集的 UTC ISO 8601 时间，无当期成功值为 `null`。 |
| `costs.error?`、`usage.error?` | 仅最近一次失败时有值。固定码为 `not_configured`、`timeout`、`upstream_failed`、`invalid_data` 或 `storage_failed`。 |

两区均 `ready` 时卡片为 `ready`，至少一区有值时为 `partial`，其余为 `error`。`capturedAt` 取两区最新成功时间，两区均无值时取看板生成时间。组织金额只进入该卡额度区。独立的嵌套状态保留两种数据来源的成功时间，也让组织费用与首页模型花费合计各自按原口径展示。

## 文件级实施计划

先落共享契约，再并行实施 Worker 与前端，最后合并、独立审查、测试和预览。

### 1. 组织取数与快照

- [ ] 新增 `E:/LLMproject/ApiMonitor/shared/openai-api.ts`，定义 `OpenAiApiData`、资源状态、provider ID、US$100 和原网页 URL。修改 `E:/LLMproject/ApiMonitor/worker/types.ts`，扩展看板 provider 类型和 `WorkerEnv` 的 `OPENAI_API_OWNER_USER_ID`、`OPENAI_ADMIN_API_KEY`。共享类型与常量可以防止两端口径漂移，Worker 行为集中在服务端目录。
- [ ] 新增 `E:/LLMproject/ApiMonitor/worker/providers/openai-api.ts`。一次刷新固定 `capturedAt`，由每月 UTC 15 日推导共同查询范围，`start_time`、`end_time` 为 Unix 整秒，截至采集时刻且排他。首秒内 `end_time <= start_time` 时直接读本期缓存，下一整秒可申请刷新。使用 Admin Key 并行 GET `https://api.openai.com/v1/organization/costs` 与 `https://api.openai.com/v1/organization/usage/completions`，用量加 `group_by=model`，两路均覆盖全组织。独立跟随分页游标，限制每路总耗时与页数，任一页失败、游标循环或无效数据即丢弃该路本轮累计。按资源并行节约耗时，必须分别限制上游调用。
- [ ] Costs 汇总有限的 USD `amount.value`，接受合法抵扣，展示时统一格式化为两位小数。Usage 校验请求数、输入和输出 Token 及累计值为非负安全整数，跨桶和分页合并模型，缺模型名称归入「未知模型」。输入含缓存命中的 Token，直接与输出相加。计算全部组织总量和占比分母后取 Top 5。使用可注入时钟和 fetch 固定边界测试。
- [ ] 新增 `E:/LLMproject/ApiMonitor/worker/openai-api.ts`，复用 Supabase `usage_snapshots`。每资源每轮独立写一行，`user_id` 为已验证 Owner UID，`provider_key=openai-api`，`provider_account_id=null`，`payload` 含 `resource`、`periodStart`、校验后的 `value` 或错误码。按 Owner、provider、资源、周期和采集时间读最新结果，若最近失败则另查同周期最近成功。检查每区写入响应，失败侧报 `storage_failed` 并保留当期成功值，另一侧继续。跨换期已在途的结果可落原期，返回时只取当前周期。追加记录利于重建状态，代价是每轮两行和按资源查询。此卡走专用编排，通用整卡回退与账号写入继续处理其余供应商。
- [ ] 新增 `E:/LLMproject/ApiMonitor/supabase/migrations/202611210001_openai_api_snapshots.sql`。为现有快照加 `openai-api` 查询索引，使用 restrictive RLS policy 排除 `anon`、`authenticated` 对此 provider 的直接读写，Worker 使用 service role。复用表可少维护一张表，未来启用前须先应用策略和索引。

### 2. 鉴权与节流

- [ ] 修改 `E:/LLMproject/ApiMonitor/worker/index.ts` 和 `E:/LLMproject/ApiMonitor/worker/auth.ts`。用 `requireUser` 验证 Supabase Bearer，拒绝 `is_anonymous` 会话，UID 必须匹配专用 Secret。匿名、其他用户和 Owner Secret 缺失的全量看板省略该卡，不读写 OpenAI 快照或调用上游。默认 `SUPABASE_USER_ID` 兼容链只用于已有供应商。Owner 缺 Admin Key 时可读授权快照，刷新报 `not_configured`。包含新卡的响应设置 `Cache-Control: private, no-store`。
- [ ] `GET /api/usage` 仅加载快照。`POST /api/refresh` 的全量和显式 `providerId: "openai-api"` 共用编排，显式刷新用 `UsageDashboard` 单卡响应，无有效会话返回统一 `401`，已登录却不满足 Owner 条件返回统一 `403`。`persist:false` 只读该卡快照。通用 registry、settings 测试、ingest、`/api/providers/openai-api/snapshot` 保持未注册该 provider，调试直接返回 `404`。专用入口缩小访问面，代价是看板需显式合并卡片。
- [ ] 修改 `E:/LLMproject/ApiMonitor/worker/dashboard.ts`，走现有看板聚合生成组织单卡、汇总状态和计数。包括已设其他供应商偏好的 Owner，仍能看到新卡。
- [ ] 修改 `E:/LLMproject/ApiMonitor/worker/durable-object/refresh-session.ts` 与 `E:/LLMproject/ApiMonitor/worker/index.ts`。复用现有 DO binding，使用固定内部实例名、专用内部路由，原子读取、判断和持久化周期与最近允许时间。同一周期跨请求与刷新入口最多每 120 秒预约一次，新周期可立即预约，晚到的旧周期请求无法回退记录。只有预约成功才调用上游，其他情况读取当前缓存。客户端 `sessionKey`、`accountId`、查询参数与 `now` 不决定内部实例或刷新权限。公开 `/api/session/` 仅转发固定公开方法和路径白名单，拒绝保留内部名字、路径与其编码或别名。通用刷新参数同样无法命中内部实例。专用 DO 状态支持跨请求和换期，代价是额外维护一个小型预约记录。

### 3. 真实卡片与本地预览

- [ ] 修改 `E:/LLMproject/ApiMonitor/frontend/src/api/client.ts`，由 `mapServerDashboard` 将 `meta.openaiApi` 映射为带类型的卡片属性，沿用现有登录后读取与刷新方法。无效 payload 显示安全空态，模型行独立于首页 `modelSpends`。统一映射让真实响应与 fixture 共用展示流程。
- [ ] 修改 `E:/LLMproject/ApiMonitor/frontend/src/App.tsx`，已取看板与起始登录 UID 绑定。切换身份先显示当前会话空态，丢弃切换后才返回的旧响应。可使用全量刷新 POST 响应即时显示更新结果。增加请求归属校验，避免短暂显示前一位用户的组织账单。
- [ ] 修改 `E:/LLMproject/ApiMonitor/frontend/src/components/platform-card.tsx`、`E:/LLMproject/ApiMonitor/frontend/src/components/quota-window-list.tsx`、`E:/LLMproject/ApiMonitor/frontend/src/components/model-spend-table.tsx`，必要时新增 `E:/LLMproject/ApiMonitor/frontend/src/components/openai-api-sections.tsx`。复用卡片外壳、额度进度、模型表和原网页链接。额度显示 USD、UTC 周期及下次重置，剩余预算为 `max(0, 100 - 已入账费用)`，进度限制在 0% 到 100%，超支照实显示。文本区展示总请求数、总 Token，表头固定为模型、请求数、Token 数和 Token 占比，提示按 Token 降序、最多 5 个。分区展示各自最近成功时间、缓存或失败提示。成功空模型显示「本期暂无文本模型用量」。入口标为「打开原网页」。用可选组件参数实现新卡需求，其他卡继续用组件默认值。
- [ ] 优先复用既有 Vite fixture 入口。找不到时新增 `E:/LLMproject/ApiMonitor/frontend/src/preview/openai-api.tsx`，在 `E:/LLMproject/ApiMonitor/frontend/src/main.tsx` 用 `import.meta.env.DEV` 和精确 `preview=openai-api` 双重条件，在普通 `App` 挂载前加载本地模块。虚构 `UsageDashboard` 经注入本地 fetcher 的 `createApiClient` 或真实共享映射，再渲染 `DashboardShell` 和实际卡片。提供正常、超支、成功空态、单资源 stale 和单资源 unavailable。DEV 分支无需真实鉴权、Worker、Supabase 或 OpenAI 请求，生产产物忽略该参数。

## 验收标准与测试要点

| 文件 | 做完的条件 |
| --- | --- |
| `tests/worker/openai-api.test.ts` | 使用官方响应结构的测试夹具，覆盖 UTC 14 日最后一秒、15 日零点与下一秒、跨年、相同查询区间、多桶多页、空结果和上游失败。核对模型聚合、缓存 Token 只计一次、Top 5 和整组织占比。 |
| `tests/worker/openai-api.test.ts` | 使用内存中的 Supabase 和 DO 替身验证已授权缓存、跨期失效、共享节流、匿名与其他用户访问限制，以及公开 session 路径隔离。 |
| `tests/frontend/openai-api-card.test.tsx` | 通过真实响应映射验证金额、文本用量、模型表与原网页入口。 |
| `tests/frontend/appIdentitySwitch.test.tsx` | 验证账号切换时新会话能立即加载，旧 Owner 响应晚到也无法出现在新会话的看板。 |
| 本地 DEV 预览 | 验证正常、US$0.00 空结果、超支、单区缓存和单区不可用，以及桌面、窄屏布局。 |

- [ ] 独立审查子代理检查授权入口、RLS、持久化与跨端契约。回归子代理运行与根 `npm run test`、`npm run test:worker`、`npm run test:frontend` 相同的用例。以下方式保留仓库 Vitest 配置，禁用隐式 `.env` 加载。只跑一个分组时仅传该组目录。

```powershell
@'
import { startVitest } from 'vitest/node';
await startVitest('test', process.argv.slice(2), { run: true }, { envFile: false });
'@ | node --input-type=module - tests/worker tests/frontend
```

- [ ] 在项目根运行 `node node_modules/typescript/bin/tsc --noEmit` 和 `node node_modules/typescript/bin/tsc --noEmit -p frontend/tsconfig.json`，再构建生产产物。用 localhost 静态产物验证带 `?preview=openai-api` 仍进入登录流程，验收时将 `/api` 请求桩接到本机。

```powershell
@'
import { build } from 'vite';
import react from '@vitejs/plugin-react';
await build({ root: 'frontend', configFile: false, envFile: false, plugins: [react()] });
'@ | node --input-type=module
```

- [ ] 在项目根目录启动下列 localhost DEV 预览，跳过仓库 Vite 配置和 `.env`，允许加载同仓库的共享契约。若既有页面加载远程字体，在预览服务器单独过滤字体预连接和远程 CSS `@import`，保留生产样式。打开 `http://127.0.0.1:5173/?preview=openai-api`，验收桌面与窄屏的卡片、表格、进度条、缓存与空态。检查未访问平台 API、Worker 或 Supabase。端口占用时改用可用端口，最终交付实际 URL 并保持进程运行。

```powershell
@'
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const server = await createServer({
  root: 'frontend', configFile: false, envFile: false, plugins: [react()],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    fs: { allow: [process.cwd()] },
  },
});
await server.listen();
server.printUrls();
'@ | node --input-type=module
```

## 本地验收结果

- 子代理完成 Worker 与前端实现。独立审查和复审覆盖 Owner 鉴权、账号切换、官方分页结构、同周期缓存与 UTC 换期。
- 前端和 Worker 共 22 个测试文件、277 项用例通过，TypeScript 检查和 Vite 生产构建通过。通过检查生产产物确认开发预览模块未打包。
- [本地预览](http://127.0.0.1:5173/?preview=openai-api) 使用示例数据，经桌面及 400px 窄屏检查。真实组织账单比对和 Supabase 迁移执行留待启用真实数据时验证。

## 风险

- Costs 可能延后入账。以同组织、同 UTC 区间核对官方页面，分别显示费用和用量的最近成功时间。
- Admin Key 仅用于固定官方域名和端点，请求禁止跨域跳转，日志和前端只保留固定错误码。切换组织或 Owner 时复核存量快照归属。
- Supabase 或 DO 异常可能使分区暂不可用或继续显示当期缓存。原子预约、采集时间排序和有限取数时间缩小影响。本期只做本地验证。
