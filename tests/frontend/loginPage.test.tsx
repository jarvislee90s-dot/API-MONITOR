import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoginPage } from "../../frontend/src/auth/login-page";

describe("LoginPage", () => {
  it("submits email and password", async () => {
    const onSignIn = vi.fn(async () => undefined);

    render(<LoginPage onSignIn={onSignIn} loading={false} error={null} />);

    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "me@example.com" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "secret-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => {
      expect(onSignIn).toHaveBeenCalledWith("me@example.com", "secret-password");
    });
  });

  it("shows login errors", () => {
    render(<LoginPage onSignIn={vi.fn()} loading={false} error="邮箱或密码不正确" />);

    expect(screen.getByText("邮箱或密码不正确")).toBeTruthy();
  });
});
