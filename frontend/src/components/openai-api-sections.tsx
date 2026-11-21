import {
  OPENAI_API_BUDGET_USD,
  type OpenAiApiCardData,
  type OpenAiApiCosts,
  type OpenAiApiUsage,
} from "../api/client";
import { formatTokens, ModelSpendTable } from "./model-spend-table";
import { QuotaWindowList } from "./quota-window-list";

interface OpenAiApiSectionsProps {
  data: OpenAiApiCardData;
}

// 金额固定两位、US$ 前缀；与 spec 的对账口径一致（额度区独立展示，不进全局合计）
function formatUsd(value: number): string {
  return `US$${value.toFixed(2)}`;
}

// 指标卡的大数字：请求数、Token 数用千分位
function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatTimestamp(value: Date, timeZone: "Asia/Shanghai" | "UTC"): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23",
  }).format(value);
}

function CaptureTime({ data }: OpenAiApiSectionsProps) {
  // 合并两区时间时取共同覆盖的截止时刻，避免旧的一侧看起来也已更新。
  const timestamps = [data.costs.updatedAt, data.usage.updatedAt]
    .map((value) => value ? Date.parse(value) : NaN)
    .filter(Number.isFinite);
  if (timestamps.length === 0) return null;
  const date = new Date(Math.min(...timestamps));
  const iso = date.toISOString();
  return (
    <div className="openai-section__foot openai-section__captured">
      <span>统计截至</span>
      <time dateTime={iso}>北京时间 {formatTimestamp(date, "Asia/Shanghai")}</time>
      <time dateTime={iso}>UTC {formatTimestamp(date, "UTC")}</time>
    </div>
  );
}

// UTC 日期：周期起点与下次重置时刻按约定原样展示 ISO 日期部分
function formatUtcDate(value: string): string {
  if (!value) return "待同步";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return value.slice(0, 10);
}

const ERROR_TEXT: Record<string, string> = {
  not_configured: "未配置组织密钥",
  timeout: "请求超时",
  upstream_failed: "上游返回失败",
  invalid_data: "数据格式无效",
  storage_failed: "存储失败",
};

function errorText(code: string | undefined): string {
  return code ? (ERROR_TEXT[code] ?? code) : "刷新失败";
}

function SectionFoot({ resource }: { resource: OpenAiApiCosts | OpenAiApiUsage }) {
  if (resource.status === "ready") return null;
  return (
    <div className="openai-section__foot">
      {resource.status === "unavailable" ? (
        <span className="openai-section__status openai-section__status--unavailable">
          暂不可用
        </span>
      ) : resource.status === "stale" ? (
        <span className="openai-section__status openai-section__status--stale">
          刷新失败：{errorText(resource.error)}
        </span>
      ) : null}
    </div>
  );
}

// 额度区：已入账费用 / US$100 额度 / 剩余预算，接 UTC 周期与重置提示
export function OpenAiApiQuota({ costs, period }: { costs: OpenAiApiCosts; period: OpenAiApiCardData["period"] }) {
  const used = costs.value;
  const hasValue = typeof used === "number" && Number.isFinite(used);
  const remaining = hasValue ? Math.max(0, OPENAI_API_BUDGET_USD - used!) : null;
  const percent = hasValue
    ? Math.min(100, Math.max(0, (used! / OPENAI_API_BUDGET_USD) * 100))
    : 0;
  const overBudget = hasValue && used! > OPENAI_API_BUDGET_USD;

  const windows = hasValue
    ? [
        {
          label: "本期已入账费用",
          scope: "组织全部项目",
          used: used!,
          limit: OPENAI_API_BUDGET_USD,
          percentUsed: percent,
          resetAt: `${formatUtcDate(period.end)} 00:00 UTC`,
          status: (costs.status === "ready" ? "healthy" : "warning") as "healthy" | "warning",
        },
      ]
    : [];

  return (
    <section className="openai-section" aria-label="组织额度">
      <div className="table-panel__head">
        <h3>额度</h3>
        <span className="chart-panel__hint">组织已入账费用 · US$ 额度</span>
      </div>

      {hasValue ? (
        <>
          <div className="platform-card__metrics">
            <div className="metric-box">
              <span className="section-label">组织额度</span>
              <strong>{formatUsd(OPENAI_API_BUDGET_USD)}</strong>
            </div>
            <div className="metric-box">
              <span className="section-label">剩余预算</span>
              <strong>{formatUsd(remaining!)}</strong>
            </div>
          </div>

          <QuotaWindowList
            windows={windows}
            valueFormatter={() => formatUsd(used!)}
            limitFormatter={() => formatUsd(OPENAI_API_BUDGET_USD)}
          />

          <div className="openai-section__period">
            <span>
              额度周期（UTC）：<span>{formatUtcDate(period.start)}</span> 至{" "}
              <span>{formatUtcDate(period.end)}</span>（起点含、终点不含）
            </span>
          </div>
          {overBudget ? (
            <p className="openai-section__overbudget">已超出 US$100 额度，仍显示真实入账费用。</p>
          ) : null}
        </>
      ) : (
        <div className="table-empty">
          {costs.status === "unavailable" ? "额度暂不可用，等待云端同步后显示。" : "本期暂无额度数据。"}
        </div>
      )}

      <SectionFoot resource={costs} />
    </section>
  );
}

// 文本模型用量区：组织请求数/Token 总数 + Top 5 模型表，两区独立状态
export function OpenAiApiUsageSection({ usage }: { usage: OpenAiApiUsage }) {
  const value = usage.value;
  const hasValue = value !== null;
  const totalTokens = hasValue ? value!.inputTokens + value!.outputTokens : 0;

  return (
    <section className="openai-section" aria-label="文本模型用量">
      <div className="table-panel__head">
        <h3>文本模型用量</h3>
        <span className="chart-panel__hint">组织本期汇总 · 文本模型</span>
      </div>

      {hasValue ? (
        <>
          <div className="platform-card__metrics">
            <div className="metric-box">
              <span className="section-label">文本模型请求数</span>
              <strong>{formatCount(value!.requests)}</strong>
            </div>
            <div className="metric-box">
              <span className="section-label">文本模型 Token 数</span>
              <strong title={formatCount(totalTokens)}>{formatTokens(totalTokens)}</strong>
            </div>
          </div>

          <ModelSpendTable
            rows={value!.topModels.map((model) => ({
              model: model.model,
              requests: model.requests,
              tokens: model.tokens,
              spendUsd: 0,
              share: model.share,
            }))}
            title="文本模型用量 Top 5"
            hint="按 Token 数降序，最多显示 5 个模型"
            emptyText="本期暂无文本模型用量"
            maxRows={5}
            forceTokensColumn
            shareLabel="Token 占比"
          />
        </>
      ) : (
        <div className="table-empty">
          {usage.status === "unavailable"
            ? "文本模型用量暂不可用，等待云端同步后显示。"
            : "本期暂无文本模型用量。"}
        </div>
      )}

      <SectionFoot resource={usage} />
    </section>
  );
}

export function OpenAiApiSections({ data }: OpenAiApiSectionsProps) {
  return (
    <div className="openai-api-sections">
      <OpenAiApiQuota costs={data.costs} period={data.period} />
      <OpenAiApiUsageSection usage={data.usage} />
      <CaptureTime data={data} />
    </div>
  );
}
