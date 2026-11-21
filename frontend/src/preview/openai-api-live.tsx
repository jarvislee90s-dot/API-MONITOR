import { useCallback, useEffect, useRef, useState } from "react";
import { createApiClient, type DashboardSnapshot } from "../api/client";
import { PlatformCard } from "../components/platform-card";
import { useActiveRefresh } from "../hooks/useActiveRefresh";

const loadDashboard = (refresh: boolean) => createApiClient({
  fetcher: () => fetch("/__local/openai/usage", { method: refresh ? "POST" : "GET", cache: "no-store" }),
}).getUsageDashboard();

export function OpenAiApiLive() {
  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async (refresh: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      setDashboard(await loadDashboard(refresh));
      setError(null);
    } catch {
      setError("无法连接本机 OpenAI 数据服务。");
      setDashboard(null);
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => { void load(false); }, [load]);
  const refresh = useCallback(() => { void load(true); }, [load]);
  useActiveRefresh(refresh, { intervalMs: 120_000, idleMs: 600_000 });

  return (
    <main className="app-shell">
      <div className="app-shell__inner">
        <header className="hero">
          <div className="hero__top">
            <div className="brand">
              <p className="kicker">ApiMonitor</p>
              <h1>OpenAI API 实际用量</h1>
              <p>组织费用和模型用量按每月 15 日 00:00 UTC 换期。</p>
            </div>
            <button className="btn btn--primary" type="button" onClick={refresh} disabled={loading}>
              {loading ? "正在读取…" : "刷新真实数据"}
            </button>
          </div>
          {loading && !dashboard && <p role="status">正在读取 OpenAI 组织用量…</p>}
          {error && <p role="alert">{error}</p>}
        </header>
        <section className="dashboard-grid" aria-label="OpenAI API 组织数据">
          {dashboard?.platforms.map((platform) => <PlatformCard key={platform.id} platform={platform} />)}
        </section>
      </div>
    </main>
  );
}
