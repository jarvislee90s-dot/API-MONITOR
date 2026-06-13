import { CheckCircle2, CircleDashed, ExternalLink } from "lucide-react";
import type { ProviderCatalogItem, ProviderPreference, SafeProviderAccount } from "../api/client";

interface ProviderGalleryProps {
  catalog: ProviderCatalogItem[];
  preferences: ProviderPreference[];
  accounts: SafeProviderAccount[];
  selectedProviderKey: string | null;
  onSelectProvider: (providerKey: string) => void;
}

// 入口型 provider 判断：阿里云百炼默认作为原网页入口，不主动抓取数据
// 如果新增其他入口型 provider，需要在此数组中添加 providerKey
const ENTRY_PROVIDERS = ["aliyun-bailian"];

function providerState(providerKey: string, accounts: SafeProviderAccount[]): "configured" | "entry" | "configurable" {
  if (ENTRY_PROVIDERS.includes(providerKey)) return "entry";
  return accounts.some((account) => account.providerKey === providerKey) ? "configured" : "configurable";
}

function stateLabel(state: "configured" | "entry" | "configurable"): string {
  if (state === "configured") return "已配置";
  if (state === "entry") return "入口型";
  return "可配置";
}

export function ProviderGallery({
  catalog,
  preferences,
  accounts,
  selectedProviderKey,
  onSelectProvider,
}: ProviderGalleryProps) {
  const preferenceMap = new Map(preferences.map((preference) => [preference.providerKey, preference]));

  return (
    <section className="settings-panel provider-gallery-panel" aria-label="供应商卡片池">
      <div className="settings-panel__head">
        <div>
          <h2>Level 1: 供应商</h2>
          <p>选择供应商后，在下方展开账号和配置。停用不会删除已有配置。</p>
        </div>
      </div>
      <div className="provider-gallery">
        {catalog.map((provider) => {
          const state = providerState(provider.providerKey, accounts);
          const enabled = preferenceMap.get(provider.providerKey)?.enabled ?? true;
          const Icon = state === "configured" ? CheckCircle2 : state === "entry" ? ExternalLink : CircleDashed;

          return (
            <button
              key={provider.providerKey}
              type="button"
              className={`provider-gallery-card ${selectedProviderKey === provider.providerKey ? "is-selected" : ""}`}
              aria-label={`编辑 ${provider.providerName}`}
              onClick={() => onSelectProvider(provider.providerKey)}
            >
              <Icon size={18} aria-hidden="true" />
              <strong>{provider.providerName}</strong>
              <span>{stateLabel(state)}</span>
              <small>{enabled ? "供应商启用" : "供应商停用"}</small>
            </button>
          );
        })}
      </div>
    </section>
  );
}
