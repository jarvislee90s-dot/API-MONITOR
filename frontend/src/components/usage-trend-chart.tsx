import { useId } from "react";
import type { TrendPoint } from "../api/client";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface UsageTrendChartProps {
  title: string;
  points: TrendPoint[];
  accent: string;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function UsageTrendChart({ title, points, accent }: UsageTrendChartProps) {
  const gradientId = useId();

  if (points.length === 0) {
    return (
      <div className="chart-panel">
        <div className="chart-panel__head">
          <h3>{title}</h3>
          <span className="chart-panel__hint">等待云端快照</span>
        </div>
        <div className="chart-empty">暂无趋势数据，后续会显示 24 小时或 30 天曲线。</div>
      </div>
    );
  }

  return (
    <div className="chart-panel">
      <div className="chart-panel__head">
        <h3>{title}</h3>
        <span className="chart-panel__hint">使用量 / 花费</span>
      </div>
      <div className="trend-chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity={0.28} />
                <stop offset="100%" stopColor={accent} stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} />
            <YAxis tickLine={false} axisLine={false} width={36} />
            <Tooltip
              cursor={{ stroke: accent, strokeWidth: 1 }}
              contentStyle={{
                borderRadius: 8,
                border: "1px solid var(--line)",
                background: "var(--surface)",
                boxShadow: "var(--shadow)",
              }}
              formatter={(value: number, name) => {
                if (name === "spendUsd") {
                  return [formatCurrency(value), "花费"];
                }

                return [new Intl.NumberFormat("zh-CN").format(value), "使用量"];
              }}
            />
            <Area type="monotone" dataKey="usage" stroke={accent} fill={`url(#${gradientId})`} />
            <Line type="monotone" dataKey="spendUsd" stroke="var(--muted)" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
