import type { SafeProviderAccount } from "../api/client";

type AccountStatusKey = "ready" | "login_required" | "error" | "disabled" | "unknown";

const STATUS_LABELS: Record<AccountStatusKey, string> = {
  ready: "已连接",
  login_required: "需要登录",
  error: "抓取失败",
  disabled: "已停用",
  unknown: "未知",
};

export function getAccountStatusLabel(account: SafeProviderAccount): string {
  const key = account.status as AccountStatusKey;
  return STATUS_LABELS[key] ?? STATUS_LABELS.unknown;
}

export function getStatusTone(account: SafeProviderAccount): "healthy" | "warning" | "error" {
  switch (account.status) {
    case "ready":
      return "healthy";
    case "login_required":
      return "warning";
    case "error":
    case "disabled":
      return "error";
    default:
      return "warning";
  }
}
