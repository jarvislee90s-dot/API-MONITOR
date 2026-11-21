import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createApiClient, OPENAI_API_PROVIDER_ID, type DashboardSnapshot } from "./api/client";
import { deriveOpenAiPeriod } from "../../shared/openai-api";
import { createSupabaseBrowserAuthClient, type AppAuthSession } from "./auth/auth-client";
import { LoginPage } from "./auth/login-page";
import { DashboardShell, type DashboardSyncState } from "./components";
import { useActiveRefresh } from "./hooks/useActiveRefresh";
import { SettingsPage } from "./settings/settings-page";
import type { AuthConfig } from "./api/client";

function createBootstrapDashboard(): DashboardSnapshot {
  const now = new Date().toISOString();
  return { status: "partial", generatedAt: now, refreshedAt: now, platforms: [] };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "请求云端数据失败。";
}

function getLocalAuthConfig(): AuthConfig | null {
  const config = globalThis.__LOCAL_SUPABASE_AUTH_CONFIG__;
  if (!config?.supabaseUrl || !config.supabaseAnonKey) return null;
  return { supabaseUrl: config.supabaseUrl, supabaseAnonKey: config.supabaseAnonKey };
}

// 快照必须携带归属 UID：渲染时据此同步过滤，避免身份切换瞬间把旧 Owner 数据交给新会话
type OwnedDashboard = { dashboard: DashboardSnapshot; ownerUid: string | null };

// 生产渲染前过滤跨期 OpenAI 卡：刷新/GET 同时失败或缓存未更新时，
// 当前 UTC 已过卡片 period.end 就不能继续把旧数据标作本期。
function filterExpiredOpenAi(dashboard: DashboardSnapshot, now: Date): DashboardSnapshot {
  let changed = false;
  const platforms = dashboard.platforms.map((platform) => {
    if (platform.id !== OPENAI_API_PROVIDER_ID || !platform.openaiApi) return platform;
    const end = platform.openaiApi.period.end;
    if (!end || Number.isNaN(new Date(end).getTime()) || now.getTime() < new Date(end).getTime()) {
      return platform;
    }
    changed = true;
    const period = deriveOpenAiPeriod(now);
    return {
      ...platform,
      openaiApi: {
        period,
        costs: { status: "unavailable" as const, updatedAt: null, value: null },
        usage: { status: "unavailable" as const, updatedAt: null, value: null },
      },
    };
  });
  return changed ? { ...dashboard, platforms } : dashboard;
}

