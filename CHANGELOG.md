# Changelog

本项目使用 Keep a Changelog 风格记录：`Added` / `Changed` / `Fixed`。版本号按日期递增（`YYYY-MM-DD`）。

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
