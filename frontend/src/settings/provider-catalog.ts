import type { ProviderCatalogItem } from "../api/client";

export const PUBLIC_PROVIDER_CATALOG: ProviderCatalogItem[] = [
  {
    providerKey: "openrouter",
    providerName: "OpenRouter",
    sourceUrl: "https://openrouter.ai/activity",
    description: "Activity 聚合 / 花费拆分",
  },
  {
    providerKey: "opencode-go",
    providerName: "OpenCode Go",
    sourceUrl: "https://opencode.ai/workspace/{workspaceId}/go",
    description: "workspaceId + auth cookie",
  },
  {
    providerKey: "xfyun-maas",
    providerName: "讯飞 MaaS",
    sourceUrl: "https://maas.xfyun.cn/packageSubscription",
    description: "原网页入口 / 登录状态",
  },
  {
    providerKey: "aliyun-bailian",
    providerName: "阿里云百炼",
    sourceUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/coding-plan",
    description: "Coding Plan / 百炼控制台",
  },
];
