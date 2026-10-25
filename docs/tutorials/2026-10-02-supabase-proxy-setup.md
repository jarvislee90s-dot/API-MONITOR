# Supabase 反向代理搭建与使用 · 手把手教程

> 日期：2026-10-02 ｜ 适用项目：ApiMonitor（以及任何需要在国内网络访问 Supabase 的项目）
> HTML 图文版：`docs/tutorials/2026-10-02-supabase-proxy-setup.html`（双击即可打开，含彩色架构图）

---

## 0. 一图看懂：为什么需要它

```
【改造前】本机 → supabase.co
┌──────────┐   ①TCP 能连上    ┌─────────────────────────┐
│ 你的电脑  │ ───────────────▶ │ supabase.co（TLS 握手时） │
└──────────┘   ②TLS 被重置 ❌  │ 被按域名(SNI)阻断         │
                              └─────────────────────────┘
  表现：脚本报 [WARN] 查询 Supabase 账号失败 / 浏览器登录设置页转圈失败

【改造后】本机 → 自有域名 → Cloudflare 内部 → supabase.co
┌──────────┐  TLS 正常 ✅  ┌──────────────────────┐  Cloudflare 机房之间  ┌────────────┐
│ 你的电脑  │ ───────────▶ │ supabase.bondtoolbox │ ───────────────────▶ │ supabase.co │
└──────────┘  不在封锁名单  │ .asia（CF Worker）    │   不经过墙，畅通 ✅    │ (新加坡等)  │
                            └──────────────────────┘                      └────────────┘
```

被墙判定的是 TLS 握手时客户端报出的域名（SNI）。换成你自己的域名后，防火墙看到的是 `bondtoolbox.asia`，不在封锁名单里；Cloudflare Worker 再从它自己的海外网络访问 `supabase.co`，全程不经过墙。

**唯一红线**：不能用 Worker 默认的 `xxx.workers.dev` 域名——它在境内同样被 DNS 污染，必须绑定自有域名（本教程已绑定 `supabase.bondtoolbox.asia`）。

---

## 1. 已经替你完成的部分（2026-10-02）

以下步骤已经做完并验证通过，你**不需要**重复操作，了解即可（重建环境时按第 3 节来）：

| # | 已完成事项 | 结果 |
|---|-----------|------|
| 1 | 新建 `supabase-proxy/` Worker 项目并部署（`npx wrangler deploy`） | Worker `supabase-proxy` 已上线 |
| 2 | 绑定自定义域名 `supabase.bondtoolbox.asia`（DNS 记录自动创建） | 已生效 |
| 3 | 把 apimonitor Worker 的 secret `SUPABASE_URL` 切到反代域名 | 已生效，`/api/auth/config` 返回新地址 |
| 4 | 本地 `.env` 的 `SUPABASE_URL` 切到反代域名 | 已生效 |
| 5 | 验证：直连（不挂代理）TLS 5/5 成功、REST 3/3 可达；看板 API 正常 | ✅ |

---

## 2. 三分钟验证一切正常

### 2.1 浏览器验证（最简单）

直接在浏览器打开：

```
https://supabase.bondtoolbox.asia/healthz
```

看到 `ok` 两个字母即成功。（这一步不需要登录任何账号）

### 2.2 命令行验证（可选）

在项目根目录（`E:\LLMproject\ApiMonitor`）的 PowerShell 里执行：

```powershell
node --experimental-strip-types scripts/test-supabase-connectivity.ts --url=https://supabase.bondtoolbox.asia
```

**判读要点**：
- `[4] 直连 TLS 握手` 全部 ✅、`[5] 直连 REST` 显示 `HTTP 401(可达)` → 一切正常。401 是 Supabase 网关对"没带密钥的请求"的正常应答，恰恰证明全链路通。
- 脚本可能提示"本地解析与 DoH 不一致，可能存在 DNS 污染"——对 Cloudflare 托管的域名这是**误报**：`172.67.x.x` 和 `104.21.x.x` 都是 Cloudflare 的正常任播 IP，两个都对。

### 2.3 对比（旧域名仍然不通）

```powershell
node --experimental-strip-types scripts/test-supabase-connectivity.ts
```

不加 `--url` 时读 `.env` 的 `SUPABASE_URL`（现在是反代域名）。如果想看旧域名被墙的现状，可以手动 `--url=https://cdzjuvewreribelvpccz.supabase.co`，会看到 TLS 0/5 全部 `ECONNRESET`。

---

## 3. 从零重建（换电脑 / 删除后重来时才需要）

### 步骤 1：部署反代 Worker（命令行，1 分钟）

前置：`.env` 里已有 `CLOUDFLARE_API_TOKEN`（且该 token 有 Workers Scripts 上传与 Zone DNS 编辑权限）。

```powershell
cd E:\LLMproject\ApiMonitor
$env:CLOUDFLARE_API_TOKEN="你的token值"
npx wrangler deploy --config supabase-proxy/wrangler.toml
```

