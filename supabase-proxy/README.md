# supabase-proxy

把自有域名 `supabase.bondtoolbox.asia` 反向代理到 Supabase 项目域名，绕开境内网络对 `*.supabase.co` 的 SNI 阻断。

- 部署：`npx wrangler deploy`（需 `CLOUDFLARE_API_TOKEN`）
- 上游地址在 `wrangler.toml` 的 `[vars] UPSTREAM_HOST`，转发目标固定，不会被当作开放代理
- 完整搭建背景与手把手教程：`docs/tutorials/2026-10-02-supabase-proxy-setup.md`（含 HTML 版）
