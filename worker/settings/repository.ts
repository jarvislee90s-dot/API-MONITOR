import { isProviderId, listProviders } from "../providers/registry";
import {
  decryptCredentialPayload,
  encryptCredentialPayload,
  maskCredentialPayload,
  type CredentialPayload,
} from "../security/credentials";

export type ProviderCatalogItem = {
  providerKey: string;
  providerName: string;
  sourceUrl: string;
  description: string;
};

export type ProviderPreference = {
  providerKey: string;
  enabled: boolean;
  displayOrder: number;
  activeProviderAccountId: string | null;
};

export type SafeProviderAccount = {
  id: string;
  providerKey: string;
  accountLabel: string;
  sourceUrl: string;
  status: string;
  statusMessage: string | null;
  credentialHint: Record<string, unknown>;
  homepageEnabled: boolean;
  homepageOrder: number;
  lastTestSummary: string | null;
};

export type ProviderSettingsPayload = {
  catalog: ProviderCatalogItem[];
  preferences: ProviderPreference[];
  accounts: SafeProviderAccount[];
};

type SettingsEnv = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

type ProviderPreferenceRow = {
  provider_key?: string;
  enabled?: boolean;
  display_order?: number;
  active_provider_account_id?: string | null;
};

type ProviderAccountRow = {
  id?: string;
  provider_key?: string;
  account_label?: string;
  display_name?: string;
  source_url?: string;
  status?: string;
  status_message?: string | null;
  credential_hint?: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
  homepage_enabled?: boolean;
  homepage_order?: number;
  last_test_summary?: string | null;
};

export function createSupabaseHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Accept: "application/json",
  };
}

function createEmptyProviderSettings(): ProviderSettingsPayload {
  return {
    catalog: listProviders().map((provider) => ({
      providerKey: provider.id,
      providerName: provider.name,
      sourceUrl: provider.sourceUrl,
      description: provider.description,
    })),
    preferences: [],
    accounts: [],
  };
}

async function readSupabaseRows<T>(
  url: URL,
  headers: HeadersInit,
  fetchImpl: typeof fetch,
): Promise<T[]> {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    return [];
  }

  const payload = await response.json().catch(() => []);
  return Array.isArray(payload) ? (payload as T[]) : [];
}

async function readSupabaseRowsWithStatus<T>(
  url: URL,
  headers: HeadersInit,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status: number; rows: T[] }> {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    return { ok: false, status: response.status, rows: [] };
  }

  const payload = await response.json().catch(() => []);
  return {
    ok: true,
    status: response.status,
    rows: Array.isArray(payload) ? (payload as T[]) : [],
  };
}

function isSchemaMismatch(status: number): boolean {
  return status === 400 || status === 404;
}

function mapProviderPreference(row: ProviderPreferenceRow): ProviderPreference | null {
  if (!row.provider_key) return null;
  return {
    providerKey: row.provider_key,
    enabled: row.enabled ?? false,
    displayOrder: row.display_order ?? 0,
    activeProviderAccountId: row.active_provider_account_id ?? null,
  };
}

function mapProviderAccount(row: ProviderAccountRow): SafeProviderAccount | null {
  if (!row.id || !row.provider_key) return null;
  const homepageEnabled =
    row.homepage_enabled ??
    (typeof row.config?.__homepageEnabled === "boolean" ? row.config.__homepageEnabled : true);
  const homepageOrder =
    row.homepage_order ??
    (typeof row.config?.__homepageOrder === "number" ? row.config.__homepageOrder : 100);
  return {
    id: row.id,
    providerKey: row.provider_key,
    accountLabel: row.display_name ?? row.account_label ?? "",
    sourceUrl: row.source_url ?? "",
    status: row.status ?? "disabled",
    statusMessage: row.status_message ?? null,
    credentialHint: row.credential_hint ?? maskLegacyConfigHint(row.config),
    homepageEnabled,
    homepageOrder,
    lastTestSummary: row.last_test_summary ?? null,
  };
}

function maskLegacyConfigHint(config: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!config) return {};

  const credentialLikeEntries = Object.entries(config).filter(([key, value]) => {
    return !key.startsWith("__") && key !== "sourceUrl" && typeof value === "string" && value.length > 0;
  });
  return maskCredentialPayload(Object.fromEntries(credentialLikeEntries) as Record<string, string>);
}

