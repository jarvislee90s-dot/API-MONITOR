import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AuthConfig } from "../api/client";

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface AppAuthSession {
  accessToken: string;
  user: AuthUser;
}

type SupabaseLike = Pick<SupabaseClient, "auth">;

function toAppSession(session: {
  access_token?: string;
  user?: { id?: string; email?: string | null };
} | null): AppAuthSession | null {
  if (!session?.access_token || !session.user?.id) return null;

  return {
    accessToken: session.access_token,
    user: {
      id: session.user.id,
      email: session.user.email ?? null,
    },
  };
}

export function createBrowserAuthClient(supabase: SupabaseLike) {
  return {
    async getSession(): Promise<AppAuthSession | null> {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      return toAppSession(data.session);
    },

    async getAccessToken(): Promise<string | null> {
      const session = await this.getSession();
      return session?.accessToken ?? null;
    },

    async signIn(email: string, password: string): Promise<AppAuthSession | null> {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return toAppSession(data.session);
    },

    async signOut(): Promise<void> {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    },

    onSessionChange(callback: (session: AppAuthSession | null) => void): () => void {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        callback(toAppSession(session));
      });
      return () => data.subscription.unsubscribe();
    },
  };
}

export function createSupabaseBrowserAuthClient(config: AuthConfig) {
  return createBrowserAuthClient(
    createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    }),
  );
}
