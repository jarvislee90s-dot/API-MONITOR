// 本地 DEV 预览：虚构 UsageDashboard 响应，经真实 createApiClient 映射后渲染真实卡片。
// 无外部请求，也不读取 .env；仅在 main.tsx 的 import.meta.env.DEV + preview 参数门控下加载。
import { useEffect, useState } from "react";
import {
  createApiClient,
  OPENAI_API_PROVIDER_ID,
  OPENAI_API_PROVIDER_NAME,
  type DashboardSnapshot,
} from "../api/client";
import { DashboardShell } from "../components";

const SOURCE_URL = "https://platform.openai.com/settings/organization/analytics/overview";
const GENERATED_AT = "2026-11-21T08:30:00.000Z";
const PERIOD = { start: "2026-11-15T00:00:00.000Z", end: "2026-12-15T00:00:00.000Z" };

type Scenario = "success" | "empty" | "over" | "stale" | "unavailable";

const SCENARIOS: Array<{ id: Scenario; label: string }> = [
  { id: "success", label: "正常（非零示例）" },
  { id: "empty", label: "成功空结果" },
  { id: "over", label: "超支" },
  { id: "stale", label: "单区过期（用量失败）" },
  { id: "unavailable", label: "单区不可用（费用失败）" },
];

// 构造虚构服务端卡片：金额、Token 均为明显虚构的非零值，避免与真实账单混淆
function buildCard(scenario: Scenario): Record<string, unknown> {
  const costsValue = scenario === "empty" ? 0 : scenario === "over" ? 128.4 : 37.5;
  const usageValue =
    scenario === "empty"
      ? { requests: 0, inputTokens: 0, outputTokens: 0, topModels: [] }
      : {
          requests: 1234,
          inputTokens: 890000,
          outputTokens: 110000,
          topModels: [
            { model: "gpt-5（示例）", requests: 800, tokens: 600000, share: 0.6 },
            { model: "gpt-4o（示例）", requests: 300, tokens: 250000, share: 0.25 },
            { model: "o3（示例）", requests: 100, tokens: 90000, share: 0.09 },
            { model: "gpt-4.1-mini（示例）", requests: 28, tokens: 50000, share: 0.05 },
            { model: "o4-mini（示例）", requests: 6, tokens: 10000, share: 0.01 },
          ],
        };

  const costs: Record<string, unknown> = {
    status: "ready",
    value: costsValue,
    updatedAt: GENERATED_AT,
  };
  const usage: Record<string, unknown> = {
    status: "ready",
    value: usageValue,
    updatedAt: GENERATED_AT,
  };

  if (scenario === "stale") {
    // 用量刷新失败，仍保留本周期上一次成功值
    usage.status = "stale";
    usage.error = "timeout";
    usage.updatedAt = "2026-11-21T06:00:00.000Z";
  }
  if (scenario === "unavailable") {
    // 费用无同周期成功值 → 独立空态
    costs.status = "unavailable";
    costs.value = null;
    costs.updatedAt = null;
    costs.error = "not_configured";
  }

  return {
    providerId: OPENAI_API_PROVIDER_ID,
    providerName: OPENAI_API_PROVIDER_NAME,
    sourceUrl: SOURCE_URL,
    status: "ready",
    summary: "OpenAI API 组织用量已同步（本地示例数据）",
    capturedAt: GENERATED_AT,
    trend: [],
    windows: [],
    metrics: {},
    meta: { openaiApi: { period: PERIOD, costs, usage } },
    selectedAccountId: null,
    accounts: [],
  };
}

// 虚构响应走真实 createApiClient 映射链
async function loadPreviewDashboard(scenario: Scenario): Promise<DashboardSnapshot> {
  const fetcher = async () =>
    Response.json({
      ok: true,
      data: {
        kind: "usage_dashboard",
        generatedAt: GENERATED_AT,
        status: "ready",
        summary: "ready",
        totals: { providers: 1, ready: 1, partial: 0, loginRequired: 0, error: 0 },
        cards: [buildCard(scenario)],
        modelSpends: [],
      },
    });
  return createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
}

export function OpenAiApiPreview() {
  const [scenario, setScenario] = useState<Scenario>("success");
  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null);

  // scenario 变化时重新走真实映射链
  useEffect(() => {
    let active = true;
    void loadPreviewDashboard(scenario).then((snapshot) => {
      if (active) setDashboard(snapshot);
    });
    return () => {
      active = false;
    };
  }, [scenario]);

  const notice = "本地 DEV 预览";

  return (
    <div>
      <div className="preview-switcher" aria-label="预览状态切换">
        {SCENARIOS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`account-chip ${scenario === item.id ? "is-selected" : ""}`}
            onClick={() => setScenario(item.id)}
          >
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      {dashboard ? (
        <DashboardShell
          dashboard={dashboard}
          isActive={false}
          isRefreshing={false}
          syncState="ready"
          syncMessage={null}
          onRefresh={() => undefined}
          previewNotice={notice}
        />
      ) : (
        <main className="app-shell">正在加载本地示例数据...</main>
      )}
    </div>
  );
}