export async function listProviderSettings(
  env: SettingsEnv,
  userId: string,
  fetchImpl: typeof fetch,
): Promise<ProviderSettingsPayload> {
  const settings = createEmptyProviderSettings();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return settings;
  }

  const headers = createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY);
  const preferencesUrl = new URL("/rest/v1/provider_preferences", env.SUPABASE_URL);
  preferencesUrl.searchParams.set(
    "select",
    "provider_key,enabled,display_order,active_provider_account_id",
  );
  preferencesUrl.searchParams.set("user_id", `eq.${userId}`);
  preferencesUrl.searchParams.set("order", "display_order.asc");

  const accountsUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  accountsUrl.searchParams.set(
    "select",
    "id,provider_key,account_label,source_url,status,status_message,credential_hint,homepage_enabled,homepage_order,last_test_summary",
  );
  accountsUrl.searchParams.set("user_id", `eq.${userId}`);
  accountsUrl.searchParams.set("is_archived", "eq.false");

  const [preferenceResult, accountResult] = await Promise.all([
    readSupabaseRowsWithStatus<ProviderPreferenceRow>(preferencesUrl, headers, fetchImpl),
    readSupabaseRowsWithStatus<ProviderAccountRow>(accountsUrl, headers, fetchImpl),
  ]);

  let accountRows = accountResult.rows;
  if (!accountResult.ok && isSchemaMismatch(accountResult.status)) {
    const legacyAccountsUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
    legacyAccountsUrl.searchParams.set(
      "select",
      "id,provider_key,display_name,source_url,status,status_message,config",
    );
    legacyAccountsUrl.searchParams.set("user_id", `eq.${userId}`);
    accountRows = await readSupabaseRows<ProviderAccountRow>(legacyAccountsUrl, headers, fetchImpl);
  }

  // 旧 schema 下 provider_preferences 表不存在时，从 provider_accounts 的系统记录读偏好
  // （display_name = '__preferences__' 行的 config.__preferences JSONB 数组）。
  let preferenceRows = preferenceResult.rows;
  if (!preferenceResult.ok && isSchemaMismatch(preferenceResult.status)) {
    preferenceRows = await readLegacyProviderPreferences(env, userId, headers, fetchImpl);
  }

  return {
    ...settings,
    preferences: preferenceRows
      .map(mapProviderPreference)
      .filter((item): item is ProviderPreference => item !== null),
    accounts: accountRows
      .map(mapProviderAccount)
      .filter((item): item is SafeProviderAccount => item !== null),
  };
}

