import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../../frontend/src/api/client";
import { PlatformCard } from "../../frontend/src/components/platform-card";

vi.mock("../../frontend/src/components/usage-trend-chart", () => ({
  UsageTrendChart: () => null,
}));

type Metrics = Record<string, number | string>;

const capturedAt = "2026-10-26T00:00:00.000Z";
function makeCard(
  providerId: "opencode-go" | "commandcode",
  metrics: Metrics,
  resetAt: string | null = null,
) {
  return {
    providerId,
    providerName: providerId === "opencode-go" ? "OpenCode Go" : "Command Code",
    sourceUrl: `https://${providerId}.example.com/usage`,
    status: "ready",
    summary: "额度已同步",
    capturedAt,
    trend: [],
    windows: [{ key: "monthly", label: "Monthly", used: 25, limit: 100, resetAt }],
    metrics,
    meta: {},
  };
}

function makeAccount(accountId: string, accountLabel: string, metrics: Metrics) {
  return { ...makeCard("opencode-go", metrics), accountId, accountLabel };
}

function activity(model: string, totalRequests: number, totalTokens: number): Metrics {
  return {
    totalRequests,
    totalTokens,
    topModels: JSON.stringify([{ model, requests: totalRequests / 4, share: 0.25 }]),
  };
}

async function loadCard(card: ReturnType<typeof makeCard> & {
  selectedAccountId?: string;
  accounts?: ReturnType<typeof makeAccount>[];
}) {
  const fetcher = vi.fn(async () => Response.json({
    ok: true,
    data: {
      kind: "usage_dashboard",
      generatedAt: capturedAt,
      status: "ready",
      summary: "ready",
      totals: { providers: 1, ready: 1, partial: 0, loginRequired: 0, error: 0 },
      cards: [card],
      modelSpends: [],
    },
  }));
  const dashboard = await createApiClient({ fetcher }).getUsageDashboard();

  return dashboard.platforms[0]!;
}

describe("OpenCode Go Activity 前端", () => {
  it("映射周期汇总和模型的请求量与占比", async () => {
    const platform = await loadCard(makeCard("opencode-go", activity("deepseek-v4.1-flash", 1000, 84294090)));

    expect(platform.detailMetrics).toEqual(expect.arrayContaining([
      { label: "总请求数", value: "1,000" },
      { label: "总 Token", value: "84.29M" },
    ]));
    expect(platform.modelSpends).toMatchObject([
      { model: "deepseek-v4.1-flash", requests: 250, share: 0.25 },
    ]);
  });

  it("将真实零量映射为零并保留已有额度", async () => {
    const platform = await loadCard(makeCard("opencode-go", { totalRequests: 0, totalTokens: 0, topModels: "[]" }));

    expect(platform.detailMetrics).toEqual(expect.arrayContaining([
      { label: "总请求数", value: "0" },
      { label: "总 Token", value: "0" },
    ]));
    expect(platform.quotaWindows).toMatchObject([{ label: "Monthly", used: 25, limit: 100 }]);
  });

  it("为缺少 Activity 的历史快照保留额度并省略统计", async () => {
    const platform = await loadCard(makeCard("opencode-go", {}));

    expect(platform.quotaWindows).toMatchObject([{ label: "Monthly", used: 25, limit: 100 }]);
    expect(platform.detailMetrics.map(({ label }) => label)).not.toContain("总请求数");
    expect(platform.detailMetrics.map(({ label }) => label)).not.toContain("总 Token");
    expect(platform.modelSpends).toEqual([]);
  });

  it("月窗重置后省略旧 Activity 并保留额度", async () => {
    const card = makeCard(
      "opencode-go",
      activity("previous-cycle-model", 1000, 84294090),
      "2026-11-24T22:38:24+08:00",
    );
    try {
      vi.setSystemTime(new Date("2026-11-24T14:38:23Z"));
      const current = await loadCard(card);
      expect(current.modelSpends).toHaveLength(1);
      expect(current.detailMetrics.map(({ label }) => label)).toContain("总请求数");

      vi.setSystemTime(new Date("2026-11-24T14:38:25Z"));
      const expired = await loadCard(card);
      expect(expired.modelSpends).toEqual([]);
      expect(expired.detailMetrics.map(({ label }) => label)).not.toContain("总请求数");
      expect(expired.detailMetrics.map(({ label }) => label)).not.toContain("总 Token");
      expect(expired.quotaWindows).toMatchObject([{ label: "Monthly", used: 25, limit: 100 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("在 OpenCode 模型表显示请求占比并省略模型 Token 列", async () => {
    const platform = await loadCard(makeCard("opencode-go", activity("deepseek-v4.1-flash", 1000, 84294090)));
    render(<PlatformCard platform={platform} />);

    const table = within(screen.getByRole("table"));
    expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "模型", "请求数", "请求占比",
    ]);
    expect(table.getByRole("cell", { name: "25%" })).toBeTruthy();
  });

  it("初始显示预选账号的 Activity", async () => {
    const main = activity("model-main", 1000, 84294090);
    const platform = await loadCard({
      ...makeCard("opencode-go", main),
      selectedAccountId: "backup",
      accounts: [
        makeAccount("main", "主账号", main),
        makeAccount("backup", "备用账号", activity("model-backup", 120, 5000)),
      ],
    });
    render(<PlatformCard platform={platform} />);

    expect(screen.getByRole("cell", { name: "model-backup" })).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
    expect(screen.queryByRole("cell", { name: "model-main" })).toBeNull();
  });

  it("切换账号时显示所选账号的汇总和模型且无数据时清除上一账号用量", async () => {
    const main = activity("model-main", 1000, 84294090);
    const platform = await loadCard({
      ...makeCard("opencode-go", main),
      selectedAccountId: "main",
      accounts: [
        makeAccount("main", "主账号", main),
        makeAccount("backup", "备用账号", activity("model-backup", 120, 5000)),
        makeAccount("legacy", "历史账号", {}),
      ],
    });
    render(<PlatformCard platform={platform} />);

    expect(screen.getByRole("cell", { name: "model-main" })).toBeTruthy();
    expect(screen.getByText("1,000")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "切换到备用账号" }));
    expect(screen.getByRole("cell", { name: "model-backup" })).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
    expect(screen.queryByRole("cell", { name: "model-main" })).toBeNull();
    expect(screen.queryByText("1,000")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "切换到历史账号" }));
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("总请求数")).toBeNull();
  });

  it("继续显示 Command Code 的模型 Token 数和原占比列", async () => {
    const metrics = {
      totalTokens: 5000,
      totalRequests: 100,
      topModels: JSON.stringify([{ model: "cc-model", requests: 25, tokens: 2500, share: 0.5 }]),
    };
    const platform = await loadCard(makeCard("commandcode", metrics));
    render(<PlatformCard platform={platform} />);

    const table = within(screen.getByRole("table"));
    expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "模型", "请求数", "Token 数", "占比",
    ]);
    expect(table.getByRole("cell", { name: "2.5K" })).toBeTruthy();
    expect(table.getByRole("cell", { name: "50%" })).toBeTruthy();
  });
});
