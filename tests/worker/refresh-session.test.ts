import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RefreshSessionDurableObject } from "../../worker/durable-object/refresh-session";

class MemoryStorage {
  private readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

function createState() {
  return {
    storage: new MemoryStorage(),
  };
}

describe("refresh session durable object", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows the first refresh after a touch and blocks the immediate retry", async () => {
    const object = new RefreshSessionDurableObject(createState(), {});

    const touchResponse = await object.fetch(
      new Request("https://refresh-session.local/touch?sessionKey=session-a", {
        method: "POST",
      }),
    );
    expect((await touchResponse.json()) as any).toMatchObject({
      ok: true,
      data: {
        session: {
          sessionKey: "session-a",
        },
      },
    });

    const firstDecision = await object.fetch(
      new Request("https://refresh-session.local/decide?sessionKey=session-a", {
        method: "POST",
        body: JSON.stringify({ sessionKey: "session-a" }),
      }),
    );
    const firstPayload = (await firstDecision.json()) as any;
    expect(firstPayload.ok).toBe(true);
    expect(firstPayload.data.allowed).toBe(true);
    expect(firstPayload.data.reason).toBe("allowed");

    const secondDecision = await object.fetch(
      new Request("https://refresh-session.local/decide?sessionKey=session-a", {
        method: "POST",
        body: JSON.stringify({ sessionKey: "session-a" }),
      }),
    );
    const secondPayload = (await secondDecision.json()) as any;
    expect(secondPayload.data.allowed).toBe(false);
    expect(secondPayload.data.reason).toBe("cooldown");
  });

  it("marks the session inactive after the active window expires", async () => {
    const object = new RefreshSessionDurableObject(createState(), {
      REFRESH_ACTIVE_WINDOW_MS: "600000",
    });

    await object.fetch(
      new Request("https://refresh-session.local/touch?sessionKey=session-b", {
        method: "POST",
      }),
    );

    vi.setSystemTime(new Date("2026-06-11T00:11:01.000Z"));

    const response = await object.fetch(
      new Request("https://refresh-session.local/decide?sessionKey=session-b", {
        method: "POST",
        body: JSON.stringify({ sessionKey: "session-b" }),
      }),
    );
    const payload = (await response.json()) as any;
    expect(payload.data.allowed).toBe(false);
    expect(payload.data.reason).toBe("inactive");
  });
});
