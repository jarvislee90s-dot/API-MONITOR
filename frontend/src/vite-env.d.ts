/// <reference types="vite/client" />

declare global {
  var __LOCAL_SUPABASE_AUTH_CONFIG__:
    | {
        supabaseUrl?: string;
        supabaseAnonKey?: string;
      }
    | undefined;
}

export {};
