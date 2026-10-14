# ChatGPT 订阅额度监控 Provider 设计稿（第一期）

| 项 | 内容 |
| --- | --- |
| 日期 | 2026-10-14 |
| 状态 | 已评审通过（brainstorming 三段确认：架构数据流 / 凭据安全与降级 / 前端脚本测试分期） |
| 关联需求 | 用户为 OpenAI 免费账号、即将购买 Plus；在用 Codex CLI，本地 `~/.codex/auth.json` 存有 ChatGPT-plan OAuth token，偶切第三方 API 模式（不影响订阅计量）；OpenAI 账号为 Google 登录（日本区），不自动化 Google 登录 |
| 技术基线 | Cloudflare Pages + Worker + Supabase + Durable Object 刷新节流（2 分钟冷却 / 10 分钟活跃窗口，仅约束 `POST /api/refresh`），全部复用既有机制 |

## 决策记录（brainstorming 结论）

### 三方案对比与选择

| 方案 | 思路 | 结论 |
| --- | --- | --- |
| A 纯云端直连 | 三链路全部由 Worker 直连 chatgpt.com | 否决：网页 session cookie 云端无法续期，过期即整链路断裂，且 CF 质询风险无兜底 |
| B 本地抓取 + ingest | 全部照 opencode-go 模式，本地脚本抓取后推送快照 | 否决：Codex OAuth token 本可纯 HTTP 自动刷新，退化为手动链路是浪费 |
| C 混合分治 | Codex 链路全自动（token 自动刷新），网页/订阅链路云端直连尝试 + 降级 | **采纳** |

选 C 的理由：Codex OAuth access token 可用 refresh token 纯 HTTP 刷新，天然适合 Worker 全自动链路；网页 `__Secure-next-auth.session-token` cookie 约 30 天寿命且云端无法续期，只能直连尝试、失败降级，续期留给第二期本地脚本。两条链路的凭据特性不同，各自采用最匹配的取数策略。

### 额度分桶认知（写入文档避免后续误解）

- 网页对话额度与 Codex 额度是**独立分桶、不共用**（OpenAI 官方帮助文档确认）。
- ChatGPT（Work/Agent 类）用量与 Codex **共池**；本项目监控网页对话与 Codex 两桶，共池部分体现在 Codex 桶。
- Codex CLI 切第三方 API 模式**不消耗也不污染**订阅额度计量（auth.json 仍在，订阅计量不受影响）。
- 网页对话按**加权消息数**计，Codex 按 **usage 百分比**计；同模型同 token 数在两桶间无可比性，故看板分桶展示、不合并计算。

### 登录自动化边界

不自动化 Google 登录。凭据从已登录浏览器（Edge Profile 提取 cookie）与已登录 CLI（`~/.codex/auth.json`）一次性提取，加密存云端。

## 1 背景与目标

本项目已有 8 个 provider（`worker/providers/registry.ts:11-20`），Cookie 型可照抄 `worker/providers/ollama.ts` 模式。本期新增 `chatgpt` provider，独立分桶监控三项数据，不合并计算：(1) Codex 编码额度（5 小时滚动窗 + 周窗）；(2) ChatGPT 网页对话 5 小时额度（按模型组百分比 + 重置倒计时，组名透传不枚举）；(3) 订阅档位与续费日期。用户为 Google 登录（日本区）免费账号、即将购 Plus，Google 登录不自动化，凭据从已登录 CLI/浏览器提取后云端加密存储。硬约束：免费账号可开发验证（Codex 窗口与续费日期允许缺失）；不做多账号、不做专项趋势图。

## 2 数据源与端点（含不确定性标注）

**Codex 链路（确定性较高）**：`~/.codex/auth.json` 含 OAuth access/refresh token 与 account id；Worker 以 `Authorization: Bearer` + `chatgpt-account-id` 头请求 `chatgpt.com/backend-api/codex/rate_limits`。该端点为 codex CLI 所用，但**响应 JSON 结构未经本项目验证**——实现期先跑 `scripts/probe-chatgpt-endpoints.ts`（一次性探测脚本，打印脱敏结构）确认；解析器按"窗口键 → used/limit 或百分比 + resetAt/剩余秒数"宽容提取。token 刷新端点（`auth.openai.com` 域）**参照开源 codex CLI 源码确认**，不做臆测。

**网页/订阅链路（不确定性高）**：`__Secure-next-auth.session-token` cookie GET `chatgpt.com/api/auth/session` 换 accessToken（约 10 天有效），再查 `backend-api/rate_limits`（旧形态 message_cap，新分组形态**未验证**，两种都兼容）与订阅端点（候选 `backend-api/accounts/check`，**未验证**）。Cloudflare 对 Worker 出口 IP 施加质询的概率未知，此不确定性正是"直连 + 降级"方案的动因。

