# Changelog

本项目使用 Keep a Changelog 风格记录：`Added` / `Changed` / `Fixed`。版本号按日期递增（`YYYY-MM-DD`）。

## [2026-10-15] - ChatGPT 双额度桶分开展示

### Added

- ChatGPT 卡片按额度桶分开展示：Codex 编码额度与网页对话额度两个桶独立计量（spec §2），窗口 `meta.bucket` 标记归属，前端窗口标题改用桶名（「Codex 编码额度」/「网页对话额度」）。
- 网页对话额度无数据时（免费档 `rate_limits` 返回 404）卡片追加占位说明行，说明两桶独立、Codex 用尽不影响网页聊天；占位行不参与趋势、不画进度条，完全没有窗口时仍走通用空态文案。
- `scripts/probe-chatgpt-endpoints.ts --browser`：用本机浏览器会话在页面内探测候选端点（`accounts/check/v4-2023-04-27`、`models`、`me`、`settings/user`、`conversation/limit`、`usage_limits` 等），用于确认免费档网页额度是否有其它数据源。

### Added

- 新增 `refresh-chatgpt.bat`：只刷 ChatGPT 额度（读 Codex 本地会话日志），免代理免浏览器免验证码，通常 2 秒完成；看板 ChatGPT 额度的新鲜度等于「最后一次推送」的时间。
- 一键刷新脚本 `refresh-enabled.bat`（+ `scripts/refresh-enabled-providers.ts`）：先列出「智谱 / Ollama / ChatGPT(Codex) / OpenCode Go」谁在看板显示（供应商启用 且 至少一个账号设了首页显示），再依次刷新显示中的那些，跳过项给出原因；`--list` 只看状态。README 增补对应小节。
- ChatGPT 新增 `--local` 本地同步模式：直接读 Codex CLI/IDE 的会话日志（`~/.codex/sessions/**/rollout-*.jsonl` 的 `payload.rate_limits`，即 CLI「剩余用量」面板同源数据）推送 5 小时/每周额度与档位，**免浏览器、免代理、秒级**；订阅与续费时间沿用库内最近成功快照。适合挂任务计划做周期同步。

### Fixed

- **百分比解析 bug**：`toPercentValue` 的"小数按比例放大"启发式把整数 `1` 误判为 100%（`value <= 1` → ×100）——Codex 日志里 `used_percent: 1` 表示 1%，导致看板与 CLI 面板显示不一致（1% 被显示成 100%）。现仅对「0~1 之间的小数」放大，整数 1 保持 1%。
- 看板与 Codex CLI 数值不一致的另一个原因：数据源不同——CLI 面板用本地日志，`backend-api/codex/usage` 的 `used_percent` 实测与之不同（API 0 vs CLI/日志 5），因此新增本地通道作为对齐来源。
- ChatGPT 网页链路鉴权按真实 Plus 会话定论修正：`codex/usage` 用 Codex Bearer 且 `credentials:"omit"`（带 session cookie 会被判 `token_expired`）；网页/订阅端点反过来必须 **cookie + session Bearer 一起带**——cookie-only 会退化成访客视图（`accounts/check` 返回 `plan_type=guest`、`renews_at=null`），bearer-only 直接 403。此前的"cookie-only 可用、session token 一律过期"结论只对访客会话成立（第三轮误判已修正）。
- 续费日期接入：`accounts/check/v4-2023-04-27` 的 `accounts.<id>.entitlement.renews_at` → 看板「续费日期」现显示 11月15日 13:15。
- 登录态判定以 `/api/auth/session` 的 `user.email` + `account.planType` 为准（`accounts/check` 的 cookie-only 视图不能用于判断登录态，否则会出现"登录成功却永远等待"的假象）。

### Changed

- ChatGPT 主指标标签由固定「Codex 5小时」改为首个窗口的 label（免费档为 30 天窗，避免档位错标）。
- ChatGPT 鉴权语义按实测修正（2026-10-15，Plus 档验证）：`codex/usage` 必须用 Codex Bearer 且**不能**同时带 session cookie（否则被判 `token_expired`）→ 该请求改为 `credentials:"omit"`；网页端点改为 **cookie-only**（session 换来的 accessToken 已不被 backend-api 接受，一律 401）；订阅端点改用 `accounts/check/v4-2023-04-27`；访客/免费会话的订阅数据（`plan_type=guest`）不再写入，避免覆盖真实档位。
- `parseSubscriptionPayload`：档位优先取 `plan_type`（再退到 `plan`/`subscription_plan`），不再依赖 JSON 键序。

### Added

