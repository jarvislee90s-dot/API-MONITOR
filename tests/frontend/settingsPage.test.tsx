import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../../frontend/src/settings/settings-page";

describe("SettingsPage", () => {
  it("renders provider switches, account panel, and saves provider order", async () => {
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
            providerKey: "opencode-go",
            providerName: "OpenCode Go",
            sourceUrl: "https://opencode.ai/workspace/wrk_123/go",
            description: "OpenCode usage",
          },
        ],
        preferences: [
          {
            providerKey: "openrouter",
            enabled: true,
            displayOrder: 2,
            activeProviderAccountId: "acc-openrouter",
          },
          {
            providerKey: "opencode-go",
            enabled: true,
            displayOrder: 1,
            activeProviderAccountId: "acc-opencode",
          },
        ],
        accounts: [
          {
            id: "acc-opencode",
            providerKey: "opencode-go",
            accountLabel: "主账号",
            sourceUrl: "https://opencode.ai/workspace/wrk_123/go",
            status: "ready",
            statusMessage: null,
            credentialHint: { authCookie: "auth=...abcd" },
          },
        ],
      })),
      saveProviderPreferences: vi.fn(async () => undefined),
    };

    render(<SettingsPage api={api as never} onBack={() => undefined} />);

    expect(await screen.findAllByText("OpenCode Go")).toHaveLength(2);
    expect(screen.getByText("主账号")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(api.saveProviderPreferences).toHaveBeenCalledTimes(1));
    expect(api.saveProviderPreferences).toHaveBeenCalledWith(
      "admin-token",
      expect.arrayContaining([
        expect.objectContaining({ providerKey: "opencode-go", enabled: true, displayOrder: 1 }),
      ]),
    );
  });
});
