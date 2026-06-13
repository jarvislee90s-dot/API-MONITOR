export type ProviderId = "openrouter" | "opencode-go" | "xfyun-maas" | "aliyun-bailian";

export type ProviderStatus = "ready" | "partial" | "login_required" | "disabled" | "error";

export type ProviderWindow = {
  key: string;
  label: string;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  percentUsed?: number | null;
  percentRemaining?: number | null;
  resetAt?: string | null;
};

export type ProviderSnapshot = {
  providerId: ProviderId;
  providerName: string;
  sourceUrl: string;
  status: ProviderStatus;
  capturedAt: string;
  summary: string;
  windows: ProviderWindow[];
  metrics: Record<string, number | string | boolean | null>;
  meta: Record<string, unknown>;
};

export type UsageProviderCard = {
  providerId: ProviderId;
  providerName: string;
  sourceUrl: string;
  status: ProviderStatus;
  summary: string;
  capturedAt: string;
  trend: ProviderWindow[];
  windows: ProviderWindow[];
  metrics: Record<string, number | string | boolean | null>;
  meta: Record<string, unknown>;
};

export type UsageModelSpend = {
  model: string;
  providerId?: ProviderId;
  spent?: number;
  tokens?: number;
  count?: number;
  date?: string;
};

export type UsageDashboard = {
  kind: "usage_dashboard";
  generatedAt: string;
  status: ProviderStatus;
  summary: string;
  cards: UsageProviderCard[];
  modelSpends: UsageModelSpend[];
  totals: {
    providers: number;
    ready: number;
    partial: number;
    loginRequired: number;
    error: number;
  };
  refresh?: {
    scope: "all" | "single";
    providerId?: ProviderId;
    sessionKey?: string;
    refreshed: boolean;
    reason?: RefreshDecision["reason"];
    nextAllowedAt?: string | null;
  };
};

export type ProviderFetchInput = {
  now: Date;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  config?: Record<string, unknown>;
};

export type ProviderFetchResult = {
  snapshot: ProviderSnapshot;
  warnings: string[];
};

export type ProviderDefinition = {
  id: ProviderId;
  name: string;
  sourceUrl: string;
  description: string;
  fetchSnapshot(input: ProviderFetchInput): Promise<ProviderFetchResult>;
};

export type RefreshSessionState = {
  sessionKey: string;
  lastTouchAt: string | null;
  lastRefreshAt: string | null;
  refreshCount: number;
  activeUntil: string | null;
};

export type RefreshDecision = {
  allowed: boolean;
  reason: "allowed" | "cooldown" | "inactive";
  session: RefreshSessionState;
  nextAllowedAt: string | null;
};

export type RefreshTouchResult = {
  session: RefreshSessionState;
};

export type RefreshSessionRequest = {
  sessionKey: string;
  reason?: string;
  now?: string;
};

export type RefreshSessionResponse = {
  ok: boolean;
  data?: RefreshDecision | RefreshTouchResult | RefreshSessionState;
  error?: {
    code: string;
    message: string;
  };
};

export interface DurableObjectStateLike {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
}

export interface RefreshSessionEnv {
  REFRESH_COOLDOWN_MS?: string;
  REFRESH_ACTIVE_WINDOW_MS?: string;
}

export interface WorkerEnv extends RefreshSessionEnv {
  ADMIN_SETUP_TOKEN?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  SUPABASE_USER_ID?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
  OPENCODE_GO_WORKSPACE_ID?: string;
  OPENCODE_GO_AUTH_COOKIE?: string;
  OPENCODE_GO_BASE_URL?: string;
  ALIYUN_BAILIAN_PAGE_URL?: string;
  ALIYUN_BAILIAN_API_URL?: string;
  ALIYUN_BAILIAN_AUTH_COOKIE?: string;
  ALIYUN_BAILIAN_SEC_TOKEN?: string;
  ALIYUN_BAILIAN_CLOUD_FETCH?: string;
  XFYUN_MAAS_API_URL?: string;
  XFYUN_MAAS_PAGE_URL?: string;
  XFYUN_MAAS_AUTH_COOKIE?: string;
  REFRESH_SESSION: DurableObjectNamespaceLike;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): string;
  get(id: string): { fetch(request: Request): Promise<Response> };
}
