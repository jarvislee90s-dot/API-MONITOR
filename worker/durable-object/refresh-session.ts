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

// OpenAI API 专用预约状态：专用内部实例持久化，客户端参数不参与寻址与决策。
type OpenAiReservation = {
  periodStart: string;
  periodEnd: string;
  lastAllowedAt: string;
  reservationCount: number;
};

// 内部专用路由前缀：公开 /api/session/ 白名单永不转发到这些路径。
export const OPENAI_INTERNAL_SESSION_KEY = "__internal_openai_api_usage__";
export const OPENAI_INTERNAL_DECIDE_PATH = "/__internal_openai_api/decide";

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

  private getOpenAiCooldownMs(): number {
    return parseDuration(this.env.REFRESH_COOLDOWN_MS, 2 * 60 * 1000);
  }

  // 原子读判写：同周期内共享冷却，跨周期（含新周期首秒）立即放行。
  private async decideOpenAiReservation(
    periodStart: string,
    periodEnd: string,
    now: Date,
  ): Promise<{ allowed: boolean; nextAllowedAt: string | null }> {
    const stored = await this.state.storage.get<OpenAiReservation>("openai-reservation");
    const nowMs = now.getTime();

    // 拒绝迟到旧周期请求覆写当前周期预约状态。
    if (stored && stored.periodStart > periodStart) {
      return { allowed: false, nextAllowedAt: null };
    }
    if (stored && stored.periodStart === periodStart) {
      const lastMs = Date.parse(stored.lastAllowedAt);
      if (Number.isFinite(lastMs) && nowMs - lastMs < this.getOpenAiCooldownMs()) {
        return {
          allowed: false,
          nextAllowedAt: toIsoString(new Date(lastMs + this.getOpenAiCooldownMs())),
        };
      }
    }
    await this.state.storage.put("openai-reservation", {
      periodStart,
      periodEnd,
      lastAllowedAt: toIsoString(now),
      reservationCount: (stored?.reservationCount ?? 0) + 1,
    } satisfies OpenAiReservation);
    return { allowed: true, nextAllowedAt: null };
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

    if (request.method === "POST" && url.pathname === OPENAI_INTERNAL_DECIDE_PATH) {
      const body = (await readJsonBody<{ periodStart?: string; periodEnd?: string }>(request).catch(
        () => ({}),
      )) as { periodStart?: string; periodEnd?: string };
      if (!body.periodStart || !body.periodEnd) {
        return errorResponse(400, "invalid_request", "periodStart and periodEnd are required");
      }
      const decision = await this.decideOpenAiReservation(body.periodStart, body.periodEnd, now);
      return jsonResponse({ ok: true, data: decision });
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
