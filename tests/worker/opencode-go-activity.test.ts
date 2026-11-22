// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { fetchOpenCodeGoSnapshot } from "../../worker/providers/opencode-go";

const origin = "https://opencode.example.com";
const edgeProxyUrl = "https://supabase.test/functions/v1/opencode-usage";
const startsAt = "2026-10-24T14:38:24.000Z";
const statusPayload = {
  product: "go",
  access: {
    startsAt,
    endsAt: "2026-11-24T14:38:24.000Z",
    meters: {
      month: { limitMicroCents: "1000000000", usedMicroCents: "250000000" },
    },
  },
};

const daily = [
  { date: "2026-10-24", totalTokens: "83205090", totalRequests: "593", totalCostMicroCents: "0" },
  { date: "2026-10-25", totalTokens: "1089000", totalRequests: "407", totalCostMicroCents: "0" },
];

const models = [
  { provider: "opencode-go", model: "zeta", totalRequests: "100" },
  { provider: "opencode-go", model: "gamma", totalRequests: "180" },
  { provider: "opencode-go", model: "deepseek-v4.1-flash", totalRequests: "250" },
  { provider: "opencode-go", model: "outside-top-five", totalRequests: "20" },
  { provider: "opencode-go", model: "epsilon", totalRequests: "150" },
  { provider: "opencode-go", model: "beta", totalRequests: "180" },
  { provider: "opencode-go", model: "alpha", totalRequests: "100" },
];

function fetchDirect(
  activityResponse: (init?: RequestInit) => Response,
  status = statusPayload,
) {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    switch (String(url)) {
      case `${origin}/console/api/go/status`:
        return Response.json(status);
      case `${origin}/console/api/activity/go`:
        return activityResponse(init);
      default:
        throw new Error(`未模拟的 OpenCode URL ${String(url)}`);
    }
  });

  return fetchOpenCodeGoSnapshot({
    now: new Date("2026-10-25T02:00:00.000Z"),
    fetchImpl,
    config: { baseUrl: origin, workspaceId: "wrk_test", sessionCookie: "mock-session" },
  });
}

async function fetchFromEdge(payload: object) {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== edgeProxyUrl) throw new Error(`未模拟的 OpenCode URL ${String(url)}`);
    const activityRequested = new Headers(init?.headers).get("x-opencode-activity") === "1";
    return Response.json(activityRequested ? payload : statusPayload);
  });
  const { snapshot } = await fetchOpenCodeGoSnapshot({
    now: new Date("2026-10-25T02:00:00.000Z"),
    fetchImpl,
    config: { edgeProxyUrl, edgeProxyKey: "mock-key" },
  });

  expect(fetchImpl).toHaveBeenCalledTimes(1);
  return snapshot;
}

