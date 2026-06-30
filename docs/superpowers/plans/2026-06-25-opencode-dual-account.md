# OpenCode Go 双账号刷新支持 - 实施计划

日期：2026-06-25
关联设计：docs/superpowers/specs/2026-06-25-opencode-dual-account-design.md

## 任务

### 任务 1：改造 refresh-opencode-usage.ts 支持双账号

步骤：
1. 定义 ACCOUNTS 列表，每项含 label、browser channel、userDataDir、workspaceIdEnv
   - 账号1: jarvislee90s, chrome, Google/Chrome/User Data, OPENCODE_GO_WORKSPACE_ID
   - 账号2: lijiawei_jarvis, msedge, Microsoft/Edge/User Data, OPENCODE_GO_WORKSPACE2_ID
2. 将单次 cookie 提取改为按账号串行处理：每账号用绑定浏览器提取 cookie
3. 每账号用各自 workspaceId 构造 sourceUrl 抓取用量页
4. 推送 snapshot 时带 meta.accountLabel，sourceUrl 各自不同
5. 单账号失败不阻塞另一个，最后汇总成功/失败数
6. 保留浏览器锁清理与现有解析逻辑

验证：node --experimental-strip-types scripts/refresh-opencode-usage.ts 手动确认两账号刷新

### 任务 2：App.tsx 首屏占位补全第二个账号

步骤：
1. 按 GBK 编码读取 App.tsx
2. 在 opencode-go accounts 数组中追加第二个占位账号：
   - id: opencode-go:account2
   - label: lijiawei_jarvis
   - sourceUrl: 用 OPENCODE_GO_WORKSPACE2_ID 的 workspace
3. 按 GBK 编码写回，保持其余内容不变

验证：npm run frontend:test 通过

### 任务 3：验证

步骤：
1. 运行 npm run frontend:test 确认前端测试通过
2. 检查 TypeScript 类型（如适用）