import type { QuotaWindow } from "../api/client";

interface QuotaWindowListProps {
  windows: QuotaWindow[];
}

function formatValue(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function getRatio(window: QuotaWindow): number {
  if (window.limit <= 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, (window.used / window.limit) * 100));
}

export function QuotaWindowList({ windows }: QuotaWindowListProps) {
  if (windows.length === 0) {
    return <div className="quota-empty">暂无额度窗口，等待云端同步后显示。</div>;
  }

  return (
    <div className="quota-list">
      {windows.map((window) => {
        const ratio = getRatio(window);

        return (
          <section key={`${window.label}-${window.scope}`} className="quota-row">
            <div className="quota-row__meta">
              <div>
                <p className="section-label">{window.label}</p>
                <p className="quota-row__scope">{window.scope}</p>
              </div>
              <p className="quota-row__value">
                <strong>{formatValue(window.used)}</strong>
                <span> / {formatValue(window.limit)}</span>
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