## 3 架构与数据流

```
本地一次性导入                     Cloudflare Worker                    前端
~/.codex/auth.json ─┐
Edge Profile cookie ┴→ import-chatgpt-   POST /api/refresh ──→ DO 节流(2min/10min)
                     credentials.ts      (既有链路,不改动)
                        │ AES-GCM 加密        │
                        ▼                     ▼
                  Supabase            worker/providers/chatgpt.ts
                  provider_account_     ├─ codex 链路: Bearer+account-id
                  credentials           │    └ 401→refresh→重试→写回凭据表
                                        ├─ 网页链路: session-token→accessToken→rate_limits
                                        ├─ 订阅链路: session-token→订阅端点
                                        └─ 合并三分桶 → ProviderSnapshot
                                              ↓ credentialUpdate
                                        index.ts 写回 Supabase（新增通道）
```

三分桶在单个 provider 内部以独立函数模块实现（互不阻塞，超时各自独立）；刷新节流、快照持久化、看板渲染全部复用既有机制，零改动。权衡：拆成三个 provider 可让卡片天然分桶，但三链路共享同一账号凭据组，拆开会导致凭据重复存储与三次登录提示，故选单 provider 内部分桶。

## 4 凭据与安全

凭据四字段：`accessToken`、`refreshToken`、`accountId`、`sessionToken`。存储走既有 `provider_account_credentials`（AES-GCM，`worker/security/credentials.ts:13-27`）；字段名含 token/cookie 自动命中 `maskCredentialPayload` 脱敏正则（`credentials.ts:11`），hint 天然脱敏。读取路径复用 `getProviderAccountConfigById`（`worker/settings/repository.ts:962`）：解密后 merge 进 config，`fetchSnapshot` 收到的 config 直接含明文凭据——与 ollama 的 authCookie 一致，不新增机制。安全规则：凭据不进日志/快照/测试 fixture（测试用假 token）；域名白名单仅放行 `chatgpt.com`/`*.chatgpt.com`/`auth.openai.com`；导入脚本读 `~/.codex/auth.json` 仅在内存中转，不复制进项目目录、不进 git。

**token 写回通道（新增）**：`ProviderFetchResult` 增加可选 `credentialUpdate?: Record<string,string>`，provider 刷新 token 后经此返回，`index.ts` 调新增的 `updateProviderAccountCredentials` 覆盖凭据行；写回失败仅记 warning 不阻塞快照。写回前以 DB 解密凭据为底 merge（未轮换字段不被抹掉）；语义注：若某字段仅存在于 env 兜底而 DB payload 没有，首次轮换会把它固化进 DB 凭据行（此后 DB 优先于 env）。权衡：曾考虑让 provider 直接持 env 调 Supabase，但那会把 service role 边界打穿到 provider 层并破坏纯函数可测性，故选结果带出、集中写回。

## 5 Worker Provider 设计

新建 `worker/providers/chatgpt.ts`，内部函数：`fetchCodexWindows`、`refreshCodexToken`、`fetchWebRateLimits`、`fetchSubscription`、`mergeBuckets`。映射表：

| 数据项 | ProviderSnapshot 落点 |
| --- | --- |
| Codex 5h 窗 | `windows[] {key:"codex_5h", label:"Codex 5小时", percentUsed, resetAt}` |
| Codex 周窗 | `windows[] {key:"codex_weekly", label:"Codex 每周", percentUsed, resetAt}` |
| 网页对话模型组 | 每组一条 `windows[] {key:"web_5h_<slug>", label:"对话 5小时·<组名>", percentUsed, resetAt}`，组名透传 |
| 订阅档位 | `metrics.plan`（字符串透传："free"/"plus"/…） |
| 续费日期 | `metrics.planRenewAt`（string\|null，免费/未知为 null） |
| 诊断 | `metrics.codexTokenRefreshed`、`metrics.webFetchMethod`（"direct"/"snapshot_fallback"） |

状态语义：三分桶**任一有数据即不为 error**；codex 或 web 至少一桶 ready 且无降级 → `ready`；有数据但存在 CF 质询降级、或订阅端点获取失败（免费档 `plan:"free"` 属正常数据，不降级）→ `partial`；无任何凭据、或 OAuth 刷新失败且 session cookie 失效 → `login_required`；三链路全失败 → `error`。免费账号：codex 窗口缺失 → 对应 window 不产出（windows 数组可为空不报错，区别于 ingest 校验），summary 注明"当前免费档，无 Codex 窗口数据"；`planRenewAt=null` → 前端显示"订阅前无数据"。