// 从 provider_accounts 系统记录（display_name='__preferences__'）读偏好
async function readLegacyProviderPreferences(
  env: SettingsEnv,
  userId: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<ProviderPreferenceRow[]> {
  const url = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  url.searchParams.set("select", "id,display_name,config");
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("display_name", `eq.__preferences__`);
  url.searchParams.set("limit", "1");

  const rows = await readSupabaseRows<{ config?: Record<string, unknown> | null }>(
    url,
    headers,
    fetchImpl,
  );
  const prefs = rows[0]?.config?.__preferences;
  if (!Array.isArray(prefs)) return [];
  return prefs as ProviderPreferenceRow[];
}


export type ProviderPreferenceInput = {
  providerKey: string;
  enabled: boolean;
  displayOrder: number;
  activeProviderAccountId: string | null;
};

export type ProviderAccountInput = {
  providerKey: string;
  accountLabel: string;
  sourceUrl: string;
  status?: string;
  statusMessage?: string | null;
  credentials?: CredentialPayload;
};

export async function updateProviderAccountDisplay(
  env: SettingsEnv,
  userId: string,
  accountId: string,
  display: { homepageEnabled: boolean; homepageOrder: number },
  fetchImpl: typeof fetch,
): Promise<{ id: string; homepageEnabled: boolean; homepageOrder: number }> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase configuration missing");
  }

  const url = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${accountId}`);
  url.searchParams.set("user_id", `eq.${userId}`);

  const response = await fetchImpl(url, {
    method: "PATCH",
    headers: {
      ...createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY),
      Prefer: "return=representation",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      homepage_enabled: display.homepageEnabled,
      homepage_order: display.homepageOrder,
    }),
  });

  if (!response.ok) {
    if (isSchemaMismatch(response.status)) {
      return updateLegacyProviderAccountDisplay(env, userId, accountId, display, fetchImpl);
    }
    throw new Error(`Failed to update account display: ${response.status}`);
  }

  const rows = (await response.json().catch(() => [])) as Array<{
    id?: string;
    homepage_enabled?: boolean;
    homepage_order?: number;
  }>;
  const row = rows[0];
  if (!row?.id) {
    throw new Error("Provider account not found");
  }

  return {
    id: row.id,
    homepageEnabled: row.homepage_enabled ?? display.homepageEnabled,
    homepageOrder: row.homepage_order ?? display.homepageOrder,
  };
}

async function updateLegacyProviderAccountDisplay(
  env: SettingsEnv,
  userId: string,
  accountId: string,
  display: { homepageEnabled: boolean; homepageOrder: number },
  fetchImpl: typeof fetch,
): Promise<{ id: string; homepageEnabled: boolean; homepageOrder: number }> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase configuration missing");
  }

  const headers = createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY);
  const readUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  readUrl.searchParams.set("select", "id,config");
  readUrl.searchParams.set("id", `eq.${accountId}`);
  readUrl.searchParams.set("user_id", `eq.${userId}`);

  const rows = await readSupabaseRows<{ id?: string; config?: Record<string, unknown> | null }>(
    readUrl,
    headers,
    fetchImpl,
  );
  const row = rows[0];
  if (!row?.id) {
    throw new Error("Provider account not found");
  }

  const patchUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  patchUrl.searchParams.set("id", `eq.${accountId}`);
  patchUrl.searchParams.set("user_id", `eq.${userId}`);

  const response = await fetchImpl(patchUrl, {
    method: "PATCH",
    headers: {
      ...headers,
      Prefer: "return=representation",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      config: {
        ...(row.config ?? {}),
        __homepageEnabled: display.homepageEnabled,
        __homepageOrder: display.homepageOrder,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to update legacy account display: ${response.status}`);
  }

  return {
    id: accountId,
    homepageEnabled: display.homepageEnabled,
    homepageOrder: display.homepageOrder,
  };
}

export async function upsertProviderPreferences(
  env: SettingsEnv & { CREDENTIAL_ENCRYPTION_KEY?: string },
  userId: string,
  preferences: ProviderPreferenceInput,
  fetchImpl: typeof fetch,
): Promise<ProviderPreference> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase configuration missing");
  }

  const headers = createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY);

  const url = new URL("/rest/v1/provider_preferences", env.SUPABASE_URL);
  url.searchParams.set("on_conflict", "user_id,provider_key");

  // 先用新 schema 表写入；如果表不存在，回退到旧 schema 的 provider_accounts 系统记录
  // （display_name='__preferences__'，config.__preferences 存数组）。
  const body = {
    user_id: userId,
    provider_key: preferences.providerKey,
    enabled: preferences.enabled,
    display_order: preferences.displayOrder,
    active_provider_account_id: preferences.activeProviderAccountId,
  };

  let response = await fetchImpl(url, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    if (isSchemaMismatch(response.status)) {
      await upsertLegacyProviderPreferences(env, userId, preferences, fetchImpl);
    } else {
      throw new Error(`Failed to upsert provider preferences: ${response.status}`);
    }
  }

  return {
    providerKey: preferences.providerKey,
    enabled: preferences.enabled,
    displayOrder: preferences.displayOrder,
    activeProviderAccountId: preferences.activeProviderAccountId,
  };
}

