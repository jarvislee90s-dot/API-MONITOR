import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createApiClient, type DashboardSnapshot } from "./api/client";
import { createSupabaseBrowserAuthClient, type AppAuthSession } from "./auth/auth-client";
import { LoginPage } from "./auth/login-page";
import { DashboardShell, type DashboardSyncState } from "./components";
import { useActiveRefresh } from "./hooks/useActiveRefresh";
import { SettingsPage } from "./settings/settings-page";
import type { AuthConfig } from "./api/client";

function createBootstrapDashboard(): DashboardSnapshot {
  const now = new Date().toISOString();

  return {
    status: "partial",
    generatedAt: now,
    refreshedAt: now,
    platforms: [],
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "请求云端数据失败。";
}

function getLocalAuthConfig(): AuthConfig | null {
  const config = globalThis.__LOCAL_SUPABASE_AUTH_CONFIG__;
  if (!config?.supabaseUrl || !config.supabaseAnonKey) return null;
  return {
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
  };
}

export function App() {
  const authClientRef = useRef<ReturnType<typeof createSupabaseBrowserAuthClient> | null>(null);
  const api = useMemo(
    () =>
      createApiClient({
        authTokenProvider: async () => authClientRef.current?.getAccessToken() ?? null,
      }),
    [],
  );
  const [authClient, setAuthClient] = useState<ReturnType<typeof createSupabaseBrowserAuthClient> | null>(null);
  const [session, setSession] = useState<AppAuthSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<DashboardSnapshot>(() => createBootstrapDashboard());
  const [syncState, setSyncState] = useState<DashboardSyncState>("loading");
  const [syncMessage, setSyncMessage] = useState<string | null>("正在拉取云端数据。");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [route, setRoute] = useState(() => window.location.hash || "#/");
  const requestLockRef = useRef<Promise<void> | null>(null);

  const runSync = useCallback(
    async (phase: "initial" | "refresh" | "reload") => {
      if (requestLockRef.current) {
        return requestLockRef.current;
      }

      const task = (async () => {
        setIsRefreshing(true);
        setSyncState("loading");
        setSyncMessage(
          phase === "initial"
            ? "正在拉取云端数据。"
            : phase === "reload"
              ? "正在同步配置变更。"
              : "正在刷新云端数据。",
        );

        try {
          if (phase === "refresh") {
            await api.refreshUsage();
          }

          const snapshot = await api.getUsageDashboard();
          setDashboard(snapshot);
          setSyncState("ready");
          setSyncMessage(
            phase === "initial"
              ? "云端数据已连接。"
              : phase === "reload"
                ? "配置已生效。"
                : "云端数据已更新。",
          );
        } catch (error) {
          setSyncState("error");
          setSyncMessage(`云端请求失败，当前显示空态视图。${getErrorMessage(error)}`);
        } finally {
          setIsRefreshing(false);
          requestLockRef.current = null;
        }
      })();

      requestLockRef.current = task;
      return task;
    },
    [api],
  );

  const refreshDashboard = useCallback(() => {
    if (!session) return;
    void runSync("refresh");
  }, [runSync, session]);

  const { isActive } = useActiveRefresh(refreshDashboard, {
    intervalMs: 120_000,
    idleMs: 600_000,
  });

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    async function initAuth() {
      try {
        const config = await api.getAuthConfig().catch((error) => {
          const localConfig = getLocalAuthConfig();
          if (localConfig) return localConfig;
          throw error;
        });
        const nextAuthClient = createSupabaseBrowserAuthClient(config);
        authClientRef.current = nextAuthClient;
        const nextSession = await nextAuthClient.getSession();
        if (disposed) return;
        setAuthClient(nextAuthClient);
        setSession(nextSession);
        unsubscribe = nextAuthClient.onSessionChange(setSession);
      } catch (error) {
        if (!disposed) {
          setAuthError(error instanceof Error ? error.message : "登录配置加载失败");
        }
      } finally {
        if (!disposed) setAuthLoading(false);
      }
    }

    void initAuth();

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [api]);

  useEffect(() => {
    if (!session) return;
    void runSync("refresh");
  }, [runSync, session]);

  useEffect(() => {
    const onHashChange = () => setRoute(window.location.hash || "#/");
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!authClient) return;
      setAuthLoading(true);
      setAuthError(null);
      try {
        const nextSession = await authClient.signIn(email, password);
        setSession(nextSession);
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "登录失败");
      } finally {
        setAuthLoading(false);
      }
    },
    [authClient],
  );

  if (authLoading && !authClient) {
    return <main className="app-shell auth-shell">正在加载登录状态...</main>;
  }

  if (!session) {
    return <LoginPage loading={authLoading} error={authError} onSignIn={signIn} />;
  }

  if (route === "#/settings") {
    return (
      <SettingsPage
        api={api}
        dashboard={dashboard}
        onBack={() => {
          window.location.hash = "#/";
          void runSync("reload");
        }}
      />
    );
  }

  return (
    <DashboardShell
      dashboard={dashboard}
      isActive={isActive}
      isRefreshing={isRefreshing}
      syncState={syncState}
      syncMessage={syncMessage}
      onRefresh={refreshDashboard}
    />
  );
}
