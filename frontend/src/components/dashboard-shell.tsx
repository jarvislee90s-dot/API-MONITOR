import { Activity, AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, SlidersHorizontal } from "lucide-react";
import type { DashboardSnapshot } from "../api/client";
import { PlatformCard } from "./platform-card";

export type DashboardSyncState = "loading" | "ready" | "error";

interface DashboardShellProps {
  dashboard: DashboardSnapshot;
  isActive: boolean;
  isRefreshing: boolean;
  syncState: DashboardSyncState;
  syncMessage: string | null;
  onRefresh: () => void;
  // 本地 DEV 预览专用：隐藏无实际作用的刷新/配置按钮，并展示示例数据提示
  previewNotice?: string | null;
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

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function DashboardShell({
  dashboard,
  isActive,
  isRefreshing,
  syncState,
  syncMessage,
  onRefresh,
  previewNotice,
}: DashboardShellProps) {
  const totalSpend = dashboard.platforms.reduce((sum, platform) => {
    return (
      sum +
      platform.modelSpends.reduce((modelTotal, row) => {
        return modelTotal + row.spendUsd;
      }, 0)
    );
  }, 0);

  const totalUsage = dashboard.platforms.reduce((sum, platform) => {
    return sum + (platform.trend.at(-1)?.usage ?? 0);
  }, 0);

  const syncIcon =
    syncState === "error" ? AlertTriangle : syncState === "ready" ? CheckCircle2 : RefreshCw;
  const SyncIcon = syncIcon;

  return (
    <main className="app-shell">
      <div className="app-shell__inner">
        <header className="hero">
          <div className="hero__top">
            <div className="brand">
              <p className="kicker">ApiMonitor</p>
              <h1>API 与 Coding Plan 用量看板</h1>
              <p>
                {previewNotice
                  ? "本地示例数据预览：复用真实卡片渲染链，可切换不同状态查看；原网页链接仅在点击后跳转。"
                  : "同一屏里看三个平台的健康状态、quota window、趋势、模型花费和原网页入口，活跃时自动刷新，空闲后自动暂停。"}
              </p>
            </div>

            {previewNotice ? (
              <div className="activity-pill is-idle" aria-label="本地预览状态">
                <ShieldCheck size={14} aria-hidden="true" />
                本地示例数据
              </div>
            ) : (
              <div className="actions">
                <a className="btn btn--ghost" href="#/settings">
                  <SlidersHorizontal size={16} aria-hidden="true" />
                  配置
                </a>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={onRefresh}
                  disabled={isRefreshing}
                  aria-busy={isRefreshing}
                >
                  <RefreshCw size={16} aria-hidden="true" className={isRefreshing ? "icon-spin" : ""} />
                  {isRefreshing ? "同步中" : "立即刷新"}
                </button>
                <span className={`activity-pill ${isActive ? "is-active" : "is-idle"}`}>
                  <Activity size={14} aria-hidden="true" />
                  {isActive ? "活跃刷新中" : "已暂停自动刷新"}
                </span>
              </div>
            )}
          </div>

          {previewNotice ? (
            <div className="sync-banner sync-banner--loading">
              <ShieldCheck size={14} aria-hidden="true" />
              <span>{previewNotice} · 预览仅渲染 OpenAI 组织卡，虚构金额与用量不代表真实账单。</span>
            </div>
          ) : null}

          {syncMessage ? (
            <div className={`sync-banner sync-banner--${syncState}`}>
              <SyncIcon
                size={14}
                aria-hidden="true"
                className={syncState === "loading" ? "icon-spin" : ""}
              />
              <span>{syncMessage}</span>
            </div>
          ) : null}

          {previewNotice ? null : (
            <>
              <div className="summary-bar">
                <div className="summary-card">
                  <span className="section-label">总花费</span>
                  <strong>{formatCurrency(totalSpend)}</strong>
                </div>
                <div className="summary-card">
                  <span className="section-label">最新使用量</span>
                  <strong>{new Intl.NumberFormat("zh-CN").format(totalUsage)}</strong>
                </div>
                <div className="summary-card">
                  <span className="section-label">平台数量</span>
                  <strong>{dashboard.platforms.length}</strong>
                </div>
                <div className="summary-card">
                  <span className="section-label">刷新时间</span>
                  <strong>{formatTimestamp(dashboard.refreshedAt)}</strong>
                </div>
              </div>

              <div className="hero__foot">
                <span className="hero__note">
                  <ShieldCheck size={14} aria-hidden="true" />
                  数据状态：{dashboard.status === "ready" ? "就绪" : "部分可用"}
                </span>
                <span className="hero__note">生成于 {formatTimestamp(dashboard.generatedAt)}</span>
              </div>
            </>
          )}
        </header>

        <section className="dashboard-grid" aria-label="三平台统一看板">
          {dashboard.platforms.map((platform) => (
            <PlatformCard key={platform.id} platform={platform} />
          ))}
        </section>
      </div>
    </main>
  );
}
