import type { QuotaWindow } from "../api/client";

interface QuotaWindowListProps {
  windows: QuotaWindow[];
}

function formatValue(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

// 额度转"万"单位（>=1 万时），如 12000 -> 1.2万
function formatWan(value: number): string {
  if (value >= 10000) {
    return `${(value / 10000).toFixed(1)}万`;
  }
  return formatValue(value);
}

function getRatio(window: QuotaWindow): number {
  if (window.limit > 0) {
    return Math.min(100, Math.max(0, (window.used / window.limit) * 100));
  }
  if (typeof window.percentUsed === "number" && Number.isFinite(window.percentUsed)) {
    return Math.min(100, Math.max(0, window.percentUsed));
  }
  return 0;
}

export function QuotaWindowList({ windows }: QuotaWindowListProps) {
  if (windows.length === 0) {
    return <div className="quota-empty">暂无额度窗口，等待云端同步后显示。</div>;
  }

  return (
    <div className="quota-list">
      {windows.map((window) => {
        const ratio = getRatio(window);
        const hasLimit = window.limit > 0;
        const hasPercent = typeof window.percentUsed === "number" && Number.isFinite(window.percentUsed);

        return (
          <section key={`${window.label}-${window.scope}`} className="quota-row">
            <div className="quota-row__meta">
              <div>
                <p className="section-label">{window.label}</p>
                <p className="quota-row__scope">{window.scope}</p>
              </div>
              <p className="quota-row__value">
                <strong>{formatValue(window.used)}</strong>
                {hasLimit ? (
                  <span> / {formatWan(window.limit)}</span>
                ) : hasPercent ? (
                  <span> / {Math.round(window.percentUsed! * 10) / 10}%</span>
                ) : null}
              </p>
            </div>
            <div className="progress" aria-hidden="true">
              <span
                className={`progress__bar progress__bar--${window.status}`}
                style={{ width: `${ratio}%` }}
              />
            </div>
            <div className="quota-row__foot">
              <span>重置于 {window.resetAt}</span>
              <span>{Math.round(ratio)}%</span>
            </div>
          </section>
        );
      })}
    </div>
  );
}