describe("OpenCode Go Activity 直连", () => {
  it("使用当前账号的组织标识和会话请求 Activity", async () => {
    const activityResponse = vi.fn((_init?: RequestInit) => Response.json({ startsAt, daily, models }));

    await fetchDirect(activityResponse);

    expect(activityResponse).toHaveBeenCalledTimes(1);
    const headers = new Headers(activityResponse.mock.calls[0]?.[0]?.headers);
    expect(headers.get("x-org-id")).toBe("wrk_test");
    expect(headers.get("cookie")).toBe("__Host-console_session=mock-session");
  });

  it("累计同期有效的每日请求数和 Token 数", async () => {
    const { snapshot } = await fetchDirect(() => Response.json({ startsAt, daily, models }));

    expect(snapshot.metrics).toMatchObject({ totalRequests: 1000, totalTokens: 84294090 });
  });

  it("对请求数降序、同请求数按名称排序，并以同期全部请求为分母取前五个模型", async () => {
    const { snapshot } = await fetchDirect(() => Response.json({ startsAt, daily, models }));

    expect(typeof snapshot.metrics.topModels).toBe("string");
    expect(JSON.parse(String(snapshot.metrics.topModels))).toMatchObject([
      { model: "deepseek-v4.1-flash", requests: 250, share: 0.25 },
      { model: "beta", requests: 180, share: 0.18 },
      { model: "gamma", requests: 180, share: 0.18 },
      { model: "epsilon", requests: 150, share: 0.15 },
      { model: "alpha", requests: 100, share: 0.1 },
    ]);
  });

  it("识别不同 ISO 写法表示的相同周期起点", async () => {
    const { snapshot } = await fetchDirect(() => Response.json({
      startsAt: "2026-10-24T22:38:24+08:00",
      daily,
      models,
    }));

    expect(snapshot.metrics).toMatchObject({ totalRequests: 1000, totalTokens: 84294090 });
  });

  it("周期起点优先使用 access.startsAt 而非月窗计量起点", async () => {
    const status = {
      ...statusPayload,
      access: {
        ...statusPayload.access,
        meters: {
          month: { ...statusPayload.access.meters.month, startsAt: "2026-10-01T00:00:00.000Z" },
        },
      },
    };
    const { snapshot } = await fetchDirect(() => Response.json({ startsAt, daily, models }), status);

    expect(snapshot.metrics).toMatchObject({ totalRequests: 1000, totalTokens: 84294090 });
  });

  it.each([
    {
      missingMetric: "totalRequests",
      completeMetric: "totalTokens",
      expectedTotal: 83205102,
      secondDay: { date: "2026-10-25", totalTokens: "12" },
    },
    {
      missingMetric: "totalTokens",
      completeMetric: "totalRequests",
      expectedTotal: 600,
      secondDay: { date: "2026-10-25", totalRequests: "7", totalTokens: "invalid" },
    },
  ])("省略不完整的 $missingMetric 并保留 $completeMetric", async ({
    missingMetric, completeMetric, expectedTotal, secondDay,
  }) => {
    const { snapshot } = await fetchDirect(() => Response.json({
      startsAt,
      daily: [daily[0], secondDay],
      models: [],
    }));

    expect(snapshot.metrics[completeMetric]).toBe(expectedTotal);
    expect(snapshot.metrics).not.toHaveProperty(missingMetric);
  });

  it.each([
    ["布尔值", false],
    ["空白字符串", "  "],
    ["数组", []],
  ])("拒绝将每日请求的%s转换成零", async (_label, totalRequests) => {
    const { snapshot } = await fetchDirect(() => Response.json({
      startsAt,
      daily: [daily[0], { ...daily[1], totalRequests }],
      models: [],
    }));

    expect(snapshot.metrics).not.toHaveProperty("totalRequests");
    expect(snapshot.metrics.totalTokens).toBe(84294090);
  });

  it("保留明确报告的零请求和零 Token", async () => {
    const { snapshot } = await fetchDirect(() => Response.json({
      startsAt,
      daily: daily.map(({ date }) => ({ date, totalRequests: "0", totalTokens: "0", totalCostMicroCents: "0" })),
      models: [],
    }));

    expect(snapshot.metrics).toMatchObject({ totalRequests: 0, totalTokens: 0 });
  });

  it.each([
    ["上个周期", () => Response.json({ startsAt: "2026-09-24T14:38:24.000Z", daily, models })],
    ["缺失统计", () => Response.json({ startsAt })],
    ["HTTP 失败", () => new Response("服务暂不可用", { status: 503 })],
    ["响应不是 JSON", () => new Response("服务暂不可用")],
    ["请求失败", () => { throw new TypeError("模拟网络失败"); }],
  ])("Activity %s时保留额度并省略统计", async (_scenario, activityResponse) => {
    const respond = vi.fn(activityResponse);
    const { snapshot } = await fetchDirect(respond);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.windows).toMatchObject([{ key: "monthly", used: 25, limit: 100 }]);
    expect(snapshot.metrics).not.toHaveProperty("totalRequests");
    expect(snapshot.metrics).not.toHaveProperty("totalTokens");
    expect(snapshot.metrics).not.toHaveProperty("topModels");
  });
});

describe("OpenCode Go Activity Edge 代理", () => {
  it("一次代理响应提供额度窗口和本期 Activity", async () => {
    const snapshot = await fetchFromEdge({ status: statusPayload, activity: { startsAt, daily, models } });

    expect(snapshot.status).toBe("ready");
    expect(snapshot.meta.fetchMethod).toBe("edge_function");
    expect(snapshot.windows).toMatchObject([{ key: "monthly", used: 25, limit: 100 }]);
    expect(snapshot.metrics).toMatchObject({ totalTokens: 84294090, totalRequests: 1000 });
    expect(JSON.parse(String(snapshot.metrics.topModels))[0]).toMatchObject({
      model: "deepseek-v4.1-flash", requests: 250, share: 0.25,
    });
  });

  it.each([
    ["旧版响应仅有额度", statusPayload],
    ["代理 Activity 失败", { status: statusPayload, activity: null, activityError: "HTTP 503" }],
    ["代理 Activity 周期不匹配", {
      status: statusPayload,
      activity: { startsAt: "2026-09-24T14:38:24.000Z", daily, models },
    }],
  ])("%s时保持可用额度", async (_scenario, payload) => {
    const snapshot = await fetchFromEdge(payload);

    expect(snapshot.status).toBe("ready");
    expect(snapshot.windows).toMatchObject([{ key: "monthly", used: 25, limit: 100 }]);
    expect(snapshot.metrics).not.toHaveProperty("totalRequests");
    expect(snapshot.metrics).not.toHaveProperty("totalTokens");
    expect(snapshot.metrics).not.toHaveProperty("topModels");
  });
});