// 把单条 preference upsert 进 provider_accounts 系统记录的 config.__preferences 数组
async function upsertLegacyProviderPreferences(
  env: SettingsEnv,
  userId: string,
  preference: ProviderPreferenceInput,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase configuration missing");
  }

  const headers = createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY);

  // 读已有的系统记录
  const readUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  readUrl.searchParams.set("select", "id,config");
  readUrl.searchParams.set("user_id", `eq.${userId}`);
  readUrl.searchParams.set("display_name", `eq.__preferences__`);
  readUrl.searchParams.set("limit", "1");

  const existingRows = await readSupabaseRows<{
    id?: string;
    config?: Record<string, unknown> | null;
  }>(readUrl, headers, fetchImpl);
  const existingConfig = existingRows[0]?.config ?? {};
  const existingList = Array.isArray(existingConfig.__preferences)
    ? (existingConfig.__preferences as Array<Record<string, unknown>>)
    : [];

  // 合并：同 provider_key 替换
  const filtered = existingList.filter(
    (item) => item.provider_key !== preference.providerKey,
  );
  filtered.push({
    provider_key: preference.providerKey,
    enabled: preference.enabled,
    display_order: preference.displayOrder,
    active_provider_account_id: preference.activeProviderAccountId,
  });
  filtered.sort((a, b) => Number(a.display_order) - Number(b.display_order));

  const newConfig = {
    ...existingConfig,
    __preferences: filtered,
  };

  if (existingRows[0]?.id) {
    // 已有系统记录，PATCH
    const patchUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
    patchUrl.searchParams.set("id", `eq.${existingRows[0].id}`);
    patchUrl.searchParams.set("user_id", `eq.${userId}`);

    const response = await fetchImpl(patchUrl, {
      method: "PATCH",
      headers: {
        ...headers,
        Prefer: "return=minimal",
        "content-type": "application/json",
      },
      body: JSON.stringify({ config: newConfig }),
    });
    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        // ignore
      }
      throw new Error(
        `Failed to update legacy preferences: ${response.status} ${detail}`.trim(),
      );
    }
  } else {
    // 没有系统记录，INSERT（不带 on_conflict：旧 schema 上没有 user_id+provider_key+display_name
    // 唯一约束，而 provider_accounts_user_provider_source_idx 的 source_url="" 会让重复
    // 拖拽后的"第二次保存"在 PostgREST 把 INSERT 当成 upsert 行为并撞唯一约束——所以我们
    // 已经在前面通过 GET 检测过了，进入这条分支一定是没有记录。
    const insertUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);

    const response = await fetchImpl(insertUrl, {
      method: "POST",
      headers: {
        ...headers,
        Prefer: "return=minimal",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user_id: userId,
        provider_key: "__preferences__",
        display_name: "__preferences__",
        source_url: "",
        auth_mode: "manual",
        status: "ready",
        status_message: null,
        config: newConfig,
      }),
    });
    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        // ignore
      }
      throw new Error(
        `Failed to insert legacy preferences: ${response.status} ${detail}`.trim(),
      );
    }
  }
}

export async function upsertProviderAccount(
  env: SettingsEnv & { CREDENTIAL_ENCRYPTION_KEY?: string },
  userId: string,
  account: ProviderAccountInput,
  fetchImpl: typeof fetch,
): Promise<{ id: string }> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase configuration missing");
  }

  // 校验 provider_key 白名单，避免任意外部域名复用云端凭据。
  if (!isProviderId(account.providerKey)) {
    throw new Error(`Invalid provider key: ${account.providerKey}`);
  }
  const headers = createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY);
  headers.Prefer = "resolution=merge-duplicates,return=representation";

  // 1. 写入 provider_accounts
  const accountUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  accountUrl.searchParams.set("on_conflict", "user_id,provider_key,account_label");

  const accountBody = {
    user_id: userId,
    provider_key: account.providerKey,
    display_name: account.accountLabel,
    account_label: account.accountLabel,
    source_url: account.sourceUrl,
    auth_mode: account.credentials ? "configured" : "manual",
    status: account.status ?? "ready",
    status_message: account.statusMessage ?? null,
    credential_hint: account.credentials ? maskCredentialPayload(account.credentials) : {},
  };

  const accountResponse = await fetchImpl(accountUrl, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(accountBody),
  });

  if (!accountResponse.ok) {
    let detail = "";
    try {
      detail = await accountResponse.text();
    } catch {
      // ignore
    }
    if (isSchemaMismatch(accountResponse.status)) {
      return upsertLegacyProviderAccount(env, userId, account, fetchImpl);
    }
    throw new Error(
      `Failed to upsert provider account: ${accountResponse.status} ${detail}`.trim(),
    );
  }

  // 解析返回的 account id
  const accountRows = (await accountResponse.json().catch(() => [])) as Array<{ id?: string }>;
  const accountId = accountRows[0]?.id ?? "";
  if (!accountId) {
    throw new Error("Supabase did not return provider account id");
  }

  // 2. 如果有 credentials，加密并写入 provider_account_credentials
  if (account.credentials) {
    const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new Error("Credential encryption key is required to store credentials");
    }
    const encrypted = await encryptCredentialPayload(account.credentials, encryptionKey);
    const credUrl = new URL("/rest/v1/provider_account_credentials", env.SUPABASE_URL);
    credUrl.searchParams.set("on_conflict", "provider_account_id");

    const credBody = {
      user_id: userId,
      provider_account_id: accountId,
      encrypted_payload: encrypted.encryptedPayload,
      nonce: encrypted.nonce,
      key_version: encrypted.keyVersion,
    };

    const credResponse = await fetchImpl(credUrl, {
      method: "POST",
      headers: {
        ...headers,
        Prefer: "resolution=merge-duplicates,return=minimal",
        "content-type": "application/json",
      },
      body: JSON.stringify(credBody),
    });

    if (!credResponse.ok) {
      throw new Error(`Failed to store credentials: ${credResponse.status}`);
    }
  }

  return { id: accountId };
}

