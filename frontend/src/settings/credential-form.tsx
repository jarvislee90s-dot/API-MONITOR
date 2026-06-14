import { Save } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import type { ProviderAccountInput, ProviderCatalogItem, SafeProviderAccount } from "../api/client";

interface CredentialFormProps {
  provider: ProviderCatalogItem | null;
  account?: SafeProviderAccount | null;
  onSave: (account: ProviderAccountInput) => Promise<void>;
}

function defaultSourceUrl(provider: ProviderCatalogItem | null): string {
  return provider?.sourceUrl ?? "";
}

function credentialFields(providerKey: string | undefined): string[] {
  if (providerKey === "openrouter") return ["apiKey", "endpoint"];
  if (providerKey === "opencode-go") return ["workspaceId", "authCookie"];
  if (providerKey === "xfyun-maas") return ["authCookie", "apiUrl"];
  if (providerKey === "aliyun-bailian") return ["authCookie", "apiUrl"];
  return ["authCookie"];
}

function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    apiKey: "API Key / Cookie",
    endpoint: "endpoint / baseUrl",
    workspaceId: "workspaceId",
    authCookie: "authCookie",
    apiUrl: "endpoint / baseUrl",
  };
  return labels[field] ?? field;
}

const newAccountLabel = "新账号";

export function CredentialForm({ provider, account, onSave }: CredentialFormProps) {
  const fields = useMemo(() => credentialFields(provider?.providerKey), [provider?.providerKey]);
  const [accountLabel, setAccountLabel] = useState(account?.accountLabel ?? newAccountLabel);
  const [sourceUrl, setSourceUrl] = useState(account?.sourceUrl ?? defaultSourceUrl(provider));
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAccountLabel(account?.accountLabel ?? newAccountLabel);
    setSourceUrl(account?.sourceUrl ?? defaultSourceUrl(provider));
    setCredentials({});
  }, [account?.id, account?.accountLabel, account?.sourceUrl, provider?.providerKey, provider?.sourceUrl]);

  if (!provider) {
    return null;
  }
  const currentProvider = provider;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({
        providerKey: currentProvider.providerKey,
        accountLabel,
        sourceUrl,
        credentials: Object.fromEntries(
          fields
            .map((field) => [field, credentials[field]?.trim() ?? ""] as const)
            .filter(([, value]) => value !== ""),
        ),
      });
      setCredentials({});
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="credential-form credential-form--grid" onSubmit={submit}>
      {account ? <div className="credential-form__editing">正在编辑：{account.accountLabel}</div> : null}
      <label>
        <span>账号别名</span>
        <input value={accountLabel} onChange={(event) => setAccountLabel(event.target.value)} />
      </label>
      <label>
        <span>首页显示开关</span>
        <input type="text" value="保存后默认不进入首页" readOnly />
      </label>
      {fields.map((field) => (
        <label key={field}>
          <span>{fieldLabel(field)}</span>
          <input
            aria-label={field}
            value={credentials[field] ?? ""}
            type={field.toLowerCase().includes("cookie") || field.toLowerCase().includes("key") ? "password" : "text"}
            onChange={(event) => setCredentials((current) => ({ ...current, [field]: event.target.value }))}
          />
        </label>
      ))}
      <label>
        <span>原网页</span>
        <input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} />
      </label>
      <label>
        <span>测试连接状态</span>
        <input value="保存后可测试" readOnly />
      </label>
      <div className="credential-form__security">
        <strong>安全提示</strong>
        <span>保存后表单清空；账号卡只展示 credentialHint，网页登录态不保存。</span>
      </div>
      <button type="submit" className="btn btn--primary" disabled={saving}>
        <Save size={16} aria-hidden="true" />
        {saving ? "保存中" : "保存账号"}
      </button>
    </form>
  );
}
