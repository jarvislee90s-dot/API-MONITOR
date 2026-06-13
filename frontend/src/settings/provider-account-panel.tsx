import { CheckCircle2, FlaskConical } from "lucide-react";
import type {
  ProviderAccountInput,
  ProviderCatalogItem,
  ProviderPreference,
  SafeProviderAccount,
} from "../api/client";
import { CredentialForm } from "./credential-form";

interface ProviderAccountPanelProps {
  adminToken: string;
  provider: ProviderCatalogItem | null;
  preference: ProviderPreference | null;
  accounts: SafeProviderAccount[];
  onPreferenceChange: (preference: ProviderPreference) => void;
  onSaveAccount: (account: ProviderAccountInput) => Promise<void>;
  onTestAccount: (accountId: string) => Promise<void>;
}

function formatHint(hint: Record<string, unknown>): string {
  const entries = Object.entries(hint);
  if (entries.length === 0) return "未保存凭据";
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join(" · ");
}

export function ProviderAccountPanel({
  adminToken,
  provider,
  preference,
  accounts,
  onPreferenceChange,
  onSaveAccount,
  onTestAccount,
}: ProviderAccountPanelProps) {
  if (!provider || !preference) {
    return (
      <section className="settings-panel settings-panel--empty">
        <h2>Level 3: 账号配置</h2>
      </section>
    );
  }

  return (
    <section className="settings-panel account-panel">
      <div className="settings-panel__head">
        <div>
          <h2>Level 3: 账号配置</h2>
          <p>{provider.description}</p>
        </div>
        <a className="btn btn--ghost" href={provider.sourceUrl} target="_blank" rel="noreferrer">
          打开看板
        </a>
      </div>

      {!adminToken ? (
        <div className="settings-empty">需要 Admin Token 后才能读取账号和保存配置。</div>
      ) : null}

      <div className="account-list">
        {accounts.length === 0 ? (
          <div className="settings-empty">暂无账号</div>
        ) : (
          accounts.map((account) => (
            <article key={account.id} className="account-item">
              <label className="radio-row">
                <input
                  type="radio"
                  name={`active-${provider.providerKey}`}
                  checked={preference.activeProviderAccountId === account.id}
                  disabled={!adminToken}
                  onChange={() => onPreferenceChange({ ...preference, activeProviderAccountId: account.id })}
                />
                <span>
                  <strong>{account.accountLabel}</strong>
                  <small>{formatHint(account.credentialHint)}</small>
                </span>
              </label>
              <div className="account-item__actions">
                {preference.activeProviderAccountId === account.id ? (
                  <span className="status-pill status-pill--healthy">
                    <CheckCircle2 size={14} aria-hidden="true" />
                    当前账号
                  </span>
                ) : null}
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!adminToken}
                  onClick={() => void onTestAccount(account.id)}
                >
                  <FlaskConical size={15} aria-hidden="true" />
                  测试
                </button>
              </div>
            </article>
          ))
        )}
      </div>

      {adminToken ? <CredentialForm provider={provider} onSave={onSaveAccount} /> : null}
    </section>
  );
}