## 6 错误处理与降级

分级处理：(1) 401/403（非质询）→ codex 链路先尝试 refresh token 重试一次，仍失败该桶置空；web 链路判定登录失效。(2) **CF 质询识别**：HTTP 403 且响应头 `cf-mitigated: challenge` → 该链路放弃，本轮快照不含该桶窗口，状态 `partial`，summary 提示"Cloudflare 拦截，请稍后重试或运行本地脚本（第二期）"。**桶级回退机制（新增，`index.ts` 内实现）**：既有"最近成功快照回退"是整卡级别的，为避免 partial 快照把该桶历史窗口覆盖丢失，`index.ts` 持久化前对该 provider 上一份成功快照中同 key 的缺失窗口做补齐（补齐窗口打 `meta.stale=true`，前端沿用 `frontend/src/api/client.ts:330` 附近 `isFallback` 的陈旧样式渲染）；若三链路全失败，整卡沿用既有最近成功快照回退。(3) 订阅端点 404/null → 视为免费档而非错误。(4) 响应解析失败（结构变更）→ 单桶 `partial`，其余桶不受影响。(5) 网络超时用 `requestTimeoutMs`（照 opencode-go 设 15s）。所有错误信息走统一 summary/metrics，不抛异常出 provider（照 ollama 模式），快照永远可返回。

## 7 前端展示

### 7.1 改动清单

改动三处：`frontend/src/settings/provider-catalog.ts` 加 chatgpt 条目；`frontend/src/settings/credential-form.tsx:16-25` 的 `credentialFields` 加分支返回 `["accessToken","refreshToken","accountId","sessionToken"]` 并补 `fieldLabel`；`frontend/src/api/client.ts` 的 `resolveAccent`、`resolveTagline`、`resolvePrimaryMetricLabel` 加分支。对话模型组以配额窗口进度条直接呈现（组数少，不单建模型组列表，用户已确认）；卡片 windows 通用渲染已支持多窗口分桶，无需改 platform-card。

### 7.2 前端参考要素表（已确认）

| 要素 | 确认结果 |
| --- | --- |
| 三桶窗口渲染 | 复用 QuotaWindowList 通用渲染三桶 windows（Codex 5h / Codex 周 / 网页对话各组），不做专有组件 |
| accent | OpenAI 绿 `#10a37f` |
| tagline | "Codex / 对话额度 / 订阅状态" |
| 对话模型组呈现 | 直接作为配额窗口进度条展示（组数少，不建独立列表，用户已确认） |
| 明细指标区 | 显示订阅档位（plan）、续费倒计时（planRenewAt）、token 刷新标记（codexTokenRefreshed）、抓取方式（webFetchMethod） |
| resetAt 缺失兜底 | 显示"滚动窗口"（仿 `formatOllamaResetAt` 的 per-provider 兜底写法） |
| 续费日期 null 兜底 | 显示"订阅前无数据"（免费档/未知档位） |
| sourceUrl | 指向 `https://chatgpt.com`；Codex 详情页 `chatgpt.com/codex` 不单设链接 |
| 凭据表单 | credential-form 四字段（accessToken / refreshToken / accountId / sessionToken），均用密码输入框（`type="password"`），回显脱敏 hint |

## 8 本地脚本

新建 `scripts/import-chatgpt-credentials.ts`，完全照 `scripts/refresh-ollama-cookie.ts` 骨架：(1) 读 `~/.codex/auth.json`（绝对路径参数化，默认 `USERPROFILE/.codex/auth.json`），提取 token 三元组；(2) Playwright 打开项目专用 Profile（`output/chatgpt-browser-profile`，不进 git），已登录则直接提取 `__Secure-next-auth.session-token`，未登录等人工 Google 登录（不自动化）；(3) 本地 AES-GCM 加密（照脚本内既有 `encryptPayload`），Supabase REST 按 `provider_key=chatgpt` + `account_label=默认账号` upsert 凭据行；(4) 校验：用导入的 token 试调一次 codex rate_limits，成功才落库；(5) 输出仅脱敏 hint。可选同步 `.env` 的 `CHATGPT_*` 兜底值与 Worker secret（照 ollama 脚本模式，缺配置则跳过）。另建一次性探测脚本 `scripts/probe-chatgpt-endpoints.ts`（实现期确认端点结构用，输出结构骨架不含 token）。

## 9 测试与验收标准

