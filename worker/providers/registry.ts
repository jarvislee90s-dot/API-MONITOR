import { openrouter } from "./openrouter";
import { opencodeGo } from "./opencode-go";
import { xfyunMaaS } from "./xfyun-maas";
import { aliyunBailian } from "./aliyun-bailian";
import type { ProviderDefinition, ProviderId } from "../types";

const PROVIDERS: ProviderDefinition[] = [openrouter, opencodeGo, xfyunMaaS, aliyunBailian];

export function listProviders(): ProviderDefinition[] {
  return [...PROVIDERS];
}

export function getProvider(providerId: string): ProviderDefinition | undefined {
  return PROVIDERS.find((provider) => provider.id === providerId);
}

export function isProviderId(value: string): value is ProviderId {
  return PROVIDERS.some((provider) => provider.id === value);
}
