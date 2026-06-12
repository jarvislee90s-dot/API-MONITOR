import type {
  ProviderDefinition,
  ProviderFetchInput,
  ProviderFetchResult,
  ProviderId,
  ProviderSnapshot,
} from "../types";

export type { ProviderDefinition, ProviderFetchInput, ProviderFetchResult, ProviderId, ProviderSnapshot };

export function createSnapshot(base: ProviderSnapshot, patch: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    ...base,
    ...patch,
    windows: patch.windows ?? base.windows,
    metrics: patch.metrics ?? base.metrics,
    meta: patch.meta ?? base.meta,
  };
}

export function createResult(snapshot: ProviderSnapshot, warnings: string[] = []): ProviderFetchResult {
  return { snapshot, warnings };
}
