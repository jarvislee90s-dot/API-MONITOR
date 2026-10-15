/**
 * ChatGPT 凭据本机侧工具（被 refresh-chatgpt-usage.ts 复用）
 *
 * 为什么需要：auth.json 里的 ChatGPT token 会因订阅档位变化等情况被服务端判为失效
 * （实测 2026-10-15：token 未到 exp 但返回 401 token_expired），而 Supabase 里保存的
 * 副本带 refreshToken，可以在本机刷新并写回——与 worker 的 credentialUpdate 写回同一套加密格式。
 *
 * 加密格式与 worker/security/credentials.ts 一致：AES-256-GCM，12 字节随机 nonce，
 * ciphertext||tag 一起 base64。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const DEFAULT_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export type ChatgptCredentialFields = {
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
  sessionToken?: string;
};

export type StoredChatgptCredential = {
  accountId: string;
  accountLabel: string;
  credential: ChatgptCredentialFields;
};

type SupabaseEnv = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  SUPABASE_USER_ID?: string;
};

function requireEnv(env: SupabaseEnv): { url: string; key: string; encryptionKey: string } {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
  if (!url || !key || !encryptionKey) {
    throw new Error("缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CREDENTIAL_ENCRYPTION_KEY");
  }
  return { url, key, encryptionKey };
}

function decrypt(encryptedPayload: string, nonce: string, rawKey: string): ChatgptCredentialFields {
  const key = Buffer.from(rawKey, "utf8");
  if (key.byteLength !== 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY 必须是 32 字节");
  const cipher = Buffer.from(encryptedPayload, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"));
  decipher.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([decipher.update(cipher.subarray(0, cipher.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as ChatgptCredentialFields;
}

function encrypt(payload: ChatgptCredentialFields, rawKey: string): { encryptedPayload: string; nonce: string } {
  const key = Buffer.from(rawKey, "utf8");
  if (key.byteLength !== 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY 必须是 32 字节");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { encryptedPayload: encrypted.toString("base64"), nonce: nonce.toString("base64") };
}

// 读取 Supabase 中 chatgpt 账号的加密凭据（worker 侧同一份副本）
export async function loadStoredChatgptCredential(env: SupabaseEnv): Promise<StoredChatgptCredential | null> {
  const { url, key, encryptionKey } = requireEnv(env);
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  const accountsUrl = new URL("/rest/v1/provider_accounts", url);
  accountsUrl.searchParams.set("select", "id,account_label");
  accountsUrl.searchParams.set("provider_key", "eq.chatgpt");
  const accounts = (await (await fetch(accountsUrl, { headers })).json()) as Array<{
    id: string;
    account_label: string;
  }>;
  const account = accounts[0];
  if (!account) return null;

  const credUrl = new URL("/rest/v1/provider_account_credentials", url);
  credUrl.searchParams.set("select", "encrypted_payload,nonce");
  credUrl.searchParams.set("provider_account_id", `eq.${account.id}`);
  const rows = (await (await fetch(credUrl, { headers })).json()) as Array<{
    encrypted_payload: string;
    nonce: string;
  }>;
  const row = rows[0];
  if (!row) return null;

  return {
    accountId: account.id,
    accountLabel: account.account_label,
    credential: decrypt(row.encrypted_payload, row.nonce, encryptionKey),
  };
}

// 用 refreshToken 换新 accessToken（会轮换 refreshToken），成功后立即写回 Supabase
export async function refreshStoredChatgptCredential(
  env: SupabaseEnv,
  stored: StoredChatgptCredential,
): Promise<{ accessToken: string; refreshToken: string; planType: string | null } | null> {
  const refreshToken = stored.credential.refreshToken;
  if (!refreshToken) return null;
  const { url, key, encryptionKey } = requireEnv(env);

  const clientId =
    (accessTokenClaims(stored.credential.accessToken ?? "")?.client_id as string | undefined) ??
    DEFAULT_CODEX_CLIENT_ID;

  const response = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    refresh_token?: unknown;
  } | null;
  if (!payload || typeof payload.access_token !== "string" || payload.access_token.length === 0) return null;

  const nextRefresh = typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
    ? payload.refresh_token
    : refreshToken;

  // 写回（与 worker credentialUpdate 一致：只在完整凭据基础上替换轮换字段）
  const upsertUrl = new URL("/rest/v1/provider_account_credentials", url);
  upsertUrl.searchParams.set("on_conflict", "provider_account_id");
  const nextCredential: ChatgptCredentialFields = {
    ...stored.credential,
    accessToken: payload.access_token,
    refreshToken: nextRefresh,
  };
  const encrypted = encrypt(nextCredential, encryptionKey);
  const upsert = await fetch(upsertUrl, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      user_id: env.SUPABASE_USER_ID,
      provider_account_id: stored.accountId,
      encrypted_payload: encrypted.encryptedPayload,
      nonce: encrypted.nonce,
      key_version: "v1",
    }),
  });

  return {
    accessToken: payload.access_token,
    refreshToken: nextRefresh,
    planType: accessTokenPlanType(payload.access_token),
    ...(upsert.ok ? {} : { storeWarning: `写回 Supabase 失败: HTTP ${upsert.status}` }),
  } as { accessToken: string; refreshToken: string; planType: string | null };
}

export function accessTokenClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// token 内嵌的订阅档位（实测：订阅变更后服务端可能直接判该 token 失效）
export function accessTokenPlanType(token: string): string | null {
  const auth = accessTokenClaims(token)?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const plan = auth?.chatgpt_plan_type;
  return typeof plan === "string" ? plan : null;
}

export function accessTokenAccountId(token: string): string | null {
  const auth = accessTokenClaims(token)?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const id = auth?.chatgpt_account_id;
  return typeof id === "string" ? id : null;
}
