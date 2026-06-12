import type { ProviderId } from "../types";

export type LiveLoginProvider = ProviderId | "custom";

export interface LiveLoginSession {
  provider: LiveLoginProvider;
  loginUrl: string;
  liveViewUrl: string;
  expiresAt: string;
  status: "manual_open" | "browser_run_pending";
  message: string;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function createLiveLoginSession(input: {
  provider: LiveLoginProvider;
  loginUrl: string;
  now?: Date;
  ttlMs?: number;
}): LiveLoginSession {
  if (!isHttpUrl(input.loginUrl)) {
    throw new Error("loginUrl must be a valid http(s) URL");
  }

  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;

  return {
    provider: input.provider,
    loginUrl: input.loginUrl,
    liveViewUrl: input.loginUrl,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    status: "manual_open",
    message: "Browser Run 尚未接入，当前返回原网页入口用于手动修复登录态。",
  };
}