改动 `tests/worker/providers.test.ts`：registry 数组（:16-25）加 `"chatgpt"`；新增两组 describe（照 ollama :1186-1467）：组一覆盖无凭据→`login_required`、域名白名单拒绝、Bearer + `chatgpt-account-id` 头正确性、codex 窗口解析（含宽容结构）、401→刷新→重试→`credentialUpdate` 带出、refresh 失败→login_required；组二覆盖 session-token→accessToken 换取链、CF 质询（403 + `cf-mitigated` 头）→partial 降级、模型组透传、订阅 404→`plan:"free"`、三桶混合状态合并。全部用 mock fetch 与假 token，**真实 token/cookie 不得进入 fixture**。

**验收标准**：

- (a) `npm run worker:test`、`npm run test`、`npm run build` 通过；
- (b) 免费账号验证路径——不配置 codex 凭据仅配 session cookie：卡片显示 `partial`、订阅桶 `plan:"free"`、无 crash；
- (c) 全无凭据：`login_required` 卡片 + 设置页表单四字段可保存并回显脱敏 hint；
- (d) 导入脚本 dry-run 模式（`--check`）能校验本地 auth.json 与 cookie 有效性。

## 10 分期范围

**第一期**：`worker/types.ts`（ProviderId + WorkerEnv + `credentialUpdate` 字段）、`worker/providers/chatgpt.ts`、`registry.ts`、`index.ts`（buildProviderConfig 分支 + credentialUpdate 写回 + CF 降级时的桶级窗口补齐）、`worker/settings/repository.ts` 新增 `updateProviderAccountCredentials`、前端四处、`scripts/import-chatgpt-credentials.ts`、`scripts/probe-chatgpt-endpoints.ts`、tests。

**第二期（视第一期 CF 直连表现决定）**：cookie 续期脚本（`refresh-chatgpt-cookie.ts`，长 token 过期时复用 Profile 重取）、`POST /api/ingest/chatgpt` 兜底端点（复用 `worker/ingest.ts:25` 的 `handleProviderIngest` 泛型，注意其 windows 非空校验需放宽或 chatgpt 快照保证至少一窗）、Cloudflare Browser Rendering 备选链路。

**第一期终审沉淀的技术债（二期候选，按优先级）**：
1. chatgpt partial 但无缺失窗口（窗口全在、仅订阅降级）时不满足 staleWindowKeys 豁免条件，会被整卡回退用旧 ready 卡替换、遮蔽实取新值——豁免条件可放宽为「chatgpt 且 partial 且 windows 非空」（`worker/index.ts` applyLatestReadyFallback）。
2. handleRefresh 无账号分支（入口型 env 配置）绕过 postProcessSnapshots，不享受桶级补齐。
3. `GET /api/providers/:id/snapshot` 路由本身仍无鉴权（既有问题；一期已通过 skipTokenRefresh 消除凭据烧毁副作用）。
4. stale 窗口目前仅 label「（历史）」后缀，视觉降权样式待与 isFallback 机制统一。
5. accountId 不命中 `maskCredentialPayload` 的脱敏正则（hint 中明文回显，属账号标识符，风险低）。
6. 真实端点探测回填：codex rate_limits 结构、`accounts/check`、新分组 rate_limits 形态与 `defaultCodexClientId` 待真实环境核对（probe 脚本可复跑）。
7. 导入脚本可选同步 `.env` CHATGPT_* 与 Worker secret（spec §8 第 (5) 条，一期已 descope）。

明确不做：多账号管理、Google 登录自动化、专项趋势图。

## 风险与未验证点

| 风险/未验证点 | 应对 |
| --- | --- |
| `chatgpt.com/backend-api/codex/rate_limits` 响应结构未验证 | 实现期先跑 `scripts/probe-chatgpt-endpoints.ts` 探测（输出脱敏结构）；解析器按多形态宽容提取 |
| OAuth refresh 端点与参数未确认 | 实现期对照开源 codex CLI 源码确认；若被阻塞，第一期末降级为"手动重跑导入脚本"更新 token |
| Cloudflare 对 Worker 出口 IP 的质询概率未知 | 设计即按"直连尝试 + partial 降级 + 最近快照回退"；第二期以 cookie 续期脚本 / ingest / Browser Rendering 兜底 |
| 上游端点结构漂移（OpenAI 迭代频繁） | 宽容解析 + 单桶 `partial` + summary 提示，其余桶不受影响；探测脚本可复跑 |
| 免费账号无 Codex 窗口/续费数据 | 设计已定义缺失语义：窗口不产出、`planRenewAt=null`、前端兜底文案，不视为错误 |
