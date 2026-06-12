import { listProviders } from "../providers/registry";
import { encryptCredentialPayload, decryptCredentialPayload, type CredentialPayload } from "../security/credentials";

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
};

export type ProviderSettingsPayload = {
  catalog: ProviderCatalogItem[];
  preferences: ProviderPreference[];
  accounts: SafeProviderAccount[];
};

type SettingsEnv = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_USER_ID?: string;
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
  source_url?: string;
  status?: string;
  status_message?: string | null;
  credential_hint?: Record<string, unknown> | null;
};

export function createSupabaseHeaders(serviceRoleKey: string): HeadersInit {
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
  return {
    id: row.id,
    providerKey: row.provider_key,
    accountLabel: row.account_label ?? "",
    sourceUrl: row.source_url ?? "",
    status: row.status ?? "disabled",
    statusMessage: row.status_message ?? null,
    credentialHint: row.credential_hint ?? {},
  };
}

export async function listProviderSettings(
  env: SettingsEnv,
  fetchImpl: typeof fetch,
): Promise<ProviderSettingsPayload> {
  const settings = createEmptyProviderSettings();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_USER_ID) {
    return settings;
  }

  const headers = createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY);
  const preferencesUrl = new URL("/rest/v1/provider_preferences", env.SUPABASE_URL);
  preferencesUrl.searchParams.set(
    "select",
    "provider_key,enabled,display_order,active_provider_account_id",
  );
  preferencesUrl.searchParams.set("user_id", `eq.${env.SUPABASE_USER_ID}`);
  preferencesUrl.searchParams.set("order", "display_order.asc");

  const accountsUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  accountsUrl.searchParams.set(
    "select",
    "id,provider_key,account_label,source_url,status,status_message,credential_hint",
  );
  accountsUrl.searchParams.set("user_id", `eq.${env.SUPABASE_USER_ID}`);
  accountsUrl.searchParams.set("is_archived", "eq.false");

  const [preferenceRows, accountRows] = await Promise.all([
    readSupabaseRows<ProviderPreferenceRow>(preferencesUrl, headers, fetchImpl),
    readSupabaseRows<ProviderAccountRow>(accountsUrl, headers, fetchImpl),
  ]);

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

export async function upsertProviderPreferences(
  env: SettingsEnv & { CREDENTIAL_ENCRYPTION_KEY?: string },
  preferences: ProviderPreferenceInput,
  fetchImpl: typeof fetch,
): Promise<ProviderPreference> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_USER_ID) {
    throw new Error("Supabase configuration missing");
  }

  const headers = createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY);
  headers["Prefer"] = "resolution=merge-duplicates";

  const url = new URL("/rest/v1/provider_preferences", env.SUPABASE_URL);
  const body = {
    user_id: env.SUPABASE_USER_ID,
    provider_key: preferences.providerKey,
    enabled: preferences.enabled,
    display_order: preferences.displayOrder,
    active_provider_account_id: preferences.activeProviderAccountId,
  };

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Failed to upsert provider preferences: ${response.status}`);
  }

  return {
    providerKey: preferences.providerKey,
    enabled: preferences.enabled,
    displayOrder: preferences.displayOrder,
    activeProviderAccountId: preferences.activeProviderAccountId,
  };
}

export async function upsertProviderAccount(
  env: SettingsEnv & { CREDENTIAL_ENCRYPTION_KEY?: string },
  account: ProviderAccountInput,
  fetchImpl: typeof fetch,
): Promise<{ id: string }> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_USER_ID) {
    throw new Error("Supabase configuration missing");
  }

  // 校验 provider_key 白名单
  const allowedProviders = listProviders().map((p) => p.id);
  if (!allowedProviders.includes(account.providerKey)) {
    throw new Error(`Invalid provider key: ${account.providerKey}`);
  }

  const headers = createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY);
  headers["Prefer"] = "resolution=merge-duplicates";

  // 1. 写入 provider_accounts
  const accountUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL);
  accountUrl.searchParams.set("on_conflict", "user_id,provider_key,account_label");

  const accountBody = {
    user_id: env.SUPABASE_USER_ID,
    provider_key: account.providerKey,
    account_label: account.accountLabel,
    source_url: account.sourceUrl,
    status: account.status ?? "ready",
    credential_hint: {},
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
    throw new Error(`Failed to upsert provider account: ${accountResponse.status}`);
  }

  // 解析返回的 account id
  const accountRows = (await accountResponse.json().catch(() => [])) as Array<{ id?: string }>;
  const accountId = accountRows[0]?.id ?? "";

  // 2. 如果有 credentials，加密并写入 provider_account_credentials
  if (account.credentials && env.CREDENTIAL_ENCRYPTION_KEY) {
    const encrypted = await encryptCredentialPayload(account.credentials, env.CREDENTIAL_ENCRYPTION_KEY);
    const credUrl = new URL("/rest/v1/provider_account_credentials", env.SUPABASE_URL);

    const credBody = {
      user_id: env.SUPABASE_USER_ID,
      provider_account_id: accountId,
      encrypted_payload: encrypted.encryptedPayload,
      nonce: encrypted.nonce,
      key_version: encrypted.keyVersion,
    };

    const credResponse = await fetchImpl(credUrl, {
      method: "POST",
      headers: {
        ...headers,
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

export async function getActiveProviderAccountConfig(
  env: SettingsEnv & { CREDENTIAL_ENCRYPTION_KEY?: string },
  providerKey: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_USER_ID) {
    return null;
  }

  const headers = createSupabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY);

  // 1. 读取 provider_preferences
  const prefUrl = new URL("/rest/v1/provider_preferences", env.SUPABASE_URL);
  prefUrl.searchParams.set("select", "*");
  prefUrl.searchParams.set("provider_key", `eq.${providerKey}`);
  prefUrl.searchParams.set("user_id", `eq.${env.SUPABASE_USER_ID}`);
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
  accountUrl.searchParams.set("user_id", `eq.${env.SUPABASE_USER_ID}`);

  const accountResponse = await fetchImpl(accountUrl, { headers });
  if (!accountResponse.ok) return null;

  const accountRows = (await accountResponse.json().catch(() => [])) as Array<{
    config?: Record<string, unknown>;
    source_url?: string;
  }>;
  const account = accountRows[0];
  if (!account) return null;

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

// Extended for Task 4

