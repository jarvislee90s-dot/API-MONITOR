import { ArrowLeft, ChevronDown, ChevronUp, KeyRound, Save, Eye, EyeOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ProviderAccountInput,
  ProviderCatalogItem,
  ProviderPreference,
  ProviderSettingsPayload,
  SafeProviderAccount,
  DashboardSnapshot,
  createApiClient,
} from "../api/client";
import { ProviderGallery } from "./provider-gallery";
import { ProviderAccountPanel } from "./provider-account-panel";
import { PUBLIC_PROVIDER_CATALOG } from "./provider-catalog";

type SettingsApi = Pick<
  ReturnType<typeof createApiClient>,
  | "getProviderSettings"
  | "saveProviderPreferences"
  | "saveProviderAccount"
  | "testProviderAccount"
  | "updateProviderAccountDisplay"
>;

interface SettingsPageProps {
  api: SettingsApi;
  dashboard?: DashboardSnapshot;
  onBack: () => void;
}

const tokenStorageKey = "api-monitor-admin-token";

function createDefaultPreferences(catalog: ProviderCatalogItem[]): ProviderPreference[] {
  return catalog.map((provider, index) => ({
    providerKey: provider.providerKey,
    enabled: true,
    displayOrder: index + 1,
    activeProviderAccountId: null,
  }));
}

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

function normalizeDashboardProviderKey(providerId: string): string {
  if (providerId === "xfyun") return "xfyun-maas";
  return providerId;
}

function createAccountsFromDashboard(dashboard?: DashboardSnapshot): SafeProviderAccount[] {
  if (!dashboard) return [];

  return dashboard.platforms.flatMap((platform, platformIndex) => {
    const providerKey = normalizeDashboardProviderKey(platform.id);
    const platformAccounts =
      platform.accounts.length > 0
        ? platform.accounts
        : [
            {
              id: `${providerKey}:dashboard`,
              label: platform.name,
              sourceUrl: platform.sourceUrl,
              status: platform.status,
              loginState: platform.loginState,
              summary: platform.summary,
            },
          ];

    return platformAccounts.map((account, accountIndex) => ({
      id: account.id,
      providerKey,
      accountLabel: account.label,
      sourceUrl: account.sourceUrl,
      status: account.status,
      statusMessage: account.loginState,
      credentialHint: {},
      homepageEnabled: true,
      homepageOrder: platformIndex * 100 + accountIndex + 1,
      lastTestSummary: account.summary,
    }));
  });
}