export async function updateProviderAccount(
  env: SettingsEnv & { CREDENTIAL_ENCRYPTION_KEY?: string },
  userId: string,
  accountId: string,
  account: ProviderAccountInput,
  fetchImpl: typeof fetch,
): Promise<{ id: string }> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase configuration missing");
  }

  if (!isProviderId(account.providerKey)) {
    throw new Error(`Invalid provider key: ${account.providerKey}`);
  }

  const headers = createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY);
  const accountUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  accountUrl.searchParams.set("id", `eq.${accountId}`);
  accountUrl.searchParams.set("user_id", `eq.${userId}`);

  const accountBody = {
    provider_key: account.providerKey,
    display_name: account.accountLabel,
    account_label: account.accountLabel,
    source_url: account.sourceUrl,
    auth_mode: account.credentials ? "configured" : "manual",
    status: account.status ?? "ready",
    status_message: account.statusMessage ?? null,
    credential_hint: account.credentials ? maskCredentialPayload(account.credentials) : {},
  };

  const accountResponse = await fetchImpl(accountUrl, {
    method: "PATCH",
    headers: {
      ...headers,
      Prefer: "return=representation",
      "content-type": "application/json",
    },
    body: JSON.stringify(accountBody),
  });

  if (!accountResponse.ok) {
    if (isSchemaMismatch(accountResponse.status)) {
      return updateLegacyProviderAccount(env, userId, accountId, account, fetchImpl);
    }
    throw new Error(`Failed to update provider account: ${accountResponse.status}`);
  }

  const rows = (await accountResponse.json().catch(() => [])) as Array<{ id?: string }>;
  const updatedAccountId = rows[0]?.id ?? "";
  if (!updatedAccountId) {
    throw new Error("Provider account not found");
  }

  if (account.credentials) {
    const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new Error("Credential encryption key is required to store credentials");
    }
    const encrypted = await encryptCredentialPayload(account.credentials, encryptionKey);
    const credUrl = new URL("/rest/v1/provider_account_credentials", env.SUPABASE_URL);
    credUrl.searchParams.set("on_conflict", "provider_account_id");

    const credResponse = await fetchImpl(credUrl, {
      method: "POST",
      headers: {
        ...headers,
        Prefer: "resolution=merge-duplicates,return=minimal",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user_id: userId,
        provider_account_id: updatedAccountId,
        encrypted_payload: encrypted.encryptedPayload,
        nonce: encrypted.nonce,
        key_version: encrypted.keyVersion,
      }),
    });

    if (!credResponse.ok) {
      throw new Error(`Failed to store credentials: ${credResponse.status}`);
    }
  }

  return { id: updatedAccountId };
}

export async function deleteProviderAccount(
  env: SettingsEnv,
  userId: string,
  accountId: string,
  fetchImpl: typeof fetch,
): Promise<{ id: string }> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase configuration missing");
  }

  const url = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${accountId}`);
  url.searchParams.set("user_id", `eq.${userId}`);

  const response = await fetchImpl(url, {
    method: "DELETE",
    headers: {
      ...createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY),
      Prefer: "return=minimal",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to delete provider account: ${response.status}`);
  }

  return { id: accountId };
}

