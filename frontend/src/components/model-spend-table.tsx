import type { ModelSpendRow } from "../api/client";

interface ModelSpendTableProps {
  rows: ModelSpendRow[];
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function ModelSpendTable({ rows }: ModelSpendTableProps) {
  if (rows.length === 0) {
    return (
      <div className="table-panel">
        <div className="table-panel__head">
          <h3>模型花费</h3>
          <span className="chart-panel__hint">按模型聚合</span>
        </div>
        <div className="table-empty">暂无模型花费数据。</div>
      </div>
    );
  }

  return (
    <div className="table-panel">
      <div className="table-panel__head">
        <h3>模型花费</h3>
        <span className="chart-panel__hint">按模型聚合</span>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>请求</th>
              <th>Token</th>
              <th>花费</th>
              <th>占比</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.model}>
                <td>{row.model}</td>
                <td>{formatNumber(row.requests)}</td>
                <td>{formatNumber(row.tokens)}</td>
                <td>{formatCurrency(row.spendUsd)}</td>
                <td>{Math.round(row.share * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
