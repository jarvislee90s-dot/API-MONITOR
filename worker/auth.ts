import { errorResponse } from "./http";

export interface AuthenticatedUser {
  userId: string;
  email: string | null;
}

export interface SupabaseAuthEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
}

export async function requireUser(
  request: Request,
  env: SupabaseAuthEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<{ user: AuthenticatedUser } | { response: Response }> {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  const publicKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY;

  if (!token) {
    return { response: errorResponse(401, "unauthorized", "Supabase login is required") };
  }

  if (!env.SUPABASE_URL || !publicKey) {
    return { response: errorResponse(500, "missing_auth_config", "Supabase auth config is not configured") };
  }

  const response = await fetchImpl(new URL("/auth/v1/user", env.SUPABASE_URL), {
    method: "GET",
    headers: {
      apikey: publicKey,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    return { response: errorResponse(401, "unauthorized", "Supabase login is invalid or expired") };
  }

  const user = (await response.json().catch(() => null)) as { id?: string; email?: string | null } | null;
  if (!user?.id) {
    return { response: errorResponse(401, "unauthorized", "Supabase login is invalid or expired") };
  }

  return {
    user: {
      userId: user.id,
      email: user.email ?? null,
    },
  };
}
