# Changelog

本项目使用 Keep a Changelog 风格记录：`Added` / `Changed` / `Fixed`。版本号按日期递增（`YYYY-MM-DD`）。

## [2026-10-15] - ChatGPT 双额度桶分开展示

### Added

- ChatGPT 卡片按额度桶分开展示：Codex 编码额度与网页对话额度两个桶独立计量（spec §2），窗口 `meta.bucket` 标记归属，前端窗口标题改用桶名（「Codex 编码额度」/「网页对话额度」）。
- 网页对话额度无数据时（免费档 `rate_limits` 返回 404）卡片追加占位说明行，说明两桶独立、Codex 用尽不影响网页聊天；占位行不参与趋势、不画进度条，完全没有窗口时仍走通用空态文案。
- `scripts/probe-chatgpt-endpoints.ts --browser`：用本机浏览器会话在页面内探测候选端点（`accounts/check/v4-2023-04-27`、`models`、`me`、`settings/user`、`conversation/limit`、`usage_limits` 等），用于确认免费档网页额度是否有其它数据源。

### Changed

- ChatGPT 主指标标签由固定「Codex 5小时」改为首个窗口的 label（免费档为 30 天窗，避免档位错标）。

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
