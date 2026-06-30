# 部署说明

当前部署方式是 Cloudflare Worker 同时托管 API 和前端静态资源。

- API 入口：`worker/index.ts`
- 前端源码：`frontend/src`
- 前端构建产物：`frontend/dist`
- 线上域名示例：`https://apimonitor.bondtoolbox.asia`

## 1. 构建和测试

```powershell
npm run test
npm run build
```

`npm run build` 会先做 TypeScript 检查，再进入 `frontend/` 构建静态资源。

## 2. Cloudflare 配置

项目根目录的 `wrangler.toml` 是部署入口：

```toml
name = "apimonitor"
main = "./worker/index.ts"
compatibility_date = "2026-06-11"

[assets]
directory = "./frontend/dist"
not_found_handling = "single-page-application"
```

部署命令使用 Wrangler v4（不需要 `run_worker_first`，默认行为即把 `/api/*` 路径 fallback 到 Worker）：

```powershell
npx wrangler@4 deploy
```

## 3. Secrets

真实密钥不要写进 `wrangler.toml`，使用 Wrangler secret 或 Cloudflare Dashboard 配置。

```powershell
npx wrangler@4 secret put SUPABASE_URL
npx wrangler@4 secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler@4 secret put CREDENTIAL_ENCRYPTION_KEY
npx wrangler@4 secret put OPENROUTER_API_KEY
npx wrangler@4 secret put OPENCODE_GO_WORKSPACE_ID
npx wrangler@4 secret put OPENCODE_GO_AUTH_COOKIE
npx wrangler@4 secret put XFYUN_MAAS_API_URL
npx wrangler@4 secret put XFYUN_MAAS_AUTH_COOKIE
npx wrangler@4 secret put ALIYUN_BAILIAN_AUTH_COOKIE
npx wrangler@4 secret put ALIYUN_BAILIAN_SEC_TOKEN
```

普通默认变量保留在 `wrangler.toml` 的 `[vars]` 中：

- `OPENROUTER_BASE_URL`
- `OPENCODE_GO_BASE_URL`
- `XFYUN_MAAS_PAGE_URL`
- `ALIYUN_BAILIAN_PAGE_URL`
- `ALIYUN_BAILIAN_API_URL` 可为空。默认只展示百炼原网页入口和 partial 状态。
- `ALIYUN_BAILIAN_CLOUD_FETCH` 默认留空。只有设为 `1` 时，Worker 才会尝试实验性百炼云端抓取；抓取遇到登录页、非 JSON 或空数据时会自动回退为原网页入口卡片。

`CREDENTIAL_ENCRYPTION_KEY` 必须是 32 个 UTF-8 字节。配置页保存的第三方凭据会由 Worker 加密后写入 Supabase `provider_account_credentials` 表（已部署 `202606120001_provider_settings_and_credentials.sql` migration 的项目），前端只读取脱敏提示。在该 migration 部署前的过渡期，账号级配置和凭据以 JSONB 形式存到 `provider_accounts.config`（未加密），但表读取仍受 RLS 保护。

## 4. 部署

```powershell
npm run deploy:worker
```

该命令会：

1. 构建 `frontend/dist`
2. 使用 `npx wrangler@4 deploy`
3. 上传 Worker 和静态资源

## 5. 验证

部署后访问：

```text
https://apimonitor.bondtoolbox.asia
```

API 验证：

```powershell
Invoke-RestMethod -Method Get -Uri "https://apimonitor.bondtoolbox.asia/api/usage"
```

期望返回 `ok = true`，并且包含四个 provider：

- `openrouter`
- `opencode-go`
- `xfyun-maas`
- `aliyun-bailian`

配置页入口：

```text
https://apimonitor.bondtoolbox.asia/#/settings
```

配置页采用单页多层展开：

1. 供应商卡片池：查看已配置、可配置、入口型供应商。
2. 账号层：查看某个供应商下的多个账号。
3. 配置层：编辑单个账号的 provider-specific 凭据和原网页入口。
4. 首页显示：控制账号是否作为该供应商首页大卡片内的子卡片展示。

阿里云百炼当前推荐作为“原网页入口型 provider”使用。点击卡片里的“打开看板”会进入阿里云百炼原页面；如果浏览器登录态仍有效，会直接看到 Coding Plan 页面，否则按阿里云页面要求重新扫码或登录。

## 7. OpenCode Go 双账号刷新

OpenCode Go 支持两个账号，分别登录在 Edge 浏览器的不同 Profile 中：

- **jarvislee90s**：Edge Profile 1，对应 `OPENCODE_GO_WORKSPACE_ID`
- **lijiawei_jarvis**：Edge Default，对应 `OPENCODE_GO_WORKSPACE2_ID`

刷新脚本通过本地抓取用量页并推送到 Worker ingest 端点，绕开 Worker 数据中心 IP 封锁：

```powershell
node --experimental-strip-types scripts/refresh-opencode-usage.ts
```

前置条件：关闭所有 Edge 窗口（含后台进程），两个 Profile 都已登录 opencode.ai。

> **注意**：Chrome 149+ 的 App-Bound Encryption (ABE) 会阻止 CDP 读取 cookie，
> 因此不能用 Chrome 提取 opencode.ai 登录态。两个账号都必须用 Edge。

## 6. 不要提交

- `.env`
- `.wrangler/`
- `node_modules/`
- `dist/`
- `frontend/dist/`
- `output/`
- `references/`
- 临时截图和日志
