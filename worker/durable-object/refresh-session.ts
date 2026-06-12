import type {
  DurableObjectStateLike,
  RefreshDecision,
  RefreshSessionEnv,
  RefreshSessionRequest,
  RefreshSessionResponse,
  RefreshSessionState,
  RefreshTouchResult,
} from "../types";
import { errorResponse, jsonResponse, readJsonBody, toIsoString } from "../http";

type SessionRecord = RefreshSessionState;

function parseDuration(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createInitialSession(sessionKey: string): SessionRecord {
  return {
    sessionKey,
    lastTouchAt: null,
    lastRefreshAt: null,
    refreshCount: 0,
    activeUntil: null,
  };
}

function loadState(now: Date, sessionKey: string, raw?: SessionRecord): SessionRecord {
  if (!raw) {
    return createInitialSession(sessionKey);
  }
  return {
    ...raw,
    sessionKey,
    activeUntil: raw.activeUntil ?? toIsoString(new Date(now.getTime() + 10 * 60 * 1000)),
  };
}

export class RefreshSessionDurableObject {
  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly env: RefreshSessionEnv,
  ) {}

  private async readSession(sessionKey: string, now: Date): Promise<SessionRecord> {
    const stored = await this.state.storage.get<SessionRecord>("session");
    return loadState(now, sessionKey, stored);
  }

  private async writeSession(session: SessionRecord): Promise<void> {
    await this.state.storage.put("session", session);
  }

  private getCooldownMs(): number {
    return parseDuration(this.env.REFRESH_COOLDOWN_MS, 2 * 60 * 1000);
  }

  private getActiveWindowMs(): number {
    return parseDuration(this.env.REFRESH_ACTIVE_WINDOW_MS, 10 * 60 * 1000);
  }

  private computeDecision(session: SessionRecord, now: Date): RefreshDecision {
    const nowMs = now.getTime();
    const lastTouchMs = session.lastTouchAt ? new Date(session.lastTouchAt).getTime() : null;
    const lastRefreshMs = session.lastRefreshAt ? new Date(session.lastRefreshAt).getTime() : null;
    const activeUntilMs = session.activeUntil ? new Date(session.activeUntil).getTime() : null;
    const activeWindowMs = this.getActiveWindowMs();

    if (activeUntilMs !== null && nowMs > activeUntilMs) {
      return {
        allowed: false,
        reason: "inactive",
        session,
        nextAllowedAt: null,
      };
    }

    if (lastRefreshMs !== null && nowMs - lastRefreshMs < this.getCooldownMs()) {
      return {
        allowed: false,
        reason: "cooldown",
        session,
        nextAllowedAt: toIsoString(new Date(lastRefreshMs + this.getCooldownMs())),
      };
    }

    const refreshedSession: SessionRecord = {
      ...session,
      activeUntil: toIsoString(new Date(nowMs + activeWindowMs)),
    };

    return {
      allowed: true,
      reason: "allowed",
      session: refreshedSession,
      nextAllowedAt: lastRefreshMs ? toIsoString(new Date(lastRefreshMs + this.getCooldownMs())) : null,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = new Date();
    const sessionKey = url.searchParams.get("sessionKey") ?? "default";

    if (request.method === "GET" && url.pathname === "/state") {
      const session = await this.readSession(sessionKey, now);
      return jsonResponse({
        ok: true,
        data: session,
      });
    }

    if (request.method === "POST" && url.pathname === "/touch") {
      const session = await this.readSession(sessionKey, now);
      const touched: SessionRecord = {
        ...session,
        lastTouchAt: toIsoString(now),
        activeUntil: toIsoString(new Date(now.getTime() + this.getActiveWindowMs())),
      };
      await this.writeSession(touched);
      const result: RefreshTouchResult = { session: touched };
      return jsonResponse({ ok: true, data: result });
    }

    if (request.method === "POST" && url.pathname === "/decide") {
      const body = (await readJsonBody<RefreshSessionRequest>(request).catch(() => ({}))) as Partial<RefreshSessionRequest>;
      const bodySessionKey = body.sessionKey ?? sessionKey;
      const session = await this.readSession(bodySessionKey, now);
      const decision = this.computeDecision(session, now);
      if (decision.allowed) {
        await this.writeSession({
          ...decision.session,
          lastRefreshAt: toIsoString(now),
          refreshCount: decision.session.refreshCount + 1,
        });
      }
      return jsonResponse({ ok: true, data: decision });
    }

    return errorResponse(404, "not_found", "Unknown refresh session route");
  }
}
