import { ArrowLeft, KeyRound, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ProviderAccountInput,
  ProviderCatalogItem,
  ProviderPreference,
  ProviderSettingsPayload,
  SafeProviderAccount,
  createApiClient,
} from "../api/client";
import { ProviderAccountPanel } from "./provider-account-panel";
import { ProviderOrderList } from "./provider-order-list";

type SettingsApi = Pick<
  ReturnType<typeof createApiClient>,
  "getProviderSettings" | "saveProviderPreferences" | "saveProviderAccount" | "testProviderAccount"
>;

interface SettingsPageProps {
  api: SettingsApi;
  onBack: () => void;
}

const tokenStorageKey = "api-monitor-admin-token";

function createPreferences(settings: ProviderSettingsPayload): ProviderPreference[] {
  const preferenceMap = new Map(settings.preferences.map((preference) => [preference.providerKey, preference]));
  return settings.catalog
    .map((provider, index) => {
      return (
        preferenceMap.get(provider.providerKey) ?? {
          providerKey: provider.providerKey,
          enabled: true,
          displayOrder: index + 1,
          activeProviderAccountId: null,
        }
      );
    })
    .sort((left, right) => left.displayOrder - right.displayOrder)
    .map((preference, index) => ({ ...preference, displayOrder: index + 1 }));
}

export function SettingsPage({ api, onBack }: SettingsPageProps) {
  const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem(tokenStorageKey) ?? "");
  const [tokenDraft, setTokenDraft] = useState(adminToken);
  const [catalog, setCatalog] = useState<ProviderCatalogItem[]>([]);
  const [preferences, setPreferences] = useState<ProviderPreference[]>([]);
  const [accounts, setAccounts] = useState<SafeProviderAccount[]>([]);
  const [selectedProviderKey, setSelectedProviderKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const selectedProvider = useMemo(() => {
    return catalog.find((provider) => provider.providerKey === selectedProviderKey) ?? catalog[0] ?? null;
  }, [catalog, selectedProviderKey]);

  const selectedPreference = useMemo(() => {
    if (!selectedProvider) return null;
    return preferences.find((preference) => preference.providerKey === selectedProvider.providerKey) ?? null;
  }, [preferences, selectedProvider]);

  const selectedAccounts = useMemo(() => {
    if (!selectedProvider) return [];
    return accounts.filter((account) => account.providerKey === selectedProvider.providerKey);
  }, [accounts, selectedProvider]);

  const loadSettings = useCallback(async () => {
    if (!adminToken) return;
    setLoading(true);
    setMessage("正在读取配置。");
    try {
      const settings = await api.getProviderSettings(adminToken);
      const nextPreferences = createPreferences(settings);
      setCatalog(settings.catalog);
      setPreferences(nextPreferences);
      setAccounts(settings.accounts);
      setSelectedProviderKey((current) => current ?? nextPreferences[0]?.providerKey ?? settings.catalog[0]?.providerKey ?? null);
      setMessage("配置已同步。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "读取配置失败。");
    } finally {
      setLoading(false);
    }
  }, [adminToken, api]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  function saveToken() {
    sessionStorage.setItem(tokenStorageKey, tokenDraft);
    setAdminToken(tokenDraft);
  }

  async function savePreferences() {
    setLoading(true);
    try {
      const normalized = preferences.map((preference, index) => ({
        ...preference,
        displayOrder: index + 1,
      }));
      await api.saveProviderPreferences(adminToken, normalized);
      setPreferences(normalized);
      setMessage("配置已保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存配置失败。");
    } finally {
      setLoading(false);
    }
  }

  async function saveAccount(account: ProviderAccountInput) {
    await api.saveProviderAccount(adminToken, account);
    await loadSettings();
  }

  async function testAccount(accountId: string) {
    const result = await api.testProviderAccount(adminToken, accountId);
    setMessage(result.summary);
  }

  function updatePreference(nextPreference: ProviderPreference) {
    setPreferences((current) =>
      current.map((preference) =>
        preference.providerKey === nextPreference.providerKey ? nextPreference : preference,
      ),
    );
  }

  return (
    <main className="app-shell settings-shell">
      <div className="app-shell__inner">
        <header className="settings-header">
          <button type="button" className="btn btn--ghost" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden="true" />
            返回
          </button>
          <div>
            <p className="kicker">Settings</p>
            <h1>供应商配置</h1>
          </div>
          <button type="button" className="btn btn--primary" onClick={() => void savePreferences()} disabled={!adminToken || loading}>
            <Save size={16} aria-hidden="true" />
            保存配置
          </button>
        </header>

        <section className="token-panel">
          <label>
            <KeyRound size={16} aria-hidden="true" />
            <span>Admin Token</span>
            <input
              type="password"
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
            />
          </label>
          <button type="button" className="btn btn--ghost" onClick={saveToken}>
            保存 Token
          </button>
        </section>

        {message ? <div className="sync-banner sync-banner--ready">{message}</div> : null}

        <div className="settings-grid">
          <ProviderOrderList
            catalog={catalog}
            preferences={preferences}
            selectedProviderKey={selectedProvider?.providerKey ?? null}
            onSelectProvider={setSelectedProviderKey}
            onChange={setPreferences}
          />
          <ProviderAccountPanel
            adminToken={adminToken}
            provider={selectedProvider}
            preference={selectedPreference}
            accounts={selectedAccounts}
            onPreferenceChange={updatePreference}
            onSaveAccount={saveAccount}
            onTestAccount={testAccount}
          />
        </div>
      </div>
    </main>
  );
}
