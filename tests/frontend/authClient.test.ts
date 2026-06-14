import { describe, expect, it, vi } from "vitest";
import { createBrowserAuthClient } from "../../frontend/src/auth/auth-client";

describe("browser auth client", () => {
  it("loads a session and returns its access token", async () => {
    const unsubscribe = vi.fn();
    const supabase = {
      auth: {
        getSession: vi.fn(async () => ({
          data: {
            session: {
              access_token: "access-token",
              user: { id: "user-1", email: "me@example.com" },
            },
          },
          error: null,
        })),
        onAuthStateChange: vi.fn(() => ({
          data: { subscription: { unsubscribe } },
        })),
        signInWithPassword: vi.fn(),
        signOut: vi.fn(),
      },
    };

    const auth = createBrowserAuthClient(supabase as never);

    await expect(auth.getSession()).resolves.toEqual({
      accessToken: "access-token",
      user: { id: "user-1", email: "me@example.com" },
    });
    await expect(auth.getAccessToken()).resolves.toBe("access-token");
  });

  it("signs in and normalizes the Supabase session", async () => {
    const supabase = {
      auth: {
        getSession: vi.fn(),
        onAuthStateChange: vi.fn(),
        signInWithPassword: vi.fn(async () => ({
          data: {
            session: {
              access_token: "new-access-token",
              user: { id: "user-2", email: null },
            },
          },
          error: null,
        })),
        signOut: vi.fn(),
      },
    };

    const auth = createBrowserAuthClient(supabase as never);

    await expect(auth.signIn("me@example.com", "secret")).resolves.toEqual({
      accessToken: "new-access-token",
      user: { id: "user-2", email: null },
    });
    expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: "me@example.com",
      password: "secret",
    });
  });
});