成功标志（最后几行）：

```
Uploaded supabase-proxy
Deployed supabase-proxy triggers
  supabase.bondtoolbox.asia (custom domain)   ← 这行出现说明域名也绑好了
```

> 如果只在 `*.workers.dev` 上部署成功而没有 custom domain 那一行，说明 token 缺少 DNS 编辑权限 → 走"步骤 2"在控制台手动绑。

### 步骤 2：（仅当步骤 1 没绑上域名时）控制台手动绑域名

带图参考：[Cloudflare 官方文档 · Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#add-a-custom-domain)（含界面截图）

1. 打开 [dash.cloudflare.com](https://dash.cloudflare.com) 登录。
2. 左侧菜单点 **Workers & Pages**（中文界面叫"计算 Workers 和 Pages"）。
3. 在列表里点 **supabase-proxy**。
4. 进入后点顶部 **Settings**（设置）标签 → 找到 **Domains & Routes**（域和路由）卡片 → 点 **Add**（添加）→ 选 **Custom domain**（自定义域）。
5. 输入 `supabase.bondtoolbox.asia` → 点 **Add domain**。
6. 等状态从 `Initializing` 变成 `Active`（1~2 分钟），DNS 记录会自动创建，不需要你去 DNS 页面手填。

### 步骤 3：把使用方指向反代域名

需要改 `SUPABASE_URL` 的地方（当前项目两处都已改好，此处供重建/其他项目参考）：

| 使用方 | 位置 | 改成 |
|--------|------|------|
| 本地脚本 | 项目根目录 `.env` 的 `SUPABASE_URL` | `https://supabase.bondtoolbox.asia` |
| 看板 Worker | Cloudflare 控制台 → Workers & Pages → **apimonitor** → Settings → **Variables and Secrets** → 编辑 `SUPABASE_URL` | `https://supabase.bondtoolbox.asia` |
| 其他项目 | 该项目的 env / supabase-js `createClient(url, ...)` 第一个参数 | `https://supabase.bondtoolbox.asia` |

改完看板 Worker 的 secret 后，浏览器访问 `https://apimonitor.bondtoolbox.asia/api/auth/config`，确认返回的 `supabaseUrl` 是新域名。

### 步骤 4（可选但推荐）：Supabase 控制台补 Site URL

> 这个域名（supabase.com/dashboard）境内也可能打不开，挂一次代理打开即可，只做一次。

1. 打开 [supabase.com/dashboard](https://supabase.com/dashboard) → 选择你的项目。
2. 左下角 **Authentication**（身份验证）→ **URL Configuration**（URL 配置）。
3. **Site URL** 填 `https://apimonitor.bondtoolbox.asia`；**Redirect URLs** 里也加上它。
4. 点 Save。

对"邮箱+密码登录且未开邮件确认"的项目，这步不影响登录，但为将来启用邮件确认/魔法链接做准备（邮件里的链接会指向 Site URL）。

---

## 4. 恢复看板两张卡（补写昨天没写进去的 cookie）

反代通了以后，刷新脚本终于能把 cookie 写进 Supabase 了。**这次不用挂任何代理**，直接在 PowerShell 执行：

```powershell
cd E:\LLMproject\ApiMonitor
node --experimental-strip-types scripts/refresh-zhipu-cookie.ts
node --experimental-strip-types scripts/refresh-volc-ark-cookie.ts
```

**判读要点**：

智谱脚本，成功标志是这两行（之前的 `[WARN] 查询 Supabase 账号失败` 不再出现）：

```
[OK] 加密凭据已写入 provider_account_credentials
[OK] Supabase 账号 config.authCookie/authToken 已更新
```

火山脚本：
- `cherry` 段应出现上面同样的两行 `[OK]`（首页展示的就是 cherry）。
- `默认账号` 段仍会 `[FAIL] Cookie 无效: 接口未返回用量数据`——这是该账号本身没有有效的 Coding Plan 订阅数据，**与网络无关，属预期**，不影响看板。

跑完后回到看板点一次刷新：智谱、火山方舟两张卡的"使用缓存数据"应消失，时间戳变成当前时间。

以后 cookie 过期（智谱约 7 天、火山 digest 到期）重新跑这两个脚本即可，**全程不需要代理**。

---

## 5. 另一个项目怎么复用这个反代

反代已支持**多项目映射**（按入口域名转发到不同上游项目），当前已有两条路由：

| 入口域名 | 上游 Supabase 项目 | 服务的项目 |
|---------|-------------------|-----------|
| `supabase.bondtoolbox.asia` | `cdzjuvewreribelvpccz.supabase.co` | ApiMonitor 看板 |
| `supabase2.bondtoolbox.asia` | `onexoaebobgpwokgoxwy.supabase.co` | Bond_Toolbox |

1. 把该项目的 Supabase 地址换成对应入口域名：
   - 后端/脚本：env 里的 `SUPABASE_URL`；
   - 前端 supabase-js：`createClient("https://supabase2.bondtoolbox.asia", ANON_KEY)`；
   - Vite/Next 等框架的对应环境变量（`VITE_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`）。
2. 密钥（service key / anon key）保持不变，反代只换"门牌号"。
3. 如果要接**第三个 Supabase 项目**：改 `supabase-proxy/wrangler.toml` 两处——`UPSTREAM_MAP` 里加一条 `"入口域名":"上游项目"`，再加一个 `[[routes]]`（新入口域名），然后 `npx wrangler deploy`。
4. 如果那个项目开启了 Supabase Auth 邮件相关功能：在它的 Supabase Dashboard → Authentication → URL Configuration 里把 Site URL 配好。
5. Supabase Edge Functions（跑在 Supabase 服务器上的 `functions/`）是服务端到服务端，不受墙影响，不用改。

**安全边界**：反代只是"换了个门牌号"，所有数据访问仍然需要 `apikey` / `Authorization` 头（密钥从不经过、不存放在反代里）；转发目的地固定为映射表里的项目域名，别人不能拿它当跳板访问其他网站。

---

## 6. 常见问题（FAQ）

**Q1：为什么首次请求偶尔要几秒钟？**
Cloudflare Worker 冷启动 + 首次 TLS 握手，属正常现象。热身后通常几百毫秒。部署后第一次访问 `/api/usage` 曾出现 30+ 秒，之后稳定在 4 秒左右（该接口本身要实时拉取全部 provider）。

**Q2：为什么不直接用 `xxx.workers.dev` 域名？**
`*.workers.dev` 在境内被 DNS 污染/Sinkhole（[Cloudflare 社区确认](https://community.cloudflare.com/t/cloudflare-workers-suspected-of-being-blocked-in-china/382155)），必须绑自有域名。

**Q3：Supabase 控制台 / 官网打不开了怎么办？**
`supabase.com`（控制台域名）与 `*.supabase.co`（API 域名）都可能被干扰。控制台只是配置时偶尔用一次，挂代理打开即可；**日常数据访问走 `supabase.bondtoolbox.asia` 完全不受影响**。

**Q4：怎么看反代的流量/报错？**
Cloudflare 控制台 → Workers & Pages → supabase-proxy → **Metrics**（指标）/ **Logs**（实时日志）。`/healthz` 可随时探活。

**Q5：连通性测试脚本报"DNS 不一致"是坏事吗？**
不是。Cloudflare 任播网络本来就会对不同地点返回不同的合法 IP（`172.67.x.x` 与 `104.21.x.x` 都是），只要 TCP/TLS/REST 三层 ✅ 就没问题。

**Q5：前端登录报 `Failed to fetch`？**
反代会在本地应答浏览器 CORS 预检（上游对不带 apikey 的 OPTIONS 回 401，浏览器要求预检必须 2xx）。2026-10-02 已修复上线；若再遇到，先确认 `https://supabase.bondtoolbox.asia/healthz` 能打开，再看 `supabase-proxy` 的 Logs 排查。

**Q6：想改上游项目域名或加第二个 Supabase 项目？**
改/复制 `supabase-proxy/wrangler.toml`：`name`、`UPSTREAM_HOST`、`routes.pattern` 三处，然后重新 `npx wrangler deploy`。

---

## 7. 回滚（如需恢复直连）

1. 本地 `.env`：`SUPABASE_URL` 改回 `https://cdzjuvewreribelvpccz.supabase.co`。
2. 看板 Worker：Workers & Pages → apimonitor → Settings → Variables and Secrets → `SUPABASE_URL` 编辑改回同值。
3. 删除反代 Worker：Workers & Pages → supabase-proxy → Settings → 页面底部 **Delete**（自定义域名记录会一并解除）。
4. 注意：回滚后脚本/浏览器会立刻回到"连接被重置"的状态，仅在你确定不再需要时执行。

---

## 8. 参考链接

- 架构与原理：[Supabase 官方博客 · Navigating Regional Network Blocks](https://supabase.com/blog/navigating-regional-network-blocks)
- 反代教程（带截图）：[How to Proxy Supabase Through Cloudflare Workers](https://jiobase.com/blog/proxy-supabase-cloudflare-workers) ｜ [The Great Supabase Block（Medium）](https://medium.com/@the-underrated-explorer/the-great-supabase-block-how-i-bypassed-failed-to-fetch-with-a-cloudflare-worker-8ccc2de7cb29)
- Cloudflare 官方：[Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) ｜ [workers.dev 域名被污染的讨论](https://community.cloudflare.com/t/cloudflare-workers-suspected-of-being-blocked-in-china/382155)
- Supabase 被墙长期监测：[GreatFire · supabase.co](https://zh.greatfire.org/domain/supabase.co) ｜ [supabase#2631](https://github.com/supabase/supabase/issues/2631)
- 本仓库连通性测试脚本：`scripts/test-supabase-connectivity.ts`
