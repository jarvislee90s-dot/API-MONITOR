import type { CSSProperties } from "react";
import { AlertTriangle, ArrowUpRight, CheckCircle2, Clock3, RefreshCw } from "lucide-react";
import type { PlatformSnapshot } from "../api/client";
import { ModelSpendTable } from "./model-spend-table";
import { QuotaWindowList } from "./quota-window-list";
import { RawLinks } from "./raw-links";
import { UsageTrendChart } from "./usage-trend-chart";

interface PlatformCardProps {
  platform: PlatformSnapshot;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

const statusText: Record<PlatformSnapshot["status"], string> = {
  healthy: "健康",
  warning: "注意",
  partial: "部分接入",
  login_required: "待登录",
};

const statusIcon: Record<PlatformSnapshot["status"], typeof CheckCircle2> = {
  healthy: CheckCircle2,
  warning: AlertTriangle,
  partial: RefreshCw,
  login_required: Clock3,
};

export function PlatformCard({ platform }: PlatformCardProps) {
  const StatusIcon = statusIcon[platform.status];
  const cardStyle = {
    "--accent": platform.accent,
  } as CSSProperties;

  return (
    <article className="platform-card" style={cardStyle}>
      <header className="platform-card__header">
        <div className="platform-card__heading">
          <p className="section-label">{platform.tagline}</p>
          <h2>{platform.name}</h2>
          <p className="platform-card__summary">{platform.summary}</p>
        </div>

        <div className="platform-card__status">
          <span className={`status-pill status-pill--${platform.status}`}>
            <StatusIcon size={14} aria-hidden="true" />
            {statusText[platform.status]}
          </span>
          <span className="platform-card__updated">
            <ArrowUpRight size={14} aria-hidden="true" />
            {platform.sourceLabel}
          </span>
        </div>
      </header>

      <section className="platform-card__metrics">
        <div className="metric-box">
          <span className="section-label">{platform.primaryMetricLabel}</span>
          <strong>{platform.primaryMetricValue}</strong>
        </div>
        <div className="metric-box">
          <span className="section-label">登录状态</span>
          <strong>{platform.loginState}</strong>
        </div>
        <div className="metric-box">
          <span className="section-label">最近同步</span>
          <strong>{formatTimestamp(platform.lastRefreshedAt)}</strong>
        </div>
      </section>

      <div className="platform-card__grid">
        <QuotaWindowList windows={platform.quotaWindows} />
        <UsageTrendChart
          title={`${platform.name} 趋势`}
          points={platform.trend}
          accent={platform.accent}
        />
      </div>

      <div className="platform-card__grid platform-card__grid--footer">
        <ModelSpendTable rows={platform.modelSpends} />
        <div className="platform-card__links">
          <h3>原网页和入口</h3>
          <p className="platform-card__links-copy">
            打开供应商原始看板；未登录时会跳转到对应登录页面。
          </p>
          <RawLinks links={platform.links} />
        </div>
      </div>
    </article>
  );
}
