import type { ModelSpendRow } from "../api/client";

interface ModelSpendTableProps {
  rows: ModelSpendRow[];
}

const MAX_ROWS = 6;

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

// 大数按 M/K 缩写（Command Code 的 token 数会到上亿）
function formatTokens(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return formatNumber(value);
}

export function ModelSpendTable({ rows }: ModelSpendTableProps) {
  const visibleRows = rows.slice(0, MAX_ROWS);
  // 有 token 数时多显示一列（Command Code）；Ollama 只有请求数时保持三列
  const hasTokens = visibleRows.some((row) => row.tokens > 0);

  if (visibleRows.length === 0) {
    return (
      <div className="table-panel">
        <div className="table-panel__head">
          <h3>模型请求</h3>
          <span className="chart-panel__hint">按模型聚合</span>
        </div>
        <div className="table-empty">暂无模型请求数据。</div>
      </div>
    );
  }

  return (
    <div className="table-panel">
      <div className="table-panel__head">
        <h3>模型请求</h3>
        <span className="chart-panel__hint">按请求数降序，最多显示前 {MAX_ROWS} 个</span>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>请求数</th>
              {hasTokens ? <th>Token 数</th> : null}
              <th>占比</th>
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
