import { CheckCircle2, CircleDashed, ExternalLink, Eye, EyeOff } from "lucide-react";
import type { ProviderCatalogItem, ProviderPreference, SafeProviderAccount } from "../api/client";

interface ProviderGalleryProps {
  catalog: ProviderCatalogItem[];
  preferences: ProviderPreference[];
  accounts: SafeProviderAccount[];
  selectedProviderKey: string | null;
  onSelectProvider: (providerKey: string) => void;
  onToggleProvider: (providerKey: string, enabled: boolean) => void;
  draggingProviderKey: string | null;
  dragOverProviderKey: string | null;
  onProviderDragStart: (providerKey: string) => void;
  onProviderDragOver: (providerKey: string) => void;
  onProviderDragLeave: (providerKey: string) => void;
  onProviderDrop: (draggedProviderKey: string, targetProviderKey: string) => void;
  onProviderDragEnd: () => void;
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
  onToggleProvider,
  draggingProviderKey,
  dragOverProviderKey,
  onProviderDragStart,
  onProviderDragOver,
  onProviderDragLeave,
  onProviderDrop,
  onProviderDragEnd,
}: ProviderGalleryProps) {
  const preferenceMap = new Map(preferences.map((preference) => [preference.providerKey, preference]));
  const catalogMap = new Map(catalog.map((provider) => [provider.providerKey, provider]));
  const orderedCatalog = [
    ...preferences
      .slice()
      .sort((left, right) => left.displayOrder - right.displayOrder)
      .map((preference) => catalogMap.get(preference.providerKey))
      .filter((provider): provider is ProviderCatalogItem => Boolean(provider)),
    ...catalog.filter((provider) => !preferenceMap.has(provider.providerKey)),
  ];

  return (
    <section className="settings-panel provider-gallery-panel" aria-label="供应商卡片池">
      <div className="settings-panel__head">
        <div>
          <h2>Level 1: 供应商</h2>
          <p>选择供应商后，在下方展开账号和配置。停用不会删除已有配置。</p>
        </div>
      </div>
      <div className="provider-gallery">
        {orderedCatalog.map((provider) => {
          const state = providerState(provider.providerKey, accounts);
          const enabled = preferenceMap.get(provider.providerKey)?.enabled ?? true;
          const Icon = state === "configured" ? CheckCircle2 : state === "entry" ? ExternalLink : CircleDashed;

          return (
            <div
              key={provider.providerKey}
              className={`provider-gallery-card ${selectedProviderKey === provider.providerKey ? "is-selected" : ""} ${
                draggingProviderKey === provider.providerKey ? "provider-gallery-card--dragging" : ""
              } ${
                enabled ? "" : "provider-gallery-card--disabled"
              } ${
                dragOverProviderKey === provider.providerKey && draggingProviderKey !== provider.providerKey
                  ? "provider-gallery-card--drop-target"
                  : ""
              }`}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", provider.providerKey);
                onProviderDragStart(provider.providerKey);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                onProviderDragOver(provider.providerKey);
              }}
              onDragLeave={() => onProviderDragLeave(provider.providerKey)}
              onDrop={(event) => {
                event.preventDefault();
                onProviderDrop(event.dataTransfer.getData("text/plain"), provider.providerKey);
              }}
              onDragEnd={onProviderDragEnd}
            >
              <button
                type="button"
                className="provider-gallery-card__select"
                aria-label={`编辑 ${provider.providerName}`}
                onClick={() => onSelectProvider(provider.providerKey)}
              >
                <Icon size={18} aria-hidden="true" />
                <strong>{provider.providerName}</strong>
                <span>{stateLabel(state)}</span>
              </button>
              <div className="provider-gallery-card__footer">
                <small>{enabled ? "供应商启用" : "供应商停用"}</small>
                <button
                  type="button"
                  className="provider-gallery-card__toggle"
                  aria-label={`${enabled ? "停用" : "启用"}供应商：${provider.providerName}`}
                  onClick={() => onToggleProvider(provider.providerKey, !enabled)}
                >
                  {enabled ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
                  {enabled ? "停用" : "启用"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
