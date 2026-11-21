import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../frontend/src/App";
import type { DashboardSnapshot } from "../../frontend/src/api/client";
import type { AppAuthSession } from "../../frontend/src/auth/auth-client";

const OWNER_TOKEN = "token-owner-user";

const getAuthConfig = vi.fn();
const getUsageDashboard = vi.fn();
const refreshUsage = vi.fn();
const getSession = vi.fn();
const onSessionChange = vi.fn();
const signIn = vi.fn();
const signOut = vi.fn();

// 每次 DashboardShell 渲染的 platforms 快照（名称数组），用于检测身份切换首帧是否泄漏旧 Owner 数据
const renderedPlatforms: string[][] = [];

// 当前 auth client 的 session；getAccessToken 据此返回 token，模拟真实认证会话
let currentSession: AppAuthSession | null = null;

vi.mock("../../frontend/src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../frontend/src/api/client")>();
  return {
    ...actual,
    createApiClient: vi.fn(() => ({
      getAuthConfig,
      getUsageDashboard,
      refreshUsage,
    })),
  };
});

vi.mock("../../frontend/src/auth/auth-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../frontend/src/auth/auth-client")>();
  return {
    ...actual,
    createSupabaseBrowserAuthClient: vi.fn(() => ({
      getSession,
      onSessionChange,
      signIn,
      signOut,
      // api 的 authTokenProvider 读取此处；请求发出时的 token 决定归属
      getAccessToken: () => Promise.resolve(currentSession?.accessToken ?? null),
    })),
  };
});

vi.mock("../../frontend/src/components/dashboard-shell", () => ({
  DashboardShell: ({ dashboard }: { dashboard: DashboardSnapshot }) => {
    renderedPlatforms.push(dashboard.platforms.map((platform) => platform.name));
    return <div data-testid="dashboard-shell" />;
  },
}));

function dashboardWith(names: string[]): DashboardSnapshot {
  return {
    status: "ready",
    generatedAt: "2026-11-20T08:30:00.000Z",
    refreshedAt: "2026-11-20T08:30:00.000Z",
    platforms: names.map((name) => ({
      id: name,
      name,
      tagline: "",
      summary: "",
      status: "healthy" as const,
      loginState: "已连接",
      sourceUrl: "https://example.test",
      sourceLabel: "test",
      primaryMetricLabel: "",
      primaryMetricValue: "",
      lastRefreshedAt: "2026-11-20T08:30:00.000Z",
      accent: "#000",
      quotaWindows: [],
      detailMetrics: [],
      trend: [],
      modelSpends: [],
      links: [],
      selectedAccountId: null,
      accounts: [],
    })),
  };
}

function sessionFor(userId: string): AppAuthSession {
  return {
    accessToken: `token-${userId}`,
    user: { id: userId, email: `${userId}@example.test` },
  } as AppAuthSession;
}

describe("App 身份切换不泄漏旧 Owner 数据", () => {
  beforeEach(() => {
    renderedPlatforms.length = 0;
    currentSession = sessionFor("owner-user");
    getAuthConfig.mockResolvedValue({
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon-public-key",
    });
    getSession.mockImplementation(() => Promise.resolve(currentSession));
    onSessionChange.mockImplementation((listener) => {
      // 保持 listener 可被调用；测试中直接调用捕获的引用
      capturedListener = listener;
      return () => undefined;
    });
    signIn.mockResolvedValue(null);
    signOut.mockResolvedValue(undefined);
    globalThis.__LOCAL_SUPABASE_AUTH_CONFIG__ = undefined;
    window.location.hash = "";
    vi.clearAllMocks();
    // clearAllMocks 清空实现，需恢复关键 mock
    currentSession = sessionFor("owner-user");
    getAuthConfig.mockResolvedValue({
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon-public-key",
    });
    getSession.mockImplementation(() => Promise.resolve(currentSession));
    onSessionChange.mockImplementation((listener) => {
      capturedListener = listener;
      return () => undefined;
    });
  });

  let capturedListener!: (session: AppAuthSession | null) => void;

  it("旧 Owner 请求晚到时不得在新用户首帧露出组织数据", async () => {
    const ownerDashboard = dashboardWith(["OpenAI API"]);
    const normalDashboard = dashboardWith([]);

    // 按 token 区分返回：模拟服务端按会话鉴权，绝不返回越权数据
    // - Owner POST(refresh) 返回带组织卡的数据
    // - Owner GET(usage) 刻意延迟，模拟在途旧请求
    // - 新用户 POST/GET 始终返回不含组织数据的普通看板
    let resolveOwnerGet!: (value: DashboardSnapshot) => void;
    getUsageDashboard.mockImplementation(() => {
      const token = currentSession?.accessToken;
      if (token === OWNER_TOKEN) {
        return new Promise<DashboardSnapshot>((resolve) => {
          resolveOwnerGet = resolve;
        });
      }
      return Promise.resolve(normalDashboard);
    });
    refreshUsage.mockImplementation(() => {
      const token = currentSession?.accessToken;
      return Promise.resolve(token === OWNER_TOKEN ? ownerDashboard : normalDashboard);
    });

    render(<App />);

    // Owner 会话完成加载：DashboardShell 渲染出旧 Owner 卡
    await waitFor(() => expect(renderedPlatforms.some((names) => names.includes("OpenAI API"))).toBe(true));

    const framesAtSwitch = renderedPlatforms.length;

    // 切换到新用户会话（token 随之改变）
    act(() => {
      currentSession = sessionFor("other-user");
      capturedListener(currentSession);
    });
    await waitFor(() => expect(renderedPlatforms.length).toBeGreaterThan(framesAtSwitch));

    // 新用户自己的 POST(refresh)/GET(usage) 必须已发起，且不以旧 GET 完成为前提
    // 此时旧 Owner 的延迟 GET 仍未 resolve；新用户的两次请求已用新 token 发出
    await waitFor(() => {
      expect(refreshUsage).toHaveBeenCalled();
      expect(getUsageDashboard).toHaveBeenCalledTimes(2); // 旧 Owner 一次 + 新用户一次
    });

    // 新用户会话下的所有帧都不得包含旧 Owner 组织卡
    for (const frame of renderedPlatforms.slice(framesAtSwitch)) {
      expect(frame, `切换后首帧不得含旧 Owner 卡：${JSON.stringify(frame)}`).not.toContain("OpenAI API");
    }

    // 此时旧 Owner 的延迟 GET 响应才到达；它属于旧会话，不得写回新用户视图
    await act(async () => {
      resolveOwnerGet(ownerDashboard);
    });
    for (const frame of renderedPlatforms.slice(framesAtSwitch)) {
      expect(frame, "旧会话延迟响应不得泄漏到新用户视图").not.toContain("OpenAI API");
    }
  });
});
