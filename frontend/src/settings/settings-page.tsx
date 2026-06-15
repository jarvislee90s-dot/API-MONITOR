import { ArrowLeft, GripVertical, Save, Eye, EyeOff } from "lucide-react";
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
import { getAccountStatusLabel, getStatusTone } from "./account-status-labels";
import { formatPreviewValue } from "./credential-preview";

type SettingsApi = Pick<
  ReturnType<typeof createApiClient>,
  | "getProviderSettings"
  | "saveProviderPreferences"
  | "saveProviderAccount"
  | "updateProviderAccount"
  | "deleteProviderAccount"
  | "testProviderAccount"
  | "updateProviderAccountDisplay"
>;

interface SettingsPageProps {
  api: SettingsApi;
  dashboard?: DashboardSnapshot;
  onBack: () => void;
}


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

function formatCredentialPreview(account: SafeProviderAccount): string {
  const [key, value] = Object.entries(account.credentialHint)[0] ?? [];
  if (!key || value == null) return "凭据：未保存";
  const label = key.toLowerCase().includes("key") ? "API Key" : key;
  return `${label}: ${formatPreviewValue(String(value))}`;
}

export function SettingsPage({ api, dashboard, onBack }: SettingsPageProps) {
  const [catalog, setCatalog] = useState<ProviderCatalogItem[]>(PUBLIC_PROVIDER_CATALOG);
  const [preferences, setPreferences] = useState<ProviderPreference[]>(() => createDefaultPreferences(PUBLIC_PROVIDER_CATALOG));
  const [accounts, setAccounts] = useState<SafeProviderAccount[]>(() => createAccountsFromDashboard(dashboard));
  const [selectedProviderKey, setSelectedProviderKey] = useState<string | null>(PUBLIC_PROVIDER_CATALOG[0]?.providerKey ?? null);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [isAddingAccount, setIsAddingAccount] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [draggingAccountId, setDraggingAccountId] = useState<string | null>(null);
  const [dragOverAccountId, setDragOverAccountId] = useState<string | null>(null);
  const [draggingProviderKey, setDraggingProviderKey] = useState<string | null>(null);
  const [dragOverProviderKey, setDragOverProviderKey] = useState<string | null>(null);
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

  const editingAccount = useMemo(() => {
    if (!editingAccountId) return null;
    return selectedAccounts.find((account) => account.id === editingAccountId) ?? null;
  }, [editingAccountId, selectedAccounts]);

  const focusCredentialForm = useCallback(() => {
    const form = document.querySelector(".credential-form");
    if (form) {
      form.scrollIntoView({ behavior: "smooth", block: "center" });
      (form.querySelector("input") as HTMLInputElement | null)?.focus();
    }
  }, []);

  useEffect(() => {
    setEditingAccountId((current) => {
      if (isAddingAccount) return null;
      if (current && selectedAccounts.some((account) => account.id === current)) return current;
      return selectedPreference?.activeProviderAccountId ?? selectedAccounts[0]?.id ?? null;
    });
  }, [isAddingAccount, selectedPreference?.activeProviderAccountId, selectedAccounts]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setMessage("正在读取配置。");
    try {
      const settings = await api.getProviderSettings();
      const nextPreferences = createPreferences(settings);
      setCatalog(settings.catalog);
      setPreferences(nextPreferences);
      setAccounts(settings.accounts);
      setSelectedProviderKey((current) => current ?? nextPreferences[0]?.providerKey ?? settings.catalog[0]?.providerKey ?? null);
      setMessage("配置已同步。");
    } catch (error) {
      setCatalog(PUBLIC_PROVIDER_CATALOG);
      setPreferences(createDefaultPreferences(PUBLIC_PROVIDER_CATALOG));
      setAccounts(dashboardAccounts);
      setSelectedProviderKey((current) => current ?? dashboardAccounts[0]?.providerKey ?? PUBLIC_PROVIDER_CATALOG[0]?.providerKey ?? null);
      setMessage(error instanceof Error ? error.message : "读取配置失败。");
    } finally {
      setLoading(false);
    }
  }, [api, dashboardAccounts]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  async function savePreferences() {
    setLoading(true);
    try {
      const normalized = preferences.map((preference, index) => ({
        ...preference,
        displayOrder: index + 1,
      }));
      await api.saveProviderPreferences(normalized);
      setPreferences(normalized);
      setMessage("配置已保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存配置失败。");
    } finally {
      setLoading(false);
    }
  }

  async function saveAccount(account: ProviderAccountInput) {
    try {
      if (account.id) {
        await api.updateProviderAccount(account.id, account);
      } else {
        await api.saveProviderAccount(account);
      }
      await loadSettings();
      setIsAddingAccount(false);
      setMessage("账号已保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存账号失败。");
    }
  }

  async function deleteAccount(accountId: string) {
    await api.deleteProviderAccount(accountId);
    setAccounts((current) => current.filter((account) => account.id !== accountId));
    setPreferences((current) =>
      current.map((preference) =>
        preference.activeProviderAccountId === accountId
          ? { ...preference, activeProviderAccountId: null }
          : preference,
      ),
    );
    setEditingAccountId((current) => (current === accountId ? null : current));
    setMessage("账号已删除。");
  }

  async function testAccount(accountId: string) {
    const result = await api.testProviderAccount(accountId);
    setMessage(result.summary);
  }

  async function toggleHomepageDisplay(accountId: string, enabled: boolean) {
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;
    const result = await api.updateProviderAccountDisplay(accountId, {
      homepageEnabled: enabled,
      homepageOrder: enabled ? account.homepageOrder : 100,
    });
    setAccounts((current) =>
      current.map((a) =>
        a.id === accountId ? { ...a, homepageEnabled: result.homepageEnabled, homepageOrder: result.homepageOrder } : a,
      ),
    );
  }

  async function reorderHomepageAccount(draggedAccountId: string, targetAccountId: string) {
    if (draggedAccountId === targetAccountId) return;
    const draggedAccount = homepageAccounts.find((account) => account.id === draggedAccountId);
    const targetAccount = homepageAccounts.find((account) => account.id === targetAccountId);
    if (!draggedAccount || !targetAccount) return;

    const updatedDraggedAccount = await api.updateProviderAccountDisplay(draggedAccount.id, {
      homepageEnabled: true,
      homepageOrder: targetAccount.homepageOrder,
    });
    const updatedTargetAccount = await api.updateProviderAccountDisplay(targetAccount.id, {
      homepageEnabled: true,
      homepageOrder: draggedAccount.homepageOrder,
    });

    setAccounts((current) =>
      current.map((item) => {
        if (item.id === updatedDraggedAccount.id) {
          return {
            ...item,
            homepageEnabled: updatedDraggedAccount.homepageEnabled,
            homepageOrder: updatedDraggedAccount.homepageOrder,
          };
        }
        if (item.id === updatedTargetAccount.id) {
          return {
            ...item,
            homepageEnabled: updatedTargetAccount.homepageEnabled,
            homepageOrder: updatedTargetAccount.homepageOrder,
          };
        }
        return item;
      }),
    );
  }

  function reorderProvider(draggedProviderKey: string, targetProviderKey: string) {
    if (!draggedProviderKey || draggedProviderKey === targetProviderKey) return;
    setPreferences((current) => {
      const draggedIndex = current.findIndex((preference) => preference.providerKey === draggedProviderKey);
      const targetIndex = current.findIndex((preference) => preference.providerKey === targetProviderKey);
      if (draggedIndex < 0 || targetIndex < 0) return current;

      const next = [...current];
      const [draggedPreference] = next.splice(draggedIndex, 1);
      if (!draggedPreference) return current;
      next.splice(targetIndex, 0, draggedPreference);
      return next.map((preference, index) => ({ ...preference, displayOrder: index + 1 }));
    });
  }

  function updatePreference(nextPreference: ProviderPreference) {
    setPreferences((current) =>
      current.map((preference) =>
        preference.providerKey === nextPreference.providerKey ? nextPreference : preference,
      ),
    );
  }

  function editAccount(accountId: string) {
    setIsAddingAccount(false);
    setEditingAccountId(accountId);
    window.requestAnimationFrame(focusCredentialForm);
  }

  function addAccount() {
    setIsAddingAccount(true);
    setEditingAccountId(null);
    window.requestAnimationFrame(focusCredentialForm);
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
            <h1>模型供应商与账号配置</h1>
          </div>
          <button type="button" className="btn btn--primary" onClick={() => void savePreferences()} disabled={loading}>
            <Save size={16} aria-hidden="true" />
            保存配置
          </button>
        </header>

        {message ? <div className="sync-banner sync-banner--ready">{message}</div> : null}

        <div className="settings-workbench">
          <ProviderGallery
            catalog={catalog}
            preferences={preferences}
            accounts={accounts}
            selectedProviderKey={selectedProviderKey}
            draggingProviderKey={draggingProviderKey}
            dragOverProviderKey={dragOverProviderKey}
            onProviderDragStart={setDraggingProviderKey}
            onProviderDragOver={setDragOverProviderKey}
            onProviderDragLeave={(providerKey) => {
              setDragOverProviderKey((current) => (current === providerKey ? null : current));
            }}
            onProviderDrop={(draggedProviderKey, targetProviderKey) => {
              reorderProvider(draggedProviderKey, targetProviderKey);
              setDraggingProviderKey(null);
              setDragOverProviderKey(null);
            }}
            onProviderDragEnd={() => {
              setDraggingProviderKey(null);
              setDragOverProviderKey(null);
            }}
            onSelectProvider={(providerKey) => {
              setIsAddingAccount(false);
              setSelectedProviderKey(providerKey);
            }}
          />
          <section className="settings-panel homepage-account-panel" aria-label="首页显示账号">
            <div className="settings-panel__head">
              <div>
                <h2>Level 2: {selectedProvider?.providerName ?? "当前供应商"} 的账号</h2>
                <p>已配置账号统一显示在该供应商下；停用只影响首页，不删除配置。</p>
              </div>
            </div>
            <div className="homepage-account-list">
              {homepageAccounts.length === 0 ? (
                <div className="settings-empty">暂无首页显示账号</div>
              ) : (
                homepageAccounts.map((account, index) => (
                  <article
                    key={account.id}
                    draggable
                    className={`account-display-card account-display-card--enabled ${
                      selectedPreference?.activeProviderAccountId === account.id ? "account-display-card--active" : ""
                    } ${draggingAccountId === account.id ? "account-display-card--dragging" : ""} ${
                      dragOverAccountId === account.id && draggingAccountId !== account.id
                        ? "account-display-card--drop-target"
                        : ""
                    }`}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", account.id);
                      setDraggingAccountId(account.id);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDragOverAccountId(account.id);
                    }}
                    onDragLeave={() => {
                      setDragOverAccountId((current) => (current === account.id ? null : current));
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const draggedId = event.dataTransfer.getData("text/plain");
                      setDraggingAccountId(null);
                      setDragOverAccountId(null);
                      void reorderHomepageAccount(draggedId, account.id);
                    }}
                    onDragEnd={() => {
                      setDraggingAccountId(null);
                      setDragOverAccountId(null);
                    }}
                  >
                    <div className="account-display-card__main">
                      <GripVertical className="account-display-card__drag-icon" size={16} aria-hidden="true" />
                      <span>
                        <strong>{account.accountLabel}</strong>
                        <small>{formatCredentialPreview(account)}</small>
                      </span>
                      <span className="account-role-badge">{index === 0 ? "主账号" : "备用账号"}</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn--ghost account-display-card__edit"
                      aria-label={`编辑账号：${account.accountLabel}`}
                      onClick={() => editAccount(account.id)}
                    >
                      编辑
                    </button>
                    <p>{account.lastTestSummary ?? getAccountStatusLabel(account)}</p>
                    <div className="account-display-card__bars" aria-hidden="true">
                      <span />
                      <span />
                    </div>
                    <span className={`status-badge status-badge--${getStatusTone(account)}`}>
                      {getAccountStatusLabel(account)}
                    </span>
                    <div className="homepage-account-item__actions">
                      <button
                        type="button"
                        className="btn btn--ghost"
                        aria-label={`停用首页显示：${account.accountLabel}`}
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
                  <article key={account.id} className="account-display-card account-display-card--disabled">
                    <div className="account-display-card__main">
                      <span>
                        <strong>{account.accountLabel}</strong>
                        <small>{formatCredentialPreview(account)}</small>
                      </span>
                      <span className="status-badge status-badge--error">停用</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn--ghost account-display-card__edit"
                      aria-label={`编辑账号：${account.accountLabel}`}
                      onClick={() => editAccount(account.id)}
                    >
                      编辑
                    </button>
                    <p>{account.lastTestSummary ?? getAccountStatusLabel(account)}</p>
                    <div className="account-display-card__bars" aria-hidden="true">
                      <span />
                      <span />
                    </div>
                    <span className={`status-badge status-badge--${getStatusTone(account)}`}>
                      {getAccountStatusLabel(account)}
                    </span>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      aria-label={`启用首页显示：${account.accountLabel}`}
                      onClick={() => void toggleHomepageDisplay(account.id, true)}
                    >
                      <Eye size={15} aria-hidden="true" />
                      启用
                    </button>
                  </article>
                ))}
              <button
                type="button"
                className="btn btn--ghost add-account-btn"
                onClick={addAccount}
              >
                <strong>+ 新增账号</strong>
                <span>新增后默认不进首页，测试通过后可启用。</span>
              </button>
            </div>
          </section>
          <ProviderAccountPanel
            provider={selectedProvider}
            preference={selectedPreference}
            accounts={selectedAccounts}
            editingAccount={editingAccount}
            onPreferenceChange={updatePreference}
            onSaveAccount={saveAccount}
            onTestAccount={testAccount}
            onDeleteAccount={deleteAccount}
          />
        </div>
      </div>
    </main>
  );
}
