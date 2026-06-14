import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../frontend/src/App";

const getAuthConfig = vi.fn();
const getUsageDashboard = vi.fn();
const refreshUsage = vi.fn();
const getSession = vi.fn();
const onSessionChange = vi.fn();
const signIn = vi.fn();
const signOut = vi.fn();

vi.mock("../../frontend/src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../frontend/src/api/client")>();
  return {
    ...actual,
    createApiClient: vi.fn(() => ({
      getAuthConfig,
      getUsageDashboard,
      refreshUsage,
    })),
  };
});

vi.mock("../../frontend/src/auth/auth-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../frontend/src/auth/auth-client")>();
  return {
    ...actual,
    createSupabaseBrowserAuthClient: vi.fn(() => ({
      getSession,
      onSessionChange,
      signIn,
      signOut,
    })),
  };
});

describe("App auth gate", () => {
  beforeEach(() => {
    getAuthConfig.mockResolvedValue({
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon-public-key",
    });
    getUsageDashboard.mockResolvedValue({
      status: "ready",
      generatedAt: "2026-06-14T00:00:00.000Z",
      refreshedAt: "2026-06-14T00:00:00.000Z",
      platforms: [],
    });
    refreshUsage.mockResolvedValue(undefined);
    getSession.mockResolvedValue(null);
    onSessionChange.mockReturnValue(() => undefined);
    signIn.mockResolvedValue(null);
    signOut.mockResolvedValue(undefined);
    window.location.hash = "";
    vi.clearAllMocks();
  });

  it("shows the login page and does not load dashboard data when signed out", async () => {
    render(<App />);

    await screen.findByRole("heading", { name: "登录后访问用量看板" });

    expect(getAuthConfig).toHaveBeenCalledTimes(1);
    expect(getUsageDashboard).not.toHaveBeenCalled();
    expect(refreshUsage).not.toHaveBeenCalled();
  });

  it("loads dashboard data after restoring a session", async () => {
    getSession.mockResolvedValue({
      accessToken: "access-token",
      user: { id: "user-1", email: "me@example.com" },
    });

    render(<App />);

    await waitFor(() => {
      expect(refreshUsage).toHaveBeenCalledTimes(1);
    });
    expect(getUsageDashboard).toHaveBeenCalledTimes(1);
  });
});