export function SettingsPage({ api, dashboard, onBack }: SettingsPageProps) {
  const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem(tokenStorageKey) ?? "");
  const [tokenDraft, setTokenDraft] = useState(adminToken);
  const [catalog, setCatalog] = useState<ProviderCatalogItem[]>(PUBLIC_PROVIDER_CATALOG);
  const [preferences, setPreferences] = useState<ProviderPreference[]>(() => createDefaultPreferences(PUBLIC_PROVIDER_CATALOG));
  const [accounts, setAccounts] = useState<SafeProviderAccount[]>(() => createAccountsFromDashboard(dashboard));
  const [selectedProviderKey, setSelectedProviderKey] = useState<string | null>(PUBLIC_PROVIDER_CATALOG[0]?.providerKey ?? null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const dashboardAccounts = useMemo(() => createAccountsFromDashboard(dashboard), [dashboard]);

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

  const homepageAccounts = useMemo(() => {
    return selectedAccounts
      .filter((account) => account.homepageEnabled)
      .sort((left, right) => left.homepageOrder - right.homepageOrder);
  }, [selectedAccounts]);

  const loadSettings = useCallback(async () => {
    if (!adminToken) {
      setCatalog(PUBLIC_PROVIDER_CATALOG);
      setPreferences(createDefaultPreferences(PUBLIC_PROVIDER_CATALOG));
      setAccounts(dashboardAccounts);
      setSelectedProviderKey((current) => current ?? dashboardAccounts[0]?.providerKey ?? PUBLIC_PROVIDER_CATALOG[0]?.providerKey ?? null);
      setMessage(null);
      return;
    }
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
  }, [adminToken, api, dashboardAccounts]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  function saveToken() {
    const nextToken = tokenDraft.trim();
    sessionStorage.setItem(tokenStorageKey, nextToken);
    setTokenDraft(nextToken);
    if (nextToken === adminToken) {
      void loadSettings();
      return;
    }
    setAdminToken(nextToken);
  }

  async function savePreferences() {
    if (!adminToken) return;
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
    if (!adminToken) return;
    await api.saveProviderAccount(adminToken, account);
    await loadSettings();
    setMessage("账号已保存。");
  }

  async function testAccount(accountId: string) {
    if (!adminToken) return;
    const result = await api.testProviderAccount(adminToken, accountId);
    setMessage(result.summary);
  }

  async function toggleHomepageDisplay(accountId: string, enabled: boolean) {
    if (!adminToken) return;
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;
    const result = await api.updateProviderAccountDisplay(adminToken, accountId, {
      homepageEnabled: enabled,
      homepageOrder: enabled ? account.homepageOrder : 100,
    });
    setAccounts((current) =>
      current.map((a) =>
        a.id === accountId ? { ...a, homepageEnabled: result.homepageEnabled, homepageOrder: result.homepageOrder } : a,
      ),
    );
  }

  async function moveHomepageAccount(accountId: string, direction: "up" | "down") {
    if (!adminToken) return;
    const currentIndex = homepageAccounts.findIndex((account) => account.id === accountId);
    const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    const account = homepageAccounts[currentIndex];
    const targetAccount = homepageAccounts[targetIndex];
    if (!account || !targetAccount) return;

    const updatedAccount = await api.updateProviderAccountDisplay(adminToken, account.id, {
      homepageEnabled: true,
      homepageOrder: targetAccount.homepageOrder,
    });
    const updatedTargetAccount = await api.updateProviderAccountDisplay(adminToken, targetAccount.id, {
      homepageEnabled: true,
      homepageOrder: account.homepageOrder,
    });

    setAccounts((current) =>
      current.map((item) => {
        if (item.id === updatedAccount.id) {
          return { ...item, homepageEnabled: updatedAccount.homepageEnabled, homepageOrder: updatedAccount.homepageOrder };
        }
        if (item.id === updatedTargetAccount.id) {
          return { ...item, homepageEnabled: updatedTargetAccount.homepageEnabled, homepageOrder: updatedTargetAccount.homepageOrder };
        }
        return item;
      }),
    );
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
            <h1>第三版：多层展开配置模型</h1>
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

        <div className="settings-workbench">
          <ProviderGallery
            catalog={catalog}
            preferences={preferences}
            accounts={accounts}
            selectedProviderKey={selectedProviderKey}
            onSelectProvider={setSelectedProviderKey}
          />
          <section className="settings-panel homepage-account-panel" aria-label="首页显示账号">
            <div className="settings-panel__head">
              <div>
                <h2>Level 2: 当前供应商的账号</h2>
                <p>{selectedProvider?.providerName ?? "当前供应商"}：选择要在首页大卡片内显示的账号，停用不会删除配置。</p>
              </div>
            </div>
            <div className="homepage-account-list">
              {homepageAccounts.length === 0 ? (
                <div className="settings-empty">暂无首页显示账号</div>
              ) : (
                homepageAccounts.map((account, index) => (
                  <article key={account.id} className="homepage-account-item is-enabled">
                    <span>
                      <strong>{account.accountLabel}</strong>
                      <small>{account.lastTestSummary ?? "未测试"}</small>
                    </span>
                    <div className="homepage-account-item__actions">
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`上移首页显示：${account.accountLabel}`}
                        disabled={!adminToken || index === 0}
                        onClick={() => void moveHomepageAccount(account.id, "up")}
                      >
                        <ChevronUp size={15} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`下移首页显示：${account.accountLabel}`}
                        disabled={!adminToken || index === homepageAccounts.length - 1}
                        onClick={() => void moveHomepageAccount(account.id, "down")}
                      >
                        <ChevronDown size={15} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        aria-label={`停用首页显示：${account.accountLabel}`}
                        disabled={!adminToken}
                        onClick={() => void toggleHomepageDisplay(account.id, false)}
                      >
                        <EyeOff size={15} aria-hidden="true" />
                        停用
                      </button>
                    </div>
                  </article>
                ))
              )}
              {selectedAccounts
                .filter((account) => !account.homepageEnabled)
                .map((account) => (
                  <article key={account.id} className="homepage-account-item">
                    <span>
                      <strong>{account.accountLabel}</strong>
                      <small>{account.lastTestSummary ?? "未测试"}</small>
                    </span>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      aria-label={`启用首页显示：${account.accountLabel}`}
                      disabled={!adminToken}
                      onClick={() => void toggleHomepageDisplay(account.id, true)}
                    >
                      <Eye size={15} aria-hidden="true" />
                      启用
                    </button>
                  </article>
                ))}
            </div>
          </section>
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
