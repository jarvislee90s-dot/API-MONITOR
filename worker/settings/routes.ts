import { errorResponse, successResponse, readJsonBody } from "../http";
import {
  deleteProviderAccount,
  getProviderAccountConfigById,
  listProviderSettings,
  updateProviderAccount,
  updateProviderAccountDisplay,
  upsertProviderAccount,
  upsertProviderPreferences,
} from "./repository";
import { getProvider } from "../providers/registry";
import { requireUser } from "../auth";

type SettingsEnv = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_USER_ID?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
};

export async function handleSettingsRequest(
  request: Request,
  env: SettingsEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const auth = await requireUser(request, env, fetchImpl);
  if ("response" in auth) return auth.response;
  const { userId } = auth.user;

  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/settings/providers") {
    return successResponse(await listProviderSettings(env, userId, fetchImpl));
  }

  if (request.method === "PUT" && url.pathname === "/api/settings/providers") {
    try {
      const body = await readJsonBody<{
        providerKey: string;
        enabled: boolean;
        displayOrder: number;
        activeProviderAccountId: string | null;
        providers?: Array<{
          providerKey: string;
          enabled: boolean;
          displayOrder: number;
          activeProviderAccountId: string | null;
        }>;
      }>(request);
      const isBatch = Array.isArray(body.providers);
      const preferences = isBatch ? body.providers! : [body];
      const result = [];
      for (const preference of preferences) {
        result.push(await upsertProviderPreferences(env, userId, preference, fetchImpl));
      }
      return successResponse(isBatch ? result : result[0]);
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
      const result = await upsertProviderAccount(
        env,
        userId,
        {
          providerKey: body.providerKey,
          accountLabel: body.accountLabel,
          sourceUrl: body.sourceUrl,
          credentials: body.credentials,
        },
        fetchImpl,
      );
      return successResponse(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create account";
      return errorResponse(500, "account_creation_failed", message);
    }
  }

  const accountMatch = url.pathname.match(/^\/api\/settings\/accounts\/([^/]+)$/);
  if (request.method === "PATCH" && accountMatch) {
    try {
      const accountId = decodeURIComponent(accountMatch[1]!);
      const body = await readJsonBody<{
        providerKey: string;
        accountLabel: string;
        sourceUrl: string;
        credentials?: Record<string, string>;
      }>(request);
      const result = await updateProviderAccount(
        env,
        userId,
        accountId,
        {
          providerKey: body.providerKey,
          accountLabel: body.accountLabel,
          sourceUrl: body.sourceUrl,
          credentials: body.credentials,
        },
        fetchImpl,
      );
      return successResponse(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update account";
      if (message === "Provider account not found") {
        return errorResponse(404, "account_not_found", message);
      }
      return errorResponse(500, "account_update_failed", message);
    }
  }

  if (request.method === "DELETE" && accountMatch) {
    try {
      const accountId = decodeURIComponent(accountMatch[1]!);
      return successResponse(await deleteProviderAccount(env, userId, accountId, fetchImpl));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete account";
      return errorResponse(500, "account_delete_failed", message);
    }
  }

  const displayMatch = url.pathname.match(/^\/api\/settings\/accounts\/([^/]+)\/display$/);
  if (request.method === "PATCH" && displayMatch) {
    try {
      const accountId = decodeURIComponent(displayMatch[1]!);
      const body = await readJsonBody<{
        homepageEnabled: boolean;
        homepageOrder: number;
      }>(request);
      if (
        typeof body.homepageEnabled !== "boolean" ||
        !Number.isInteger(body.homepageOrder) ||
        body.homepageOrder < 0
      ) {
        return errorResponse(
          400,
          "invalid_request",
          "homepageEnabled must be boolean and homepageOrder must be a non-negative integer",
        );
      }
      const result = await updateProviderAccountDisplay(
        env,
        userId,
        accountId,
        {
          homepageEnabled: body.homepageEnabled,
          homepageOrder: body.homepageOrder,
        },
        fetchImpl,
      );
      return successResponse(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update account display";
      if (message === "Provider account not found") {
        return errorResponse(404, "account_not_found", message);
      }
      return errorResponse(500, "account_display_update_failed", message);
    }
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/settings/accounts/") && url.pathname.endsWith("/test")) {
    try {
      const accountId = url.pathname.split("/")[4];
      if (!accountId) {
        return errorResponse(400, "invalid_request", "Account ID is required");
      }

      const accountConfig = await getProviderAccountConfigById(env, userId, accountId, fetchImpl);
      if (!accountConfig) {
        return errorResponse(404, "account_not_found", "Account not found");
      }

      const provider = getProvider(accountConfig.providerKey);
      if (!provider) {
        return errorResponse(404, "provider_not_found", "Provider not found");
      }

      const fetchInput = {
        now: new Date(),
        fetchImpl,
        config: accountConfig.config,
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
