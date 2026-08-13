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

    expect(screen.getByRole("heading", { name: "模型供应商与账号配置" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Level 1: 供应商" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Level 2: OpenRouter 的账号" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Level 3: 账号配置" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑 OpenRouter" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑 OpenCode Go" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑 讯飞 MaaS" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑 阿里云百炼" })).toBeTruthy();
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
    expect(screen.getByRole("button", { name: "编辑账号：OpenRouter 主账号" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ 新增账号 新增后默认不进首页，测试通过后可启用。" })).toBeTruthy();
  });

  it("shows provider gallery, account layer, and homepage account controls", async () => {

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
      expect.arrayContaining([
        expect.objectContaining({ providerKey: "openrouter", enabled: true, displayOrder: 1 }),
      ]),
    );
  });

  it("does not render the removed admin token controls after a settings load failure", async () => {
    const api = {
      getProviderSettings: vi.fn().mockRejectedValueOnce(new Error("???? (500)")),
      saveProviderPreferences: vi.fn(),
      saveProviderAccount: vi.fn(),
      testProviderAccount: vi.fn(),
      updateProviderAccountDisplay: vi.fn(),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    expect(await screen.findByText("???? (500)")).toBeTruthy();
    expect(screen.queryByText("Admin Token")).toBeNull();
    expect(screen.queryByRole("button", { name: "?? Token" })).toBeNull();
  });

  it("reorders homepage accounts with HTML5 drag and drop", async () => {

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
      updateProviderAccountDisplay: vi.fn(async (accountId: string, input: { homepageEnabled: boolean; homepageOrder: number }) => ({
        id: accountId,
        homepageEnabled: input.homepageEnabled,
        homepageOrder: input.homepageOrder,
      })),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    expect(await screen.findByRole("button", { name: "编辑账号：备用账号" })).toBeTruthy();

    const draggedCard = screen.getByRole("button", { name: "编辑账号：备用账号" }).closest("article");
    const targetCard = screen.getByRole("button", { name: "编辑账号：主账号" }).closest("article");
    const data = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
    };

    expect(draggedCard?.getAttribute("draggable")).toBe("true");
    expect(targetCard?.getAttribute("draggable")).toBe("true");

    fireEvent.dragStart(draggedCard!, { dataTransfer });
    fireEvent.dragOver(targetCard!, { dataTransfer });
    expect(targetCard?.className).toContain("account-display-card--drop-target");
    fireEvent.drop(targetCard!, { dataTransfer });

    await waitFor(() => expect(api.updateProviderAccountDisplay).toHaveBeenCalledTimes(2));
    expect(api.updateProviderAccountDisplay).toHaveBeenNthCalledWith(
      1,
      "acc-backup",
      { homepageEnabled: true, homepageOrder: 100 },
    );
    expect(api.updateProviderAccountDisplay).toHaveBeenNthCalledWith(
      2,
      "acc-main",
      { homepageEnabled: true, homepageOrder: 200 },
    );
  });

  it("refreshes the account layer after saving a provider account", async () => {

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

  it("surfaces an error message when saving a new provider account fails", async () => {
    const api = {
      getProviderSettings: vi.fn().mockResolvedValue({
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
      saveProviderAccount: vi.fn().mockRejectedValue(new Error("Failed to upsert provider account: 500")),
      updateProviderAccount: vi.fn(),
      deleteProviderAccount: vi.fn(),
      testProviderAccount: vi.fn(),
      updateProviderAccountDisplay: vi.fn(),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    fireEvent.change(await screen.findByLabelText("apiKey"), { target: { value: "sk-or-test" } });
    fireEvent.click(screen.getByRole("button", { name: "保存账号" }));

    await waitFor(() =>
      expect(screen.getByText("Failed to upsert provider account: 500")).toBeTruthy(),
    );
    // 失败时不要误把"账号已保存"显示出来误导用户
    expect(screen.queryByText("账号已保存。")).toBeNull();
  });

  it("renders account status badges in the homepage account list", async () => {
    const readyAccount = {
      id: "acc-ready",
      providerKey: "openrouter",
      accountLabel: "主账号",
      sourceUrl: "https://openrouter.ai/activity",
      status: "ready",
      statusMessage: null,
      credentialHint: {},
      homepageEnabled: true,
      homepageOrder: 1,
      lastTestSummary: null,
    };
    const loginRequiredAccount = {
      id: "acc-login",
      providerKey: "openrouter",
      accountLabel: "备用账号",
      sourceUrl: "https://openrouter.ai/activity",
      status: "login_required",
      statusMessage: null,
      credentialHint: {},
      homepageEnabled: true,
      homepageOrder: 2,
      lastTestSummary: null,
    };

    const api = {
      getProviderSettings: vi.fn().mockResolvedValue({
        catalog: [{ providerKey: "openrouter", providerName: "OpenRouter", sourceUrl: "https://openrouter.ai/activity", description: "test" }],
        preferences: [{ providerKey: "openrouter", enabled: true, displayOrder: 1, activeProviderAccountId: null }],
        accounts: [readyAccount, loginRequiredAccount],
      }),
      saveProviderPreferences: vi.fn(),
      saveProviderAccount: vi.fn(),
      testProviderAccount: vi.fn(),
      updateProviderAccountDisplay: vi.fn(),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    await waitFor(() => {
      expect(screen.getAllByText("已连接").length).toBeGreaterThanOrEqual(1);
    });
    await waitFor(() => {
      expect(screen.getAllByText("需要登录").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows '+ 新增账号' button when admin token is set", async () => {
    const api = {
      getProviderSettings: vi.fn().mockResolvedValue({
        catalog: [{ providerKey: "openrouter", providerName: "OpenRouter", sourceUrl: "https://openrouter.ai/activity", description: "test" }],
        preferences: [],
        accounts: [],
      }),
      saveProviderPreferences: vi.fn(),
      saveProviderAccount: vi.fn(),
      testProviderAccount: vi.fn(),
      updateProviderAccountDisplay: vi.fn(),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByText("+ 新增账号")).toBeTruthy();
    });
  });

  it("renders the reference layered settings layout with account cards and a grid credential form", async () => {

    const api = {
      getProviderSettings: vi.fn().mockResolvedValue({
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
            credentialHint: { apiKey: "sk-or...9a2f" },
            homepageEnabled: true,
            homepageOrder: 1,
            lastTestSummary: "本周期花费",
          },
          {
            id: "acc-backup",
            providerKey: "openrouter",
            accountLabel: "备用账号",
            sourceUrl: "https://openrouter.ai/activity",
            status: "disabled",
            statusMessage: null,
            credentialHint: { apiKey: "sk-or...88bb" },
            homepageEnabled: false,
            homepageOrder: 100,
            lastTestSummary: "未启用",
          },
        ],
      }),
      saveProviderPreferences: vi.fn(),
      saveProviderAccount: vi.fn(),
      testProviderAccount: vi.fn(),
      updateProviderAccountDisplay: vi.fn(),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    expect(await screen.findByRole("heading", { name: "Level 2: OpenRouter 的账号" })).toBeTruthy();
    expect(document.querySelector(".account-display-card.account-display-card--active")).toBeTruthy();
    expect(document.querySelector(".account-display-card.account-display-card--disabled")).toBeTruthy();
    expect(screen.getByText("API Key: sk-or...9a2f")).toBeTruthy();
    expect(screen.getByText("新增后默认不进首页，测试通过后可启用。")).toBeTruthy();
    expect(document.querySelector(".credential-form.credential-form--grid")).toBeTruthy();
    expect(screen.getByText("保存后表单清空；账号卡只展示 credentialHint，网页登录态不保存。")).toBeTruthy();
  });

  it("opens an existing configured account in the editor when clicking its Level 2 card", async () => {

    const api = {
      getProviderSettings: vi.fn().mockResolvedValue({
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
            credentialHint: { apiKey: "sk-or...9a2f" },
            homepageEnabled: true,
            homepageOrder: 1,
            lastTestSummary: "本周期花费",
          },
        ],
      }),
      saveProviderPreferences: vi.fn(),
      saveProviderAccount: vi.fn(),
      testProviderAccount: vi.fn(),
      updateProviderAccountDisplay: vi.fn(),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "编辑账号：主账号" }));

    expect(screen.getByDisplayValue("主账号")).toBeTruthy();
    expect(screen.getByDisplayValue("https://openrouter.ai/activity")).toBeTruthy();
    expect(screen.getByText("正在编辑：主账号")).toBeTruthy();
  });

  it("switches from editing an existing account to add-account mode", async () => {
    const api = {
      getProviderSettings: vi.fn().mockResolvedValue({
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
            credentialHint: { apiKey: "sk-or...9a2f" },
            homepageEnabled: true,
            homepageOrder: 1,
            lastTestSummary: "本周期花费",
          },
        ],
      }),
      saveProviderPreferences: vi.fn(),
      saveProviderAccount: vi.fn(),
      testProviderAccount: vi.fn(),
      updateProviderAccountDisplay: vi.fn(),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "编辑账号：主账号" }));
    expect(screen.getByText("正在编辑：主账号")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "+ 新增账号 新增后默认不进首页，测试通过后可启用。" }));

    await waitFor(() => {
      expect(screen.queryByText("正在编辑：主账号")).toBeNull();
    });
    expect(screen.getByDisplayValue("新账号")).toBeTruthy();
  });

  it("keeps add account actionable without admin token and explains the required token", () => {
    const api = {
      getProviderSettings: vi.fn(),
      saveProviderPreferences: vi.fn(),
      saveProviderAccount: vi.fn(),
      testProviderAccount: vi.fn(),
      updateProviderAccountDisplay: vi.fn(),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    const addButton = screen.getByRole("button", { name: "+ 新增账号 新增后默认不进首页，测试通过后可启用。" });
    expect((addButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(addButton);

  });

  it("saves edits to an existing account instead of creating a replacement account", async () => {
    const api = {
      getProviderSettings: vi.fn().mockResolvedValue({
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
            credentialHint: { apiKey: "sk-or...9a2f" },
            homepageEnabled: true,
            homepageOrder: 1,
            lastTestSummary: "本周期花费",
          },
        ],
      }),
      saveProviderPreferences: vi.fn(),
      saveProviderAccount: vi.fn(),
      updateProviderAccount: vi.fn(async () => ({ id: "acc-main" })),
      deleteProviderAccount: vi.fn(),
      testProviderAccount: vi.fn(),
      updateProviderAccountDisplay: vi.fn(),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "编辑账号：主账号" }));
    fireEvent.change(screen.getByDisplayValue("主账号"), { target: { value: "主账号-改名" } });
    fireEvent.click(screen.getByRole("button", { name: "保存账号" }));

    await waitFor(() => expect(api.updateProviderAccount).toHaveBeenCalledTimes(1));
    expect(api.updateProviderAccount).toHaveBeenCalledWith(
      "acc-main",
      expect.objectContaining({ accountLabel: "主账号-改名" }),
    );
    expect(api.saveProviderAccount).not.toHaveBeenCalled();
  });

  it("deletes an existing account and removes it from the account layer", async () => {
    const api = {
      getProviderSettings: vi.fn().mockResolvedValue({
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
            credentialHint: { apiKey: "sk-or...9a2f" },
            homepageEnabled: true,
            homepageOrder: 1,
            lastTestSummary: "本周期花费",
          },
        ],
      }),
      saveProviderPreferences: vi.fn(),
      saveProviderAccount: vi.fn(),
      updateProviderAccount: vi.fn(),
      deleteProviderAccount: vi.fn(async () => ({ id: "acc-main" })),
      testProviderAccount: vi.fn(),
      updateProviderAccountDisplay: vi.fn(),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    expect(await screen.findByRole("button", { name: "删除账号：主账号" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除账号：主账号" }));

    await waitFor(() => expect(api.deleteProviderAccount).toHaveBeenCalledWith("acc-main"));
    await waitFor(() => expect(screen.queryByText("主账号")).toBeNull());
  });

  it("reorders provider cards vertically and saves the same provider order", async () => {
    const api = {
      getProviderSettings: vi.fn().mockResolvedValue({
        catalog: [
          {
            providerKey: "openrouter",
            providerName: "OpenRouter",
            sourceUrl: "https://openrouter.ai/activity",
            description: "OpenRouter usage",
          },
          {
            providerKey: "opencode-go",
            providerName: "OpenCode Go",
            sourceUrl: "https://opencode.ai/workspace/wrk/go",
            description: "OpenCode usage",
          },
        ],
        preferences: [
          {
            providerKey: "openrouter",
            enabled: true,
            displayOrder: 1,
            activeProviderAccountId: "acc-router",
          },
          {
            providerKey: "opencode-go",
            enabled: true,
            displayOrder: 2,
            activeProviderAccountId: "acc-code",
          },
        ],
        accounts: [],
      }),
      saveProviderPreferences: vi.fn(async () => undefined),
      saveProviderAccount: vi.fn(),
      updateProviderAccount: vi.fn(),
      deleteProviderAccount: vi.fn(),
      testProviderAccount: vi.fn(),
      updateProviderAccountDisplay: vi.fn(),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    const draggedCard = await screen.findByRole("button", { name: "编辑 OpenCode Go" });
    const targetCard = screen.getByRole("button", { name: "编辑 OpenRouter" });
    const data = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
    };

    fireEvent.dragStart(draggedCard, { dataTransfer });
    fireEvent.dragOver(targetCard, { dataTransfer });
    fireEvent.drop(targetCard, { dataTransfer });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => expect(api.saveProviderPreferences).toHaveBeenCalledTimes(1));
    expect(api.saveProviderPreferences).toHaveBeenCalledWith([
      expect.objectContaining({ providerKey: "opencode-go", displayOrder: 1 }),
      expect.objectContaining({ providerKey: "openrouter", displayOrder: 2 }),
    ]);
  });
});