async function upsertLegacyProviderAccount(
  env: SettingsEnv,
  userId: string,
  account: ProviderAccountInput,
  fetchImpl: typeof fetch,
): Promise<{ id: string }> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase configuration missing");
  }

  // 旧 schema 上 provider_accounts 表有 (user_id, provider_key, source_url) 唯一索引
  // （provider_accounts_user_provider_source_idx）。绝对不能用 merge-duplicates +
  // on_conflict=user_id,provider_key,source_url，因为那会把已存在的同 source_url 行覆盖，
  // 造成已存账号的凭据被新数据替换（数据丢失事故）。
  // 正确做法：纯 POST 插入；撞唯一索引时返回 409，由前端提示用户该 source_url 已被占用，
  // 引导其改用 PATCH 改别名（updateProviderAccount）或换个 source_url。
  const url = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      ...createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY),
      Prefer: "return=representation",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      user_id: userId,
      provider_key: account.providerKey,
      display_name: account.accountLabel,
      source_url: account.sourceUrl,
      auth_mode: account.credentials ? "configured" : "manual",
      status: account.status ?? "ready",
      status_message: account.statusMessage ?? null,
      config: {
        ...(account.credentials ?? {}),
        __homepageEnabled: true,
        __homepageOrder: 100,
      },
    }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      // ignore
    }
    throw new Error(
      `Failed to create legacy provider account: ${response.status} ${detail}`.trim(),
    );
  }

  const rows = (await response.json().catch(() => [])) as Array<{ id?: string }>;
  const accountId = rows[0]?.id ?? "";
  if (!accountId) {
    throw new Error("Supabase did not return provider account id");
  }
  return { id: accountId };
}

async function updateLegacyProviderAccount(
  env: SettingsEnv,
  userId: string,
  accountId: string,
  account: ProviderAccountInput,
  fetchImpl: typeof fetch,
): Promise<{ id: string }> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase configuration missing");
  }

  const headers = createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY);
  const readUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  readUrl.searchParams.set("select", "id,config");
  readUrl.searchParams.set("id", `eq.${accountId}`);
  readUrl.searchParams.set("user_id", `eq.${userId}`);

  const existingRows = await readSupabaseRows<{ id?: string; config?: Record<string, unknown> | null }>(
    readUrl,
    headers,
    fetchImpl,
  );
  const existingConfig = existingRows[0]?.config ?? {};

  const url = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${accountId}`);
  url.searchParams.set("user_id", `eq.${userId}`);

  const response = await fetchImpl(url, {
    method: "PATCH",
    headers: {
      ...headers,
      Prefer: "return=representation",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      provider_key: account.providerKey,
      display_name: account.accountLabel,
      source_url: account.sourceUrl,
      auth_mode: account.credentials ? "configured" : "manual",
      status: account.status ?? "ready",
      status_message: account.statusMessage ?? null,
      config: {
        ...existingConfig,
        ...(account.credentials ?? {}),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to update legacy provider account: ${response.status}`);
  }

  const rows = (await response.json().catch(() => [])) as Array<{ id?: string }>;
  const updatedAccountId = rows[0]?.id ?? "";
  if (!updatedAccountId) {
    throw new Error("Provider account not found");
  }
  return { id: updatedAccountId };
}

