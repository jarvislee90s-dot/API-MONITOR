# 分层供应商账号配置页续作计划

## 目标

继续完成 `2026-06-13-layered-provider-account-settings.md` 中尚未闭环的配置页实现，使设置页真正达到“供应商 → 多账号 → 账号配置”的单页多层工作台效果，并让首页供应商大卡片支持账号子卡片切换。

## 当前核验状态

### Playwright 当前截图

当前页面截图显示：配置页已经有三栏外壳，但供应商卡片池、账号列表、账号配置层均未完整呈现。

![当前配置页 Playwright 截图](../../../output/playwright/settings-5174-current.png)

### 目标卡片效果参考

原计划中的卡片呈现参考图如下，后续实现应以该卡片池和多层展开效果为视觉验收基准。

![分层供应商账号配置页参考图](../../assets/settings-layered-model-reference.png)

### 已确认差距

- 页面标题仍是“供应商配置”，未体现“第三版：多层展开配置模型”。
- 页面没有显示 `Level 1: 供应商`、`Level 2: 当前供应商的账号`、`Level 3: 账号配置`。
- 无 `Admin Token` 时 `loadSettings` 直接返回，导致 `catalog` 不加载，供应商卡片池为空。
- 输入 token 后 `/api/settings/providers` 返回 `500`，页面停留在“请求失败 (500)”。
- 当前 Vite `/api` 代理指向云端 Worker，本地调试依赖云端可用性，导致配置页验证不稳定。
- 计划明确“不引入新的 UI 框架或拖拽库”，所以后续只实现可排序账号列表，不实现拖拽库。

## 实施顺序

### 1. 修复本地调试链路

目标：让配置页在本地可以稳定请求 settings API，不依赖当前不可达或返回 500 的云端 Worker。

具体动作：

- 复核 `frontend/vite.config.ts` 中 `/api` 代理配置。
- 优先把本地开发代理改为本地 Worker dev 地址，例如 `http://127.0.0.1:8787`。
- 若暂时不启动 Worker dev，则在前端提供可测试的空状态和 token 提示，不让配置页看起来像“什么都没实现”。
- 复核 `worker/index.ts` 到 `worker/settings/routes.ts` 的 `/api/settings/providers` 路由分发。
- 复核 `worker/settings/routes.ts` 的错误响应，保证返回统一 JSON 错误结构。

完成标准：

- Playwright 打开 `/#/settings` 后，配置页不再因为云端 Worker 超时而卡住。
- `/api/settings/providers` 的失败状态可以明确显示为认证失败、配置缺失或本地 Worker 未启动，而不是泛化的 `请求失败 (500)`。

### 2. 让供应商卡片池首屏可见

目标：即使没有 `Admin Token`，用户也能看到供应商卡片池和入口型 provider 状态；敏感账号数据仍必须依赖 token。

具体动作：

- 调整 `SettingsPage.loadSettings` 的加载策略。
- 将公开 `catalog` 与需要 token 的 `preferences/accounts` 分层处理。
- 无 token 时展示 provider catalog、入口型状态、明确的 token 提示。
- 有 token 时加载偏好、账号列表和安全脱敏配置。
- 保留 `Admin Token` 对写操作和账号凭据读取/保存的保护。

完成标准：

- 无 token 进入配置页时，`ProviderGallery` 至少显示计划内的供应商卡片。
- 供应商卡片包含“已配置 / 可配置 / 入口型”状态。
- “阿里云百炼”显示为入口型 provider，不误导用户填写云端抓取凭据。

### 3. 补齐三层工作台 UI

目标：设置页结构与计划文档一致，形成清晰的 Level 1 / Level 2 / Level 3 单页工作台。

具体动作：

- 页面标题改为“第三版：多层展开配置模型”。
- 第一列标题显示 `Level 1: 供应商`，承载供应商卡片池。
- 第二列标题显示 `Level 2: 当前供应商的账号`，承载账号卡片和首页显示队列。
- 第三列标题显示 `Level 3: 账号配置`，承载账号配置表单、测试连接和安全提示。
- 卡片布局保持现有项目风格，避免营销式 hero 和过度装饰。
- 移动端改为纵向堆叠，保证卡片文字不溢出。

完成标准：

- Playwright snapshot 能直接找到三个 Level 标题。
- 供应商卡片、账号卡片、配置表单在同一页面完成选择和编辑。
- 当前选中的供应商和账号有明显 selected 状态。

### 4. 补齐账号层交互

目标：账号层能表达多账号、首页显示、默认账号和连接测试状态。

具体动作：

- 账号列表展示账号名称、状态、最近测试摘要、首页显示状态。
- 提供“新增账号”入口。
- 提供“启用首页显示 / 停用首页显示”按钮。
- 提供“设为默认显示”能力，继续保留 `activeProviderAccountId` 作为 fallback。
- 用上移/下移按钮实现首页显示排序，不引入拖拽库。
- 测试连接按钮调用现有 `testProviderAccount` API，并把结果写回页面提示。

完成标准：

- 启用账号后，该账号进入首页显示队列。
- 停用账号后，该账号仍保留在账号列表，不删除配置。
- 排序调整后，`homepageOrder` 更新并影响首页卡片内账号子卡片顺序。

### 5. 补齐账号配置表单

目标：第三层表单能按 provider 展示必要字段，并安全保存账号配置。