- 新增 `scripts/chatgpt-credentials.ts`：本机侧凭据工具——从 Supabase 读取 worker 同一份加密凭据、用 refreshToken 刷新并写回、解析 token 内嵌的订阅档位。
- `scripts/refresh-chatgpt-usage.ts` 凭据来源改为「环境变量 → Supabase 存储副本（可自动刷新写回）→ 本地 `~/.codex/auth.json`」，并在 `codex/usage` 返回 401/403 时自动刷新重试一次；推送时打印档位与窗口键。
- `scripts/import-chatgpt-credentials.ts` 新增 `--web-only`（只续期网页 session cookie，不要求本地 codex token 有效），且写入前与已存凭据合并（不会抹掉 accessToken / refreshToken / accountId）。
- `scripts/probe-chatgpt-endpoints.ts --browser` 增加候选端点探测（页面内执行）。（对应上一节记录）

### Fixed

- `scripts/chatgpt-browser.ts` 的 `fetchInPage` 增加「执行上下文被销毁」重试：SPA 在请求期间跳转会让 `page.evaluate` 直接抛错，导致整轮推送失败。

## [2026-10-14] - ChatGPT 本机推送通道 + 供应商停用控件

### Added

- 新增 `POST /api/ingest/chatgpt`：接收本机浏览器抓到的原始 payload（codex/usage、rate_limits、accounts/check），Worker 侧复用同一套解析器组装快照并落库，`meta.fetchMethod="local_ingest"`；免费档无窗口但有订阅档位时也接受。
- 新增 `scripts/refresh-chatgpt-usage.ts`（本机抓取 + 推送）与共享工具模块 `scripts/chatgpt-browser.ts`（持久 Profile、代理自适配、页面内同源 fetch、分片 cookie 拼接）。
- 设置页 Level 1 供应商卡片新增「停用 / 启用」按钮（立即持久化 `provider_preferences.enabled`），未配置账号的供应商（如 DeepSeek）也能停用/隐藏；停用卡片降透明度并保留配置。
- 前端 ChatGPT 卡「抓取方式」新增第四态：`meta.fetchMethod="local_ingest"` → 显示「本机推送」。

### Changed

- ChatGPT provider 失败分类细化：403 + HTML + 无 `cf-mitigated`（Cloudflare 出口封锁页）单独判为 `egressBlocked`，不再误报「登录态已失效」，summary 指向本机推送脚本；封锁/质询时不再触发无意义的 token 刷新（避免 refresh token 轮换后无法写回）。
- `scripts/import-chatgpt-credentials.ts` 的浏览器/代理/页面内 fetch 工具改为从 `scripts/chatgpt-browser.ts` 引入（行为不变）。

### Fixed

- 修复 ChatGPT provider 内 `input.fetchImpl(...)` 以方法形式调用全局 fetch 导致 workerd 抛 `TypeError: Illegal invocation`——三链路请求实际从未发出（被通用错误文案掩盖），现按其它 provider 的本地绑定写法调用。
- 修复供应商级启停控件缺失：`ProviderOrderList` 在分层设置页重构（e9e1c7a）后成为死代码，`provider_preferences.enabled` 只剩只读文案「供应商启用」，导致 DeepSeek 等供应商无法停用。

## [2026-08-24] - Ollama Pro 看板

### Added

- 新增 Ollama Pro 用量看板：5小时 / 每周额度百分比、本周模型请求数列表（模型名 + 请求数 + 占比，按请求数降序，最多显示前 6 个）。
- Ollama 顶部指标卡：5小时请求数、本周请求数、5小时预计总请求（= 5小时请求数 ÷ 已用百分比 × 100，四舍五入取整）。
- Worker 新增 `ollama` provider（`worker/providers/ollama.ts`）：域名白名单校验、401/403 映射为 `login_required`、`/api/usage` 解析。
- 设置页新增 Ollama Pro 账号目录与凭据表单（`apiKey` / `apiUrl`）。
- `.env.example` 新增 `OLLAMA_KEY` / `OLLAMA_URL` / `OLLAMA_PAGE_URL` 示例。

### Changed

- 5小时 / 每周窗口补齐重置时间（依据 Ollama 官方 pricing 规则）：5小时对齐 UTC 5 的倍数整点，每周指向下周一 00:00 UTC（周一时顺延到下一个周一）。
- 模型请求面板由五列（模型/请求/Token/花费/占比）改为三列（模型/请求数/占比）。
- 前端 Ollama 指标由四项（5小时用量/本周用量/本周请求数/本周模型数）调整为三项（5小时请求数/本周请求数/5小时预计总请求）。

### Fixed
- Ollama weekly 重置时间在周一时返回过去时间的问题：现在返回下一个周一。

## [2026-08-21]

### Added
- 智谱 BigModel Coding Plan 接入看板 + 刷新脚本 + 3×3 指标卡。
