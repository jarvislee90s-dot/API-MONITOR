# OpenAI API 额度看板设计

## 展示内容

新增独立的 OpenAI API 卡片。「打开原网页」链接指向 [OpenAI API 组织分析概览](https://platform.openai.com/settings/organization/analytics/overview)。

- **额度**沿用 OpenCode Go 的进度条和重置提示，展示本期已入账费用、US$100 额度、剩余预算、统计区间和下次重置时间。剩余预算最低显示 US$0.00，超出额度时保留实际费用。费用覆盖组织的所有项目，以分析概览的「支出总额」为对账目标。
- **文本模型用量**沿用 Command Code 的汇总和模型表，顶部显示本期「文本模型请求数」和「文本模型 Token 数」。表格列为「模型」「请求数」「Token 数」「Token 占比」，按本期 Token 数降序，最多显示 5 个模型。Token 占比的分母为该组织本期全部文本模型的 Token 数。表头说明与实际排序、行数一致。

首版模型表使用 Usage API 的实际用量数据，美元金额只在组织额度区展示。图片、语音和 Embedding 等端点的用量明细可后续扩展。已通过现有 Chrome 登录会话核对 Personal 组织的分析页，11 月 15 日至 11 月 21 日的支出总额为 US$0.00、总请求数和总 Token 数均为 0，图表标注「每日花费（UTC）」。

## 统计周期

每月 15 日 00:00 UTC 切换周期，即北京时间 15 日 08:00。UTC 日期为 1–14 日时从上月 15 日起算，15 日及以后从本月 15 日起算。周期包含起点，截止于下一周期起点之前。Worker 取同一次刷新时刻计算周期和查询范围，查询截至该时刻。卡片标注 UTC，确保不同浏览器时区得到一致的日期范围。

## 拉取、鉴权与刷新

Cloudflare Worker 使用存于 Worker Secret 的组织级 Admin API Key，按同一 UTC 区间查询两个官方接口。

- [OpenAI Costs API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs) 汇总所有分页中的 USD 金额，作为组织已入账费用。费用接口没有 `model` 分组，模型表只展示请求和 Token 数据。
- [OpenAI 文本模型 Usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions/) 使用 `group_by=model`。跨时间桶和分页按模型汇总 `num_model_requests`、`input_tokens`、`output_tokens`。总 Token 为输入加输出，输入已包含缓存命中的 Token。先计算整个组织的总请求数和总 Token，再计算每个模型的占比和取 Top 5。模型名称缺失的记录计入总数并归入「未知模型」。

前端使用现有的已登录刷新流程。所有能返回或刷新这张卡片的入口均校验 Supabase 登录身份及指定用户，Chrome 登录会话用于原页核对。

复用现有 Worker 刷新节流与 Supabase 快照。每次刷新分别查询费用和用量，读取看板时使用快照。两个部分各自保留最近一次同周期成功的结果和采集时间，一个接口失败时，其对应区域显示刷新失败及同周期缓存。缺少同周期缓存时，该区域显示暂不可用。成功返回的完整空结果显示零，模型列表显示「本期暂无文本模型用量」。无效数据、意外币种和任一分页失败均计为对应接口刷新失败。USD 费用在卡片内单独展示。

## 验收

- 验证 UTC 14 日最后一秒、15 日零点和跨年月份，确认周期起点与下次重置时间正确。
- 验证费用和文本用量使用相同的 UTC 查询区间，覆盖空结果、多页汇总、单接口失败、同周期缓存、跨期失效和超支显示。
- 验证同一模型跨时间桶及分页的请求数和 Token 正确累加，缓存命中的输入 Token 只计一次，Top 5 排序、占比分母和表头文案一致。
- 验证匿名用户和其他登录用户无法通过读取、刷新或调试入口访问组织费用和用量。
- 配置组织密钥后，用同一组织和相同 UTC 区间与分析概览核对支出，并用相同文本用量范围核对请求和 Token。检查卡片上的原网页入口。
