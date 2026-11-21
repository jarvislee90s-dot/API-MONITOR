import type { ModelSpendRow } from "../api/client";

interface ModelSpendTableProps {
  rows: ModelSpendRow[];
  // 可选显示覆盖：OpenAI 组织卡用「Token 占比」表头、固定 Token 列与专用空态，
  // 旧卡沿用默认文案与列规则
  title?: string;
  hint?: string;
  emptyText?: string;
  maxRows?: number;
  forceTokensColumn?: boolean;
  shareLabel?: string;
}

const MAX_ROWS = 6;

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

// 大数按 M/K 缩写（Command Code 的 token 数会到上亿）
export function formatTokens(value: number): string {
  if (value >= 999_950) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return formatNumber(value);
}

export function ModelSpendTable({
  rows,
  title = "模型请求",
  hint,
  emptyText = "暂无模型请求数据。",
  maxRows = MAX_ROWS,
  forceTokensColumn = false,
  shareLabel = "占比",
}: ModelSpendTableProps) {
  const visibleRows = rows.slice(0, maxRows);
  // 有 token 数（或显式要求）时显示 Token 列；Ollama 只有请求数时保持三列
  const hasTokens = forceTokensColumn || visibleRows.some((row) => row.tokens > 0);

  if (visibleRows.length === 0) {
    return (
      <div className="table-panel">
        <div className="table-panel__head">
          <h3>{title}</h3>
          <span className="chart-panel__hint">{hint ?? "按模型聚合"}</span>
        </div>
        <div className="table-empty">{emptyText}</div>
      </div>
    );
  }

  return (
    <div className="table-panel">
      <div className="table-panel__head">
        <h3>{title}</h3>
        <span className="chart-panel__hint">
          {hint ?? `按请求数降序，最多显示前 ${maxRows} 个`}
        </span>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>请求数</th>
              {hasTokens ? <th>Token 数</th> : null}
              <th>{shareLabel}</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={row.model}>
                <td>{row.model}</td>
                <td>{formatNumber(row.requests)}</td>
                {hasTokens ? <td>{formatTokens(row.tokens)}</td> : null}
                <td>{Math.round(row.share * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
