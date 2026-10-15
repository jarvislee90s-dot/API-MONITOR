/**
 * Codex 本地会话日志 → 额度快照（免网络、免浏览器的数据源）
 *
 * 背景：Codex CLI/IDE 每次请求都会把服务端返回的额度写进会话日志
 * （`~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl` 的 `payload.rate_limits`），
 * 字段为 `primary/secondary.{used_percent, window_minutes, resets_at}` 与 `plan_type`。
 * 这正是 CLI「剩余用量」面板显示的数据；而 `backend-api/codex/usage` 返回的
 * `used_percent` 实测与之不一致（2026-10-15：API 报 0，CLI/日志报 5）。
 * 因此看板要跟 CLI 对齐，应以本地日志为准。
 *
 * 用法：readLatestCodexUsage() 扫描最近若干个会话文件，取最后一条 rate_limits。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type CodexRateLimitWindow = {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
};

export type CodexLogUsage = {
  filePath: string;
  observedAt: string;
  planType: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  usedWindowKeys: string[];
};

const DEFAULT_ROOT = resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".codex", "sessions");
const MAX_FILE_BYTES = 64 * 1024 * 1024;

function collectSessionFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) collectSessionFiles(full, out);
    else if (entry.endsWith(".jsonl")) out.push(full);
  }
}

// 从单行 JSON 中取出 payload.rate_limits（含 plan_type）
function extractRateLimits(line: string): { rateLimits: Record<string, unknown>; timestamp: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { timestamp?: unknown; payload?: { rate_limits?: unknown } };
  const rateLimits = record.payload?.rate_limits;
  if (!rateLimits || typeof rateLimits !== "object") return null;
  return {
    rateLimits: rateLimits as Record<string, unknown>,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
  };
}

function toWindow(value: unknown): CodexRateLimitWindow | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const window: CodexRateLimitWindow = {};
  if (typeof record.used_percent === "number") window.used_percent = record.used_percent;
  if (typeof record.window_minutes === "number") window.window_minutes = record.window_minutes;
  if (typeof record.resets_at === "number") window.resets_at = record.resets_at;
  return Object.keys(window).length > 0 ? window : null;
}

// 扫描最近若干会话文件，返回最新一条额度快照（日志时间即采集时间）
export function readLatestCodexUsage(
  options: { root?: string; maxFiles?: number; maxBytes?: number } = {},
): CodexLogUsage | null {
  const root = options.root ?? DEFAULT_ROOT;
  if (!existsSync(root)) return null;

  const files: string[] = [];
  collectSessionFiles(root, files);
  if (files.length === 0) return null;

  const withStat = files
    .map((filePath) => {
      try {
        return { filePath, mtime: statSync(filePath).mtimeMs, size: statSync(filePath).size };
      } catch {
        return null;
      }
    })
    .filter((item): item is { filePath: string; mtime: number; size: number } => item !== null)
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, options.maxFiles ?? 5);

  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
  for (const candidate of withStat) {
    if (candidate.size > maxBytes) continue;
    let content: string;
    try {
      content = readFileSync(candidate.filePath, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    let found: { rateLimits: Record<string, unknown>; timestamp: string | null } | null = null;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      if (!line.includes('"rate_limits"')) continue;
      const extracted = extractRateLimits(line);
      if (extracted) {
        found = extracted;
        break;
      }
    }
    if (!found) continue;

    const rateLimits = found.rateLimits;
    const primary = toWindow(rateLimits.primary);
    const secondary = toWindow(rateLimits.secondary);
    if (!primary && !secondary) continue;

    return {
      filePath: candidate.filePath,
      observedAt: found.timestamp ?? new Date(candidate.mtime).toISOString(),
      planType: typeof rateLimits.plan_type === "string" ? rateLimits.plan_type.toLowerCase() : null,
      primary,
      secondary,
      usedWindowKeys: [primary && "primary", secondary && "secondary"].filter(Boolean) as string[],
    };
  }
  return null;
}
