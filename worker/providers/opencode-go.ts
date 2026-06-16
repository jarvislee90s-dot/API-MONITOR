import { clampNumber, parseHeadersCookie, toIsoString } from "../http";
import type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult } from "../types";
import { createResult } from "./types";
import { parseOpenCodeGoWindows } from "./opencode-go-parser";

type OpenCodeGoConfig = {
  workspaceId?: string;
  authCookie?: string;
  baseUrl?: string;
};

function toCookiePair(name: unknown, value: unknown): string | null {
  if (typeof name !== "string" || name.trim() === "") return null;
  if (value === undefined || value === null) return null;
  const cookieName = name.trim();
  if (cookieName.includes(";") || cookieName.includes("=")) return null;
  return `${cookieName}=${String(value)}`;
}

function parseJsonCookie(rawCookie: string): string | null {
  try {
    const parsed = JSON.parse(rawCookie) as unknown;
    if (Array.isArray(parsed)) {
      const pairs = parsed
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const record = item as Record<string, unknown>;
          return toCookiePair(record.name, record.value);
        })
        .filter((pair): pair is string => Boolean(pair));
      return pairs.length > 0 ? pairs.join("; ") : null;
    }

    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const nestedCookie = record.cookie ?? record.Cookie ?? record.header ?? record.value;
      if (typeof nestedCookie === "string") {
        return normalizeOpenCodeCookie(nestedCookie) ?? null;
      }

      const singlePair = toCookiePair(record.name, record.value);
      if (singlePair) return singlePair;

      const pairs = Object.entries(record)
        .map(([name, value]) => {
          if (typeof value === "object") return null;
          return toCookiePair(name, value);
        })
        .filter((pair): pair is string => Boolean(pair));
      return pairs.length > 0 ? pairs.join("; ") : null;
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeOpenCodeCookie(rawCookie: string | undefined): string | undefined {
  const trimmed = parseHeadersCookie(rawCookie);
  if (!trimmed) return undefined;

  const jsonCookie = parseJsonCookie(trimmed);
  if (jsonCookie) return jsonCookie;

  if (trimmed.includes("=")) return trimmed;
  return `auth=${trimmed}`;
}

function isOpenCodeAuthUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value, "https://opencode.ai");
    return url.hostname === "auth.opencode.ai" || url.pathname.startsWith("/auth/");
  } catch {
    return /auth\.opencode\.ai|\/auth\//i.test(value);
  }
}

function getDashboardUrl(config: OpenCodeGoConfig): string {
  const origin = config.baseUrl?.replace(/\/$/, "") ?? "https://opencode.ai";
  if (!config.workspaceId) return `${origin}/workspace`;
  return `${origin}/workspace/${encodeURIComponent(config.workspaceId)}/go`;
}

export async function fetchOpenCodeGoSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult> {
  const now = toIsoString(input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const config = (input.config ?? {}) as OpenCodeGoConfig;
  const sourceUrl = getDashboardUrl(config);

  if (!config.workspaceId || !config.authCookie) {
    return createResult({
      providerId: "opencode-go",
      providerName: "OpenCode Go",
      sourceUrl,
      status: "login_required",
      capturedAt: now,
      summary: "Missing workspaceId or auth cookie",
      windows: [],
      metrics: {
        hasWorkspaceId: Boolean(config.workspaceId),
        hasAuthCookie: Boolean(config.authCookie),
      },
      meta: {},
    });
  }

  const response = await fetchImpl(sourceUrl, {
    redirect: "manual",
    // 这里只读取云端注入的会话材料，不把它们回传给前端。
    headers: {
      ...(normalizeOpenCodeCookie(config.authCookie) ? { Cookie: normalizeOpenCodeCookie(config.authCookie)! } : {}),
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApiMonitor/0.1",
    },
  });

  const html = await response.text();
  if (!response.ok) {
    const location = response.headers.get("location");
    const redirectedToLogin = response.status >= 300 && response.status < 400 && isOpenCodeAuthUrl(location);
    const status = response.status === 401 || response.status === 403 || redirectedToLogin ? "login_required" : "error";
    return createResult({
      providerId: "opencode-go",
      providerName: "OpenCode Go",
      sourceUrl,
      status,
      capturedAt: now,
      summary: redirectedToLogin
        ? "OpenCode Go dashboard redirected to login"
        : `OpenCode Go dashboard returned HTTP ${response.status}`,
      windows: [],
      metrics: { httpStatus: response.status },
      meta: {},
    });
  }

  const loginRequired = isOpenCodeAuthUrl(response.url) || /<title[^>]*>\s*OpenAuth\s*<\/title>|sign in|log in|login|登录|登入/i.test(html);
  const parsedWindows = parseOpenCodeGoWindows(html, input.now);

  return createResult({
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    sourceUrl,
    status: loginRequired ? "login_required" : parsedWindows.length > 0 ? "ready" : "partial",
    capturedAt: now,
    summary: loginRequired
      ? "OpenCode Go dashboard appears to require login"
      : parsedWindows.length > 0
        ? "OpenCode Go usage windows parsed"
        : "OpenCode Go dashboard loaded but usage windows were not found",
    windows: parsedWindows,
    metrics: {
      hasRolling: parsedWindows.some((window) => window.key === "rolling"),
      hasWeekly: parsedWindows.some((window) => window.key === "weekly"),
      hasMonthly: parsedWindows.some((window) => window.key === "monthly"),
    },
    meta: {},
  });
}

export const opencodeGo: ProviderDefinition = {
  id: "opencode-go",
  name: "OpenCode Go",
  sourceUrl: "https://opencode.ai/workspace/{workspaceId}/go",
  description: "OpenCode Go workspace dashboard usage snapshot",
  fetchSnapshot: fetchOpenCodeGoSnapshot,
};