具体动作：

- OpenRouter：展示 API Key 输入、原网页入口、连接测试。
- OpenCode Go：展示 `workspaceId`、auth cookie 输入、原网页入口、连接测试。
- 讯飞 MaaS：展示原网页入口和登录状态提示，避免误导为云端自动抓取。
- 表单保存时只提交必要字段，不把密钥回显到 UI。
- 对已有账号显示脱敏摘要，例如 `hasSecret`、`maskedCookie` 或安全提示。

完成标准：

- 每个 provider 的配置表单字段与计划一致。
- 保存后页面刷新仍能看到账号卡片，但不能看到真实密钥。
- 入口型 provider 不出现不适用的抓取字段。

### 6. 补齐首页账号子卡片切换

目标：首页仍保持一个供应商一个大卡片，但大卡片内部能切换启用账号。

具体动作：

- 复核 `PlatformCard` 的 `accounts` 渲染。
- 当 provider 有多个 `homepageEnabled` 账号时，显示账号子卡片。
- 点击子卡片后，大卡片主体切换到对应账号快照。
- 若 selected account 被外部数据刷新替换，内部状态同步到有效账号。
- 无账号或账号请求失败时显示清晰空状态。

完成标准：

- 首页每个 provider 仍只有一个大卡片。
- 大卡片内部出现多个账号子卡片。
- 点击不同账号子卡片后，主体数据随账号切换。

## 测试用例

### 前端单元测试

文件建议：

- `tests/frontend/settingsPage.test.tsx`
- `tests/frontend/platformCardAccounts.test.tsx`

用例清单：

1. 无 token 时配置页仍显示供应商卡片池。
2. 无 token 时账号配置区显示明确授权提示，不发起敏感账号保存。
3. 有 token 且 settings API 返回 catalog/preferences/accounts 时，显示三层工作台。
4. 供应商卡片显示“已配置 / 可配置 / 入口型”状态。
5. 点击供应商卡片后，第二层账号列表切换到该 provider。
6. 启用首页显示后，账号进入首页显示队列。
7. 停用首页显示后，账号仍保留在账号列表。
8. 上移/下移首页显示账号后，调用 `updateProviderAccountDisplay` 并更新顺序。
9. 点击测试连接后，页面显示 `testProviderAccount` 返回的摘要。
10. `PlatformCard` 多账号子卡片点击后，大卡片主体显示所选账号数据。

### Worker 测试

文件建议：

- `tests/worker/settings-routes.test.ts`
- `tests/worker/index.test.ts`

用例清单：

1. `GET /api/settings/providers` 返回 catalog、preferences、accounts。
2. 未授权请求返回统一 JSON 错误结构。
3. `PATCH /api/settings/accounts/:id/display` 校验 `homepageEnabled` 和 `homepageOrder`。
4. `PATCH /display` 成功后返回更新后的首页显示状态。
5. Dashboard 聚合同一 provider 的多个首页启用账号。
6. Dashboard 不抓取 `homepageEnabled = false` 的账号。
7. 入口型 provider 不触发不适用的数据抓取。

### Playwright MCP 验收用例

执行目标：

- 本地前端：`http://127.0.0.1:5174/#/settings`
- 本地 Worker：建议 `http://127.0.0.1:8787`

用例清单：

1. 打开配置页，确认标题为“第三版：多层展开配置模型”。
2. Snapshot 中能找到 `Level 1: 供应商`、`Level 2: 当前供应商的账号`、`Level 3: 账号配置`。
3. 无 token 状态下，供应商卡片池至少显示三个 provider 卡片。
4. 输入 token 后，若 API 可用，账号列表和配置表单正常展开。
5. 点击供应商卡片，账号层标题和账号列表随之变化。
6. 点击启用/停用首页显示，首页显示队列即时更新。
7. 点击测试连接，页面显示连接测试结果或明确错误。
8. 截图保存到 `output/playwright/`，并与目标参考图进行人工对照。

## 验证命令

按顺序执行：

```powershell
npm run test:frontend
npm run test:worker
npm run build
```

本地 UI 验证：

```powershell
npm --prefix frontend run dev -- --host 127.0.0.1 --port 5174
```

如需验证真实 API 链路，再另启 Worker dev，并把 Vite 代理指向本地 Worker：

```powershell
npx wrangler@4 dev --port 8787
```

## 回滚方案

- 若本地代理调整导致前端启动异常，先恢复 `frontend/vite.config.ts` 的上一版代理配置。
- 若无 token 展示 catalog 影响安全边界，保留 catalog 可见，但禁止展示账号、密钥摘要和保存入口。
- 若三层工作台布局影响移动端可用性，先保留功能完整性，再压缩卡片间距和改为纵向堆叠。
- 若首页账号切换影响旧数据卡片，保留旧单账号渲染分支作为 fallback。

## 完成判定

只有同时满足以下条件，才算该续作完成：

- 前端测试、Worker 测试、构建均通过。
- Playwright MCP 在设置页能看到三层工作台和供应商卡片。
- Playwright MCP 在首页能看到供应商大卡片内的账号子卡片。
- 设置页截图与目标参考图的结构一致，至少包含供应商卡片池、账号列表、账号配置三层。
- 云端部署后 `https://apimonitor.jarvislee90s.workers.dev/#/settings` 能显示同等结构。
