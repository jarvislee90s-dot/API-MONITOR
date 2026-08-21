import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CredentialForm } from "../../frontend/src/settings/credential-form";

describe("CredentialForm", () => {
  it("only submits credential fields for the currently selected provider", async () => {
    const onSave = vi.fn(async () => undefined);
    const { rerender } = render(
      <CredentialForm
        provider={{
          providerKey: "openrouter",
          providerName: "OpenRouter",
          sourceUrl: "https://openrouter.ai/activity",
          description: "OpenRouter usage",
        }}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByLabelText("apiKey"), { target: { value: "sk-hidden" } });

    rerender(
      <CredentialForm
        provider={{
          providerKey: "opencode-go",
          providerName: "OpenCode Go",
          sourceUrl: "https://opencode.ai/workspace/wrk_123/go",
          description: "OpenCode usage",
        }}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByLabelText("workspaceId"), { target: { value: "wrk_123" } });
    fireEvent.change(screen.getByLabelText("authCookie"), { target: { value: "auth=abc" } });
    fireEvent.click(screen.getByRole("button", { name: "保存账号" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          providerKey: "opencode-go",
          sourceUrl: "https://opencode.ai/workspace/wrk_123/go",
          credentials: {
            workspaceId: "wrk_123",
            authCookie: "auth=abc",
          },
        }),
      ),
    );
    const savedAccount = onSave.mock.calls.at(0)?.at(0);
    expect(JSON.stringify(savedAccount)).not.toContain("sk-hidden");
  });

  it("shows authCookie and authToken fields for the zhipu provider", async () => {
    const onSave = vi.fn(async () => undefined);
    render(
      <CredentialForm
        provider={{
          providerKey: "zhipu",
          providerName: "智谱 BigModel",
          sourceUrl: "https://bigmodel.cn/coding-plan/personal/usage",
          description: "Coding Plan 用量 / 5小时周配额",
        }}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByLabelText("authCookie"), { target: { value: "bigmodel_token_production=abc" } });
    fireEvent.change(screen.getByLabelText("登录 Token"), { target: { value: "token-abc" } });
    fireEvent.click(screen.getByRole("button", { name: "保存账号" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          providerKey: "zhipu",
          credentials: {
            authCookie: "bigmodel_token_production=abc",
            authToken: "token-abc",
          },
        }),
      ),
    );
  });
});
