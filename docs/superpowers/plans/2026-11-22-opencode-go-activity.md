# OpenCode Go Activity 接入计划

**目标**　在 OpenCode Go 卡片上沿用 Command Code 的布局，展示本期请求数、Token 总量及按请求数排列的模型 Top 5。

- [x] 在已登录 Chrome 验证 Activity 概览的 `GET /console/api/activity/go` 返回 `200`。`startsAt` 是 Go 订阅起点，`daily[]` 的 `totalRequests` 和 `totalTokens` 是可累加的整数字符串，`models[]` 提供 `provider`、`model` 和 `totalRequests`。模型数组没有 Token 字段，因此模型表显示请求数和请求占比，汇总区显示总 Token。
- [x] 在 `worker/providers/opencode-go.ts`、`supabase/functions/opencode-usage/index.ts` 和 `scripts/refresh-opencode-usage.ts` 接入已核实字段，复用现有快照。真实响应中 `access.startsAt` 与 Activity 的 `startsAt` 一致。保留额度窗口与旧快照兼容，账号配置仅在工作区和登录会话同时匹配时复用全局代理。
- [x] 在 `frontend/src/api/client.ts` 映射汇总与模型行，在 `frontend/src/components/platform-card.tsx` 复用模型表。按请求数降序取前 5，同数时按模型名排序。占比以同账号、同周期的全部请求数为分母。缺失字段与真实零量分别处理。
- [x] 独立审查周期、账号隔离和旧快照，运行全量回归、类型检查和前端生产构建。已在 Chrome 核实原站接口和周期，并用测试数据验证桌面、窄屏及账号切换。云端代理到原站的真实连通性留待部署时验证。
