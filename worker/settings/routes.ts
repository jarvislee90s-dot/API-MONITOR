import { errorResponse, successResponse, readJsonBody } from "../http";
import { listProviderSettings, upsertProviderPreferences, upsertProviderAccount, getActiveProviderAccountConfig } from "./repository";
import { getProvider } from "../providers/registry";

type SettingsEnv = {
  ADMIN_SETUP_TOKEN?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_USER_ID?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
};

function requireAdmin(request: Request, env: SettingsEnv): Response | null {
  if (!env.ADMIN_SETUP_TOKEN) {
    return errorResponse(500, "missing_admin_token", "ADMIN_SETUP_TOKEN is not configured");
  }

  if (request.headers.get("x-api-monitor-admin-token") !== env.ADMIN_SETUP_TOKEN) {
    return errorResponse(401, "unauthorized", "Admin token is required");
  }

  return null;
}

export async function handleSettingsRequest(
  request: Request,
  env: SettingsEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const adminError = requireAdmin(request, env);
  if (adminError) return adminError;

  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/settings/providers") {
    return successResponse(await listProviderSettings(env, fetchImpl));
  }

  if (request.method === "PUT" && url.pathname === "/api/settings/providers") {
    try {
      const body = await readJsonBody<{
        providerKey: string;
        enabled: boolean;
        displayOrder: number;
        activeProviderAccountId: string | null;
      }>(request);
      const result = await upsertProviderPreferences(env, body, fetchImpl);
      return successResponse(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to upsert preferences";
      return errorResponse(500, "upsert_failed", message);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/settings/accounts") {
    try {
      const body = await readJsonBody<{
        providerKey: string;
        accountLabel: string;
        sourceUrl: string;
        credentials?: Record<string, string>;
      }>(request);
      const result = await upsertProviderAccount(env, {
        providerKey: body.providerKey,
        accountLabel: body.accountLabel,
        sourceUrl: body.sourceUrl,
        credentials: body.credentials,
      }, fetchImpl);
      return successResponse(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create account";
      return errorResponse(500, "account_creation_failed", message);
    }
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/settings/accounts/") && url.pathname.endsWith("/test")) {
    try {
      const accountId = url.pathname.split("/")[4];
      if (!accountId) {
        return errorResponse(400, "invalid_request", "Account ID is required");
      }

      // 先从 provider_accounts 读取 account 获取 provider_key
      const headers = {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`,
        Accept: "application/json",
      };

      const accountUrl = new URL("/rest/v1/provider_accounts", env.SUPABASE_URL ?? "");
      accountUrl.searchParams.set("select", "*");
      accountUrl.searchParams.set("id", `eq.${accountId}`);
      accountUrl.searchParams.set("user_id", `eq.${env.SUPABASE_USER_ID ?? ""}`);

      const accountResponse = await fetchImpl(accountUrl, { headers });
      if (!accountResponse.ok) {
        return errorResponse(404, "account_not_found", "Account not found");
      }

      const accountRows = (await accountResponse.json().catch(() => [])) as Array<{ provider_key?: string }>;
      const providerKey = accountRows[0]?.provider_key;
      if (!providerKey) {
        return errorResponse(404, "account_not_found", "Account not found or missing provider key");
      }

      // 读取 account 配置
      const config = await getActiveProviderAccountConfig(env, providerKey, fetchImpl);
      if (!config) {
        return errorResponse(404, "account_not_found", "Account not found or no active configuration");
      }

      // 获取 provider 并测试连接
      const provider = getProvider(providerKey);
      if (!provider) {
        return errorResponse(404, "provider_not_found", "Provider not found");
      }

      const fetchInput = {
        now: new Date(),
        fetchImpl,
        config,
      };

      const result = await provider.fetchSnapshot(fetchInput);
      return successResponse({
        ok: result.snapshot.status === "ready",
        status: result.snapshot.status,
        summary: result.snapshot.summary,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Test connection failed";
      return errorResponse(500, "test_failed", message);
    }
  }

  return errorResponse(404, "not_found", "Unknown settings route");
}