import react from "@vitejs/plugin-react";
import path from "node:path";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  const env = {
    ...loadEnv(mode, path.resolve(process.cwd(), ".."), ""),
    ...loadEnv(mode, process.cwd(), ""),
  };
  const apiProxyTarget = env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8787";
  const localSupabaseAuthConfig = {
    supabaseUrl: env.VITE_SUPABASE_URL ?? env.SUPABASE_URL ?? "",
    supabaseAnonKey:
      env.VITE_SUPABASE_ANON_KEY ??
      env.VITE_SUPABASE_PUBLISHABLE_KEY ??
      env.SUPABASE_PUBLISHABLE_KEY ??
      env.SUPABASE_ANON_KEY ??
      "",
  };

  return {
    plugins: [react()],
    define: {
      "globalThis.__LOCAL_SUPABASE_AUTH_CONFIG__": JSON.stringify(localSupabaseAuthConfig),
    },
    server: {
      proxy: {
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    test: {
      environment: "happy-dom",
      globals: true,
    },
  };
});
