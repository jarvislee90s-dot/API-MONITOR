import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../../frontend/src/api/client";
import { PlatformCard } from "../../frontend/src/components/platform-card";

const OURCE_URL = "https://platform.openai.com/settings/organization/analytics/overview";
const GENERATED_AT = "2026-11-20T08:30:00.000Z";

function openAiCardFixture() {
  return {
    providerId: "openai-api",
    providerName: "OpenAI API",
    sourceUrl: OURCE_URL,
    status: "ready",
    summary: "OpenAI API 组织用量已同步",
    capturedAt: GENERATED_AT,
    trend: [],
    windows: [],
    metrics: {},
    meta: {
      openaiApi: {
        period: { start: "2026-11-15T00:00:00.000Z", end: "2026-12-15T00:00:00.000Z" },
        costs: {
          status: "ready",
          value: 37.5,
          updatedAt: GENERATED_AT,
        },
        usage: {
          status: "ready",
          value: {
            requests: 1234,
            inputTokens: 890000,
            outputTokens: 110000,
            topModels: [
              { model: "gpt-5", requests: 800, tokens: 600000, share: 0.6 },
              { model: "gpt-4o", requests: 300, tokens: 250000, share: 0.25 },
              { model: "o3", requests: 100, tokens: 90000, share: 0.09 },
            ],
          },
          updatedAt: GENERATED_AT,
        },
      },
    },
    selectedAccountId: null,
    accounts: [],
  };
}

function dashboardResponse(card: Record<string, unknown>) {
  return Response.json({
    ok: true,
    data: {
      kind: "usage_dashboard",
      generatedAt: GENERATED_AT,
      status: "ready",
      summary: "ready",
      totals: { providers: 1, ready: 1, partial: 0, loginRequired: 0, error: 0 },
      cards: [card],
      modelSpends: [],
    },
  });
}

async function renderOpenAiCard() {
  const fetcher = vi.fn(async () => dashboardResponse(openAiCardFixture()));
  const dashboard = await createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
  render(<PlatformCard platform={dashboard.platforms[0]!} />);
}

describe("OpenAI API 卡片通过真实入口映射与渲染", () => {
  it("createApiClient 将 meta.openaiApi 映射为卡片字段且费用不混入首页 modelSpends", async () => {
    const fetcher = vi.fn(async () => dashboardResponse(openAiCardFixture()));
    const dashboard = await createApiClient({ fetcher: fetcher as unknown as typeof fetch }).getUsageDashboard();
    const platform = dashboard.platforms[0]!;

    expect(platform.id).toBe("openai-api");
    expect(platform.name).toBe("OpenAI API");
    expect(platform.links).toEqual([
      { label: "打开原网页", href: OURCE_URL, tone: "brand" },
    ]);
    // 组织金额只进入卡片额度区，不进入全局 modelSpends
    expect(platform.modelSpends).toEqual([]);
    expect(dashboard.platforms).toHaveLength(1);
    // 通过真实映射拿到结构化条款，供卡片按 USD/UTC 规则渲染
    expect((platform as any).openaiApi).toMatchObject({
      period: { start: "2026-11-15T00:00:00.000Z", end: "2026-12-15T00:00:00.000Z" },
      costs: { value: 37.5 },
      usage: { value: { requests: 1234, inputTokens: 890000, outputTokens: 110000 } },
    });
  });

  it("PlatformCard 渲染 USD 额度、UTC 周期、组织请求数、Top 模型表和原网页按钮", async () => {
    await renderOpenAiCard();

    expect(screen.getByText("OpenAI API")).toBeTruthy();
    expect(screen.getByText(/US\$37\.50/)).toBeTruthy();
    expect(screen.getByText(/US\$62\.50/)).toBeTruthy();
    expect(screen.getByText(/额度周期（UTC）/)).toBeTruthy();
    expect(screen.getByText("2026-11-15")).toBeTruthy();
    expect(screen.getByText("2026-12-15")).toBeTruthy();
    expect(screen.getByText("1,234")).toBeTruthy();
    expect(screen.getByText("gpt-5")).toBeTruthy();
    expect(screen.getByText("Token 占比")).toBeTruthy();
    expect(screen.getByRole("link", { name: "打开原网页" }).getAttribute("href")).toBe(OURCE_URL);
  });

  it("PlatformCard 只显示一处统计截至文案", async () => {
    await renderOpenAiCard();

    expect(screen.getAllByText(/统计截至/)).toHaveLength(1);
  });

  it("PlatformCard 用两个 time 元素各显示一次北京时间和 UTC", async () => {
    await renderOpenAiCard();

    const timestamps = screen.queryAllByRole("time").map((time) => time.textContent?.trim());
    expect(timestamps).toEqual([
      "北京时间 2026-11-20 16:30",
      "UTC 2026-11-20 08:30",
    ]);
  });

  it("PlatformCard 以 1.00M 显示文本模型 Token 总数", async () => {
    await renderOpenAiCard();

    expect(screen.queryByText("1.00M")).toBeTruthy();
  });
});
