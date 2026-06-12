import { Save } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import type { ProviderAccountInput, ProviderCatalogItem } from "../api/client";

interface CredentialFormProps {
  provider: ProviderCatalogItem | null;
  onSave: (account: ProviderAccountInput) => Promise<void>;
}

function defaultSourceUrl(provider: ProviderCatalogItem | null): string {
  return provider?.sourceUrl ?? "";
}

function credentialFields(providerKey: string | undefined): string[] {
  if (providerKey === "openrouter") return ["apiKey"];
  if (providerKey === "opencode-go") return ["workspaceId", "authCookie"];
  if (providerKey === "xfyun-maas") return ["authCookie", "apiUrl"];
  if (providerKey === "aliyun-bailian") return ["authCookie", "apiUrl"];
  return ["authCookie"];
}

export function CredentialForm({ provider, onSave }: CredentialFormProps) {
  const fields = useMemo(() => credentialFields(provider?.providerKey), [provider?.providerKey]);
  const [accountLabel, setAccountLabel] = useState("主账号");
  const [sourceUrl, setSourceUrl] = useState(defaultSourceUrl(provider));
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSourceUrl(defaultSourceUrl(provider));
    setCredentials({});
  }, [provider?.providerKey, provider?.sourceUrl]);

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
    <form className="credential-form" onSubmit={submit}>
      <label>
        <span>账号名称</span>
        <input value={accountLabel} onChange={(event) => setAccountLabel(event.target.value)} />
      </label>
      <label>
        <span>原网页</span>
        <input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} />
      </label>
      {fields.map((field) => (
        <label key={field}>
          <span>{field}</span>
          <input
            value={credentials[field] ?? ""}
            type={field.toLowerCase().includes("cookie") || field.toLowerCase().includes("key") ? "password" : "text"}
            onChange={(event) => setCredentials((current) => ({ ...current, [field]: event.target.value }))}
          />
        </label>
      ))}
      <button type="submit" className="btn btn--primary" disabled={saving}>
        <Save size={16} aria-hidden="true" />
        {saving ? "保存中" : "保存账号"}
      </button>
    </form>
  );
}
