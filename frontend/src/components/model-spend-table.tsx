import type { ModelSpendRow } from "../api/client";

interface ModelSpendTableProps {
  rows: ModelSpendRow[];
}

const MAX_ROWS = 6;

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function ModelSpendTable({ rows }: ModelSpendTableProps) {
  const visibleRows = rows.slice(0, MAX_ROWS);

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
              <th>占比</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={row.model}>
                <td>{row.model}</td>
                <td>{formatNumber(row.requests)}</td>
                <td>{Math.round(row.share * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