export async function getActiveProviderAccountConfig(
  env: SettingsEnv & { CREDENTIAL_ENCRYPTION_KEY?: string },
  userId: string,
  providerKey: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  const headers = createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY);

  // 1. 读取 provider_preferences
  const prefUrl = new URL("/rest/v1/provider_preferences", env.SUPABASE_URL);
  prefUrl.searchParams.set("select", "*");
  prefUrl.searchParams.set("provider_key", `eq.${providerKey}`);
  prefUrl.searchParams.set("user_id", `eq.${userId}`);
  prefUrl.searchParams.set("enabled", "eq.true");

  const prefResponse = await fetchImpl(prefUrl, { headers });
  if (!prefResponse.ok) return null;

  const prefRows = (await prefResponse.json().catch(() => [])) as Array<{
    active_provider_account_id?: string;
  }>;
  const activeAccountId = prefRows[0]?.active_provider_account_id;
  if (!activeAccountId) return null;

  // 2. 读取 provider_accounts
  const accountUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  accountUrl.searchParams.set("select", "*");
  accountUrl.searchParams.set("id", `eq.${activeAccountId}`);
  accountUrl.searchParams.set("user_id", `eq.${userId}`);
  accountUrl.searchParams.set("provider_key", `eq.${providerKey}`);

  const accountResponse = await fetchImpl(accountUrl, { headers });
  if (!accountResponse.ok) return null;

  const accountRows = (await accountResponse.json().catch(() => [])) as Array<{
    provider_key?: string;
    config?: Record<string, unknown>;
    source_url?: string;
  }>;
  const account = accountRows[0];
  if (!account || account.provider_key !== providerKey) return null;

  // 3. 读取 provider_account_credentials
  const credUrl = new URL("/rest/v1/provider_account_credentials", env.SUPABASE_URL);
  credUrl.searchParams.set("select", "*");
  credUrl.searchParams.set("provider_account_id", `eq.${activeAccountId}`);

  const credResponse = await fetchImpl(credUrl, { headers });
  let decryptedConfig: Record<string, unknown> = {};
  if (credResponse.ok) {
    const credRows = (await credResponse.json().catch(() => [])) as Array<{
      encrypted_payload?: string;
      nonce?: string;
      key_version?: string;
    }>;
    const cred = credRows[0];
    if (cred && env.CREDENTIAL_ENCRYPTION_KEY) {
      try {
        const payload = await decryptCredentialPayload(
          {
            encryptedPayload: cred.encrypted_payload!,
            nonce: cred.nonce!,
            keyVersion: cred.key_version as "v1",
          },
          env.CREDENTIAL_ENCRYPTION_KEY,
        );
        decryptedConfig = payload;
      } catch {
        // 解密失败，使用 account.config 继续
      }
    }
  }

  return {
    ...account.config,
    ...decryptedConfig,
    sourceUrl: account.source_url,
  };
}

export async function getProviderAccountConfigById(
  env: SettingsEnv & { CREDENTIAL_ENCRYPTION_KEY?: string },
  userId: string,
  accountId: string,
  fetchImpl: typeof fetch,
): Promise<{ providerKey: string; config: Record<string, unknown> } | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  const headers = createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY);
  const accountUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  accountUrl.searchParams.set("select", "provider_key,config,source_url");
  accountUrl.searchParams.set("id", `eq.${accountId}`);
  accountUrl.searchParams.set("user_id", `eq.${userId}`);

  const accountResponse = await fetchImpl(accountUrl, { headers });
  if (!accountResponse.ok) return null;

  const accountRows = (await accountResponse.json().catch(() => [])) as Array<{
    provider_key?: string;
    config?: Record<string, unknown>;
    source_url?: string;
  }>;
  const account = accountRows[0];
  if (!account?.provider_key) return null;

  const credUrl = new URL("/rest/v1/provider_account_credentials", env.SUPABASE_URL);
  credUrl.searchParams.set("select", "encrypted_payload,nonce,key_version");
  credUrl.searchParams.set("provider_account_id", `eq.${accountId}`);
  credUrl.searchParams.set("user_id", `eq.${userId}`);

  const credResponse = await fetchImpl(credUrl, { headers });
  let decryptedConfig: Record<string, unknown> = {};
  if (credResponse.ok) {
    const credRows = (await credResponse.json().catch(() => [])) as Array<{
      encrypted_payload?: string;
      nonce?: string;
      key_version?: string;
    }>;
    const cred = credRows[0];
    if (cred?.encrypted_payload && cred.nonce && env.CREDENTIAL_ENCRYPTION_KEY) {
      try {
        decryptedConfig = await decryptCredentialPayload(
          {
            encryptedPayload: cred.encrypted_payload,
            nonce: cred.nonce,
            keyVersion: cred.key_version === "v1" ? "v1" : "v1",
          },
          env.CREDENTIAL_ENCRYPTION_KEY,
        );
      } catch {
        decryptedConfig = {};
      }
    }
  }

  return {
    providerKey: account.provider_key,
    config: {
      ...account.config,
      ...decryptedConfig,
      sourceUrl: account.source_url,
    },
  };
}

