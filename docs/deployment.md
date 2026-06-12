# 部署说明

当前部署方式是 Cloudflare Worker 同时托管 API 和前端静态资源。

- API 入口：`worker/index.ts`
- 前端源码：`frontend/src`
- 前端构建产物：`frontend/dist`
- 线上域名示例：`https://apimonitor.jarvislee90s.workers.dev`

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
run_worker_first = ["/api/*"]
```

`run_worker_first = ["/api/*"]` 需要 Wrangler v4，因此部署命令使用：

```powershell
npx wrangler@4 deploy
```

## 3. Secrets

真实密钥不要写进 `wrangler.toml`，使用 Wrangler secret 或 Cloudflare Dashboard 配置。

```powershell
npx wrangler@4 secret put SUPABASE_URL
npx wrangler@4 secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler@4 secret put SUPABASE_USER_ID
npx wrangler@4 secret put CREDENTIAL_ENCRYPTION_KEY
npx wrangler@4 secret put ADMIN_SETUP_TOKEN
npx wrangler@4 secret put OPENROUTER_API_KEY
npx wrangler@4 secret put OPENCODE_GO_WORKSPACE_ID
npx wrangler@4 secret put OPENCODE_GO_AUTH_COOKIE
npx wrangler@4 secret put XFYUN_MAAS_API_URL
npx wrangler@4 secret put XFYUN_MAAS_AUTH_COOKIE
npx wrangler@4 secret put ALIYUN_BAILIAN_AUTH_COOKIE
```

普通默认变量保留在 `wrangler.toml` 的 `[vars]` 中：

- `OPENROUTER_BASE_URL`
- `OPENCODE_GO_BASE_URL`
- `XFYUN_MAAS_PAGE_URL`
- `ALIYUN_BAILIAN_PAGE_URL`
- `ALIYUN_BAILIAN_API_URL` 可为空。为空时只展示百炼入口和 partial 状态；补充稳定 JSON API 后解析 quota windows。

`CREDENTIAL_ENCRYPTION_KEY` 必须是 32 个 UTF-8 字节。配置页保存的第三方凭据会由 Worker 加密后写入 Supabase，前端只读取脱敏提示。

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
https://apimonitor.jarvislee90s.workers.dev
```

API 验证：

```powershell
Invoke-RestMethod -Method Get -Uri "https://apimonitor.jarvislee90s.workers.dev/api/usage"
```

期望返回 `ok = true`，并且包含四个 provider：

- `openrouter`
- `opencode-go`
- `xfyun-maas`
- `aliyun-bailian`

配置页入口：

```text
https://apimonitor.jarvislee90s.workers.dev/#/settings
```

打开后输入 `ADMIN_SETUP_TOKEN`。配置页支持：

- 启用或隐藏供应商。
- 调整首页卡片顺序。
- 为单个供应商新增账号凭据。
- 选择 active account。
- 测试账号连接。

## 6. 不要提交

- `.env`
- `.wrangler/`
- `node_modules/`
- `dist/`
- `frontend/dist/`
- `output/`
- `references/`
- 临时截图和日志
