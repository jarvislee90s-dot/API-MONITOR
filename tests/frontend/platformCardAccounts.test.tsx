import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PlatformCard } from "../../frontend/src/components/platform-card";
import type { PlatformSnapshot } from "../../frontend/src/api/client";

function createPlatform(): PlatformSnapshot {
  return {
    id: "openrouter",
    name: "OpenRouter",
    tagline: "Activity 聚合 / 花费拆分",
    summary: "主账号 loaded",
    status: "healthy",
    loginState: "已连接",
    sourceUrl: "https://openrouter.ai/activity",
    sourceLabel: "activity",
    primaryMetricLabel: "本周期花费",
    primaryMetricValue: "10 / 100",
    lastRefreshedAt: "2026-06-12T00:00:00.000Z",
    accent: "#b45309",
    quotaWindows: [{ label: "Monthly", scope: "Monthly", used: 10, limit: 100, resetAt: "6月12日 08:00", status: "healthy" }],
    trend: [{ label: "Monthly", usage: 10, spendUsd: 0 }],
    modelSpends: [],
    links: [{ label: "打开看板", href: "https://openrouter.ai/activity", tone: "brand" }],
    selectedAccountId: "acc-main",
    accounts: [
      {
        id: "acc-main",
        label: "主账号",
        summary: "主账号 loaded",
        status: "healthy",
        loginState: "已连接",
        sourceUrl: "https://openrouter.ai/activity",
        sourceLabel: "activity",
        primaryMetricValue: "10 / 100",
        lastRefreshedAt: "2026-06-12T00:00:00.000Z",
        quotaWindows: [{ label: "Monthly", scope: "Monthly", used: 10, limit: 100, resetAt: "6月12日 08:00", status: "healthy" }],
        trend: [{ label: "Monthly", usage: 10, spendUsd: 0 }],
        links: [{ label: "打开看板", href: "https://openrouter.ai/activity", tone: "brand" }],
      },
      {
        id: "acc-backup",
        label: "备用账号",
        summary: "备用账号 loaded",
        status: "partial",
        loginState: "部分可用",
        sourceUrl: "https://openrouter.ai/activity",
        sourceLabel: "activity",
        primaryMetricValue: "20 / 100",
        lastRefreshedAt: "2026-06-12T00:00:00.000Z",
        quotaWindows: [{ label: "Monthly", scope: "Monthly", used: 20, limit: 100, resetAt: "6月12日 08:00", status: "partial" }],
        trend: [{ label: "Monthly", usage: 20, spendUsd: 0 }],
        links: [{ label: "打开看板", href: "https://openrouter.ai/activity", tone: "brand" }],
      },
    ],
  };
}

describe("PlatformCard account switching", () => {
  it("switches the provider card body between account snapshots", () => {
    render(<PlatformCard platform={createPlatform()} />);

    expect(screen.getByText("主账号 loaded")).toBeTruthy();
    expect(screen.getByText("10 / 100")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "切换到备用账号" }));

    expect(screen.getByText("备用账号 loaded")).toBeTruthy();
    expect(screen.getByText("20 / 100")).toBeTruthy();
  });
});
