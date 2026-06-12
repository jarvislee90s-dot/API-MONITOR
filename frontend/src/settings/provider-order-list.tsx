import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import type { ProviderCatalogItem, ProviderPreference } from "../api/client";

interface ProviderOrderListProps {
  catalog: ProviderCatalogItem[];
  preferences: ProviderPreference[];
  selectedProviderKey: string | null;
  onSelectProvider: (providerKey: string) => void;
  onChange: (preferences: ProviderPreference[]) => void;
}

function providerName(catalog: ProviderCatalogItem[], providerKey: string): string {
  return catalog.find((item) => item.providerKey === providerKey)?.providerName ?? providerKey;
}

function reorder<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  if (!item) return items;
  next.splice(toIndex, 0, item);
  return next;
}

export function ProviderOrderList({
  catalog,
  preferences,
  selectedProviderKey,
  onSelectProvider,
  onChange,
}: ProviderOrderListProps) {
  const ordered = [...preferences].sort((left, right) => left.displayOrder - right.displayOrder);

  function updatePreference(providerKey: string, patch: Partial<ProviderPreference>) {
    onChange(
      ordered.map((preference) =>
        preference.providerKey === providerKey ? { ...preference, ...patch } : preference,
      ),
    );
  }

  function moveProvider(fromIndex: number, toIndex: number) {
    onChange(
      reorder(ordered, fromIndex, toIndex).map((preference, index) => ({
        ...preference,
        displayOrder: index + 1,
      })),
    );
  }

  return (
    <section className="settings-panel" aria-label="供应商顺序">
      <div className="settings-panel__head">
        <h2>供应商</h2>
      </div>
      <div className="provider-order-list">
        {ordered.map((preference, index) => (
          <div
            key={preference.providerKey}
            className={`provider-order-item ${selectedProviderKey === preference.providerKey ? "is-selected" : ""}`}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData("text/plain", String(index));
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const fromIndex = Number(event.dataTransfer.getData("text/plain"));
              if (Number.isInteger(fromIndex)) moveProvider(fromIndex, index);
            }}
          >
            <button
              type="button"
              className="provider-order-item__select"
              onClick={() => onSelectProvider(preference.providerKey)}
            >
              <GripVertical size={16} aria-hidden="true" />
              <span className="provider-order-item__name">{providerName(catalog, preference.providerKey)}</span>
            </button>
            <label className="toggle">
              <input
                type="checkbox"
                checked={preference.enabled}
                onChange={(event) => updatePreference(preference.providerKey, { enabled: event.target.checked })}
              />
              <span>{preference.enabled ? "启用" : "隐藏"}</span>
            </label>
            <div className="provider-order-item__moves" aria-label={`${providerName(catalog, preference.providerKey)} 排序`}>
              <button
                type="button"
                className="icon-btn"
                aria-label={`${providerName(catalog, preference.providerKey)} 上移`}
                disabled={index === 0}
                onClick={() => moveProvider(index, index - 1)}
              >
                <ArrowUp size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`${providerName(catalog, preference.providerKey)} 下移`}
                disabled={index === ordered.length - 1}
                onClick={() => moveProvider(index, index + 1)}
              >
                <ArrowDown size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
