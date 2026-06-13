import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardSnapshot } from "../../frontend/src/api/client";
import { SettingsPage } from "../../frontend/src/settings/settings-page";

describe("SettingsPage", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("shows public provider catalog and layered workbench before admin token is set", () => {
    const api = {
      getProviderSettings: vi.fn(),
      saveProviderPreferences: vi.fn(),
      saveProviderAccount: vi.fn(),
      testProviderAccount: vi.fn(),
      updateProviderAccountDisplay: vi.fn(),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    expect(screen.getByRole("heading", { name: "第三版：多层展开配置模型" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Level 1: 供应商" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Level 2: 当前供应商的账号" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Level 3: 账号配置" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑 OpenRouter" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑 OpenCode Go" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑 讯飞 MaaS" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑 阿里云百炼" })).toBeTruthy();
    expect(screen.getByText("需要 Admin Token 后才能读取账号和保存配置。")).toBeTruthy();
    expect(api.getProviderSettings).not.toHaveBeenCalled();
  });

  it("prefills configured accounts from the public dashboard snapshot before admin token is set", () => {
    const api = {
      getProviderSettings: vi.fn(),
      saveProviderPreferences: vi.fn(),
      saveProviderAccount: vi.fn(),
      testProviderAccount: vi.fn(),
      updateProviderAccountDisplay: vi.fn(),
    };
    const dashboard: DashboardSnapshot = {
      status: "ready",
      generatedAt: "2026-06-13T00:00:00.000Z",
      refreshedAt: "2026-06-13T00:00:00.000Z",
      platforms: [
        {
          id: "openrouter",
          name: "OpenRouter",
          tagline: "Activity",
          summary: "OpenRouter main account is loaded",
          status: "healthy",
          loginState: "connected",
          sourceUrl: "https://openrouter.ai/activity",
          sourceLabel: "activity",
          primaryMetricLabel: "spend",
          primaryMetricValue: "$1.20",
          lastRefreshedAt: "2026-06-13T00:00:00.000Z",
          accent: "#b45309",
          quotaWindows: [],
          trend: [],
          modelSpends: [],
          links: [],
          selectedAccountId: "openrouter-main",
          accounts: [
            {
              id: "openrouter-main",
              label: "OpenRouter 主账号",
              summary: "OpenRouter main account is loaded",
              status: "healthy",
              loginState: "connected",
              sourceUrl: "https://openrouter.ai/activity",
              sourceLabel: "activity",
              primaryMetricValue: "$1.20",
              lastRefreshedAt: "2026-06-13T00:00:00.000Z",
              quotaWindows: [],
              trend: [],
              links: [],
            },
          ],
        },
      ],
    };

    render(<SettingsPage api={api as never} dashboard={dashboard} onBack={() => undefined} />);

    expect(screen.getAllByText("OpenRouter 主账号")).toHaveLength(2);
    expect(screen.getAllByText("OpenRouter main account is loaded").length).toBeGreaterThanOrEqual(1);
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label*="OpenRouter"]')).some(
        (button) => button.disabled,
      ),
    ).toBe(true);
    expect(api.getProviderSettings).not.toHaveBeenCalled();
  });

  it("shows provider gallery, account layer, and homepage account controls", async () => {
    sessionStorage.setItem("api-monitor-admin-token", "admin-token");

    const api = {
      getProviderSettings: vi.fn(async () => ({
        catalog: [
          {
            providerKey: "openrouter",
            providerName: "OpenRouter",
            sourceUrl: "https://openrouter.ai/activity",
            description: "OpenRouter usage",
          },
          {
            providerKey: "aliyun-bailian",
            providerName: "阿里云百炼",
            sourceUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/coding-plan",
            description: "原网页入口",
          },
        ],
        preferences: [
          {
            providerKey: "openrouter",
            enabled: true,
            displayOrder: 1,
            activeProviderAccountId: "acc-main",
          },
          {
            providerKey: "aliyun-bailian",
            enabled: true,
            displayOrder: 2,
            activeProviderAccountId: null,
          },
        ],
        accounts: [
          {
            id: "acc-main",
            providerKey: "openrouter",
            accountLabel: "主账号",
            sourceUrl: "https://openrouter.ai/activity",
            status: "ready",
            statusMessage: null,
            credentialHint: { apiKey: "sk-or...abcd" },
            homepageEnabled: true,
            homepageOrder: 1,
            lastTestSummary: "OpenRouter usage snapshot loaded",
          },
        ],
      })),
      saveProviderPreferences: vi.fn(async () => undefined),
      saveProviderAccount: vi.fn(async () => ({ id: "acc-new" })),
      testProviderAccount: vi.fn(async () => ({ ok: true, status: "ready", summary: "OpenRouter usage snapshot loaded" })),
      updateProviderAccountDisplay: vi.fn(async () => ({ id: "acc-main", homepageEnabled: false, homepageOrder: 1 })),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    expect(await screen.findByRole("button", { name: "编辑 OpenRouter" })).toBeTruthy();
    expect(screen.getByText("已配置")).toBeTruthy();
    expect(screen.getByRole("button", { name: "停用首页显示：主账号" })).toBeTruthy();
    expect(screen.getByText("OpenRouter usage snapshot loaded")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "停用首页显示：主账号" }));
    await waitFor(() => expect(api.updateProviderAccountDisplay).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "编辑 阿里云百炼" }));
    expect(screen.getByText("原网页入口")).toBeTruthy();
    expect(screen.getByText("入口型")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(api.saveProviderPreferences).toHaveBeenCalledTimes(1));
    expect(api.saveProviderPreferences).toHaveBeenCalledWith(
      "admin-token",
      expect.arrayContaining([
        expect.objectContaining({ providerKey: "openrouter", enabled: true, displayOrder: 1 }),
      ]),
    );
  });

  it("reloads settings when saving the same admin token again", async () => {
    sessionStorage.setItem("api-monitor-admin-token", "admin-token");

    const api = {
      getProviderSettings: vi
        .fn()
        .mockRejectedValueOnce(new Error("请求失败 (500)"))
        .mockResolvedValueOnce({
          catalog: [
            {
              providerKey: "openrouter",
              providerName: "OpenRouter",
              sourceUrl: "https://openrouter.ai/activity",
              description: "OpenRouter usage",
            },
          ],
          preferences: [
            {
              providerKey: "openrouter",
              enabled: true,
              displayOrder: 1,
              activeProviderAccountId: null,
            },
          ],
          accounts: [],
        }),
      saveProviderPreferences: vi.fn(),
      saveProviderAccount: vi.fn(),
      testProviderAccount: vi.fn(),
      updateProviderAccountDisplay: vi.fn(),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    expect(await screen.findByText("请求失败 (500)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "保存 Token" }));

    await waitFor(() => expect(api.getProviderSettings).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("配置已同步。")).toBeTruthy();
  });

  it("moves homepage accounts up without drag and drop", async () => {
    sessionStorage.setItem("api-monitor-admin-token", "admin-token");

    const api = {
      getProviderSettings: vi.fn(async () => ({
        catalog: [
          {
            providerKey: "openrouter",
            providerName: "OpenRouter",
            sourceUrl: "https://openrouter.ai/activity",
            description: "OpenRouter usage",
          },
        ],
        preferences: [
          {
            providerKey: "openrouter",
            enabled: true,
            displayOrder: 1,
            activeProviderAccountId: "acc-main",
          },
        ],
        accounts: [
          {
            id: "acc-main",
            providerKey: "openrouter",
            accountLabel: "主账号",
            sourceUrl: "https://openrouter.ai/activity",
            status: "ready",
            statusMessage: null,
            credentialHint: { apiKey: "sk-or...main" },
            homepageEnabled: true,
            homepageOrder: 1,
            lastTestSummary: "主账号正常",
          },
          {
            id: "acc-backup",
            providerKey: "openrouter",
            accountLabel: "备用账号",
            sourceUrl: "https://openrouter.ai/activity",
            status: "ready",
            statusMessage: null,
            credentialHint: { apiKey: "sk-or...backup" },
            homepageEnabled: true,
            homepageOrder: 2,
            lastTestSummary: "备用账号正常",
          },
        ],
      })),
      saveProviderPreferences: vi.fn(),
      saveProviderAccount: vi.fn(),
      testProviderAccount: vi.fn(),
      updateProviderAccountDisplay: vi.fn(async (_token: string, accountId: string, input: { homepageEnabled: boolean; homepageOrder: number }) => ({
        id: accountId,
        homepageEnabled: input.homepageEnabled,
        homepageOrder: input.homepageOrder,
      })),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    expect(await screen.findByRole("button", { name: "上移首页显示：备用账号" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "上移首页显示：备用账号" }));

    await waitFor(() => expect(api.updateProviderAccountDisplay).toHaveBeenCalledTimes(2));
    expect(api.updateProviderAccountDisplay).toHaveBeenNthCalledWith(
      1,
      "admin-token",
      "acc-backup",
      { homepageEnabled: true, homepageOrder: 1 },
    );
    expect(api.updateProviderAccountDisplay).toHaveBeenNthCalledWith(
      2,
      "admin-token",
      "acc-main",
      { homepageEnabled: true, homepageOrder: 2 },
    );
  });

  it("refreshes the account layer after saving a provider account", async () => {
    sessionStorage.setItem("api-monitor-admin-token", "admin-token");

    const api = {
      getProviderSettings: vi
        .fn()
        .mockResolvedValueOnce({
          catalog: [
            {
              providerKey: "openrouter",
              providerName: "OpenRouter",
              sourceUrl: "https://openrouter.ai/activity",
              description: "OpenRouter usage",
            },
          ],
          preferences: [
            {
              providerKey: "openrouter",
              enabled: true,
              displayOrder: 1,
              activeProviderAccountId: null,
            },
          ],
          accounts: [],
        })
        .mockResolvedValueOnce({
          catalog: [
            {
              providerKey: "openrouter",
              providerName: "OpenRouter",
              sourceUrl: "https://openrouter.ai/activity",
              description: "OpenRouter usage",
            },
          ],
          preferences: [
            {
              providerKey: "openrouter",
              enabled: true,
              displayOrder: 1,
              activeProviderAccountId: "acc-new",
            },
          ],
          accounts: [
            {
              id: "acc-new",
              providerKey: "openrouter",
              accountLabel: "主账号",
              sourceUrl: "https://openrouter.ai/activity",
              status: "ready",
              statusMessage: null,
              credentialHint: { apiKey: "sk-or...new" },
              homepageEnabled: false,
              homepageOrder: 100,
              lastTestSummary: "未测试",
            },
          ],
        }),
      saveProviderPreferences: vi.fn(),
      saveProviderAccount: vi.fn(async () => ({ id: "acc-new" })),
      testProviderAccount: vi.fn(),
      updateProviderAccountDisplay: vi.fn(),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    expect(await screen.findByText("暂无账号")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("apiKey"), { target: { value: "sk-or-test" } });
    fireEvent.click(screen.getByRole("button", { name: "保存账号" }));

    await waitFor(() => expect(api.saveProviderAccount).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.getProviderSettings).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("账号已保存。")).toBeTruthy();
    expect(screen.getByText("apiKey: sk-or...new")).toBeTruthy();
  });
});