export function App() {
  const authClientRef = useRef<ReturnType<typeof createSupabaseBrowserAuthClient> | null>(null);
  // 通用 API（设置页等）从同步 sessionRef 读取当前 state 对应的 token，
  // 不再实时异步读全局 authClient，避免多标签快速切换时 bearer 与 UID 错配
  const sessionRef = useRef<AppAuthSession | null>(null);
  const api = useMemo(
    () =>
      createApiClient({
        authTokenProvider: async () => sessionRef.current?.accessToken ?? null,
      }),
    [],
  );
  const [authClient, setAuthClient] = useState<ReturnType<typeof createSupabaseBrowserAuthClient> | null>(null);
  const [session, setSession] = useState<AppAuthSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [dashboardState, setDashboardState] = useState<OwnedDashboard>(() => ({
    dashboard: createBootstrapDashboard(),
    ownerUid: null,
  }));
  const [syncState, setSyncState] = useState<DashboardSyncState>("loading");
  const [syncMessage, setSyncMessage] = useState<string | null>("正在拉取云端数据。");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [route, setRoute] = useState(() => window.location.hash || "#/");

  // 身份归属：epoch 仅在 UID 真变时递增；同一用户 token 刷新不递增、不清看板。
  const identityEpochRef = useRef(0);
  const requestEpochRef = useRef(0); // 已发起的当前 epoch 请求标记，用于同轮去重
  const activeLockRef = useRef<{ epoch: number; promise: Promise<void> } | null>(null);
  const dashboardRef = useRef(dashboardState);

  const commitDashboard = useCallback((next: OwnedDashboard) => {
    dashboardRef.current = next;
    setDashboardState(next);
  }, []);

  // 统一的会话入口：同步推进 sessionRef，身份变化时递增 epoch、立即释放旧锁、清空归属快照。
  const applySession = useCallback((next: AppAuthSession | null) => {
    const nextUid = next?.user.id ?? null;
    const prevUid = sessionRef.current?.user.id ?? null;
    sessionRef.current = next;
    if (nextUid !== prevUid) {
      identityEpochRef.current += 1;
      // UID 切换：旧锁立即作废，新请求不必等旧请求，二者并发但只有当前 epoch 可写入
      activeLockRef.current = null;
      commitDashboard({ dashboard: createBootstrapDashboard(), ownerUid: nextUid });
      setIsRefreshing(false);
      setSyncState("loading");
      setSyncMessage(nextUid ? "正在拉取云端数据。" : null);
    }
    setSession(next);
  }, [commitDashboard]);

  const runSync = useCallback(
    async (phase: "initial" | "refresh" | "reload") => {
      const requestSession = sessionRef.current;
      if (!requestSession) return;
      const requestUid = requestSession.user.id;
      const requestEpoch = identityEpochRef.current;
      // 同一 epoch 已有在途请求时去重：同轮重复触发（如 effect + 自动刷新）直接复用
      if (activeLockRef.current && activeLockRef.current.epoch === requestEpoch) {
        return activeLockRef.current.promise;
      }
      // 一轮请求使用专属 client：bearer 取自捕获的 session，整轮固定，
      // 与 requestUid 严格一致，杜绝「A 的 bearer 贴 B 的 UID」
      const scopedApi = createApiClient({
        authTokenProvider: async () => requestSession.accessToken,
      });

      const isCurrent = () =>
        requestEpoch === identityEpochRef.current && sessionRef.current?.user.id === requestUid;
      // 任务引用容器：在 IIFE 内部比对锁，规避 TS「使用前赋值」告警
      const self: { promise: Promise<void> | null } = { promise: null };

      const task = (async () => {
        if (!isCurrent()) return;
        setIsRefreshing(true);
        setSyncState("loading");
        setSyncMessage(
          phase === "initial"
            ? "正在拉取云端数据。"
            : phase === "reload"
              ? "正在同步配置变更。"
              : "正在刷新云端数据。",
        );

        let refreshError: unknown = null;
        let readError: unknown = null;
        let displayedFresh = false;

        try {
          if (phase === "refresh") {
            try {
              const refreshed = await scopedApi.refreshUsage();
              // POST 失败不阻断 GET；返回快照作为当前会话即时结果（仍用绑定 session 的 client）
              if (isCurrent() && Array.isArray(refreshed?.platforms)) {
                commitDashboard({ dashboard: refreshed, ownerUid: requestUid });
                displayedFresh = true;
              }
            } catch (error) {
              refreshError = error;
            }
          }

          try {
            const snapshot = await scopedApi.getUsageDashboard();
            if (isCurrent()) {
              commitDashboard({ dashboard: snapshot, ownerUid: requestUid });
            }
          } catch (error) {
            readError = error;
          }
        } finally {
          if (isCurrent()) {
            setIsRefreshing(false);
            const hasData =
              displayedFresh ||
              (dashboardRef.current.ownerUid === requestUid &&
                dashboardRef.current.dashboard.platforms.length > 0);
            if (readError) {
              setSyncState("error");
              setSyncMessage(
                hasData
                  ? `读取看板失败，当前显示已有快照（可能非最新）。${getErrorMessage(readError)}`
                  : `云端请求失败，当前显示空态视图。${getErrorMessage(readError)}`,
              );
            } else if (refreshError) {
              setSyncState("error");
              setSyncMessage(
                `刷新失败，当前显示已有快照（可能非最新）。${getErrorMessage(refreshError)}`,
              );
            } else {
              setSyncState("ready");
              setSyncMessage(
                phase === "initial"
                  ? "云端数据已连接。"
                  : phase === "reload"
                    ? "配置已生效。"
                    : "云端数据已更新。",
              );
            }
          }
          // 仅当锁仍属于本任务时才清除，UID 切换后 applySession 已把锁置空，旧请求不碰新锁
          if (activeLockRef.current?.promise === self.promise) {
            activeLockRef.current = null;
          }
        }
      })();

      self.promise = task;
      activeLockRef.current = { epoch: requestEpoch, promise: task };
      return task;
    },
    [commitDashboard],
  );

  const refreshDashboard = useCallback(() => {
    if (!sessionRef.current) return;
    void runSync("refresh");
  }, [runSync]);

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
        applySession(nextSession);
        unsubscribe = nextAuthClient.onSessionChange((next) => {
          if (!disposed) applySession(next);
        });
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
  }, [api, applySession]);

  // 仅在新 UID 出现时触发拉取；同一用户 token 刷新（UID 不变）不会重复触发。
  // runSync 内部按 epoch 去重，多个 effect 同时触发也只发一轮。
  const sessionUserId = session?.user.id ?? null;
  useEffect(() => {
    if (!sessionUserId) return;
    void runSync("refresh");
  }, [runSync, sessionUserId]);

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
        applySession(await authClient.signIn(email, password));
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "登录失败");
      } finally {
        setAuthLoading(false);
      }
    },
    [authClient, applySession],
  );

  // 渲染时同步归属过滤：未等到 passive effect，也不会把旧 Owner 快照交给新身份。
  // 再按当前 UTC 过滤已换期的 OpenAI 卡（DEV fixture 不经过此路径）。
  const emptyDashboard = useMemo(() => createBootstrapDashboard(), []);
  const ownedDashboard =
    sessionUserId !== null && dashboardState.ownerUid === sessionUserId
      ? dashboardState.dashboard
      : emptyDashboard;
  const visibleDashboard = filterExpiredOpenAi(ownedDashboard, new Date());

  if (authLoading && !authClient) {
    return <main className="app-shell auth-shell">正在加载登录状态...</main>;
  }

  if (!session) {
    return <LoginPage loading={authLoading} error={authError} onSignIn={signIn} />;
  }

  if (route === "#/settings") {
    return (
      <SettingsPage
        key={session.user.id}
        api={api}
        dashboard={visibleDashboard}
        onBack={() => {
          window.location.hash = "#/";
          void runSync("reload");
        }}
      />
    );
  }

  return (
    <DashboardShell
      dashboard={visibleDashboard}
      isActive={isActive}
      isRefreshing={isRefreshing}
      syncState={syncState}
      syncMessage={syncMessage}
      onRefresh={refreshDashboard}
    />
  );
}
