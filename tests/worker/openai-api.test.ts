import { afterEach, describe, expect, it, vi } from "vitest";

import { handleApiRequest } from "../../worker/index";
import { RefreshSessionDurableObject } from "../../worker/durable-object/refresh-session";
import type { WorkerEnv } from "../../worker/types";

// 全部为虚构测试值，绝不使用真实密钥
const OWNER_ID = "00000000-0000-0000-0000-0000000000aa";
const SUPABASE_URL = "https://supabase.test";
const COST_ENDPOINT = "https://api.openai.com/v1/organization/costs";
const USAGE_ENDPOINT = "https://api.openai.com/v1/organization/usage/completions";
const INTERNAL_SESSION_KEY = "__internal_openai_api_usage__";

class MemoryStorage {
  private readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

function createEnv(): WorkerEnv {
  const objects = new Map<string, RefreshSessionDurableObject>();
  return {
    SUPABASE_URL,
    SUPABASE_ANON_KEY: "anon-public-test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
    OPENAI_API_OWNER_USER_ID: OWNER_ID,
    OPENAI_ADMIN_API_KEY: "sk-admin-placeholder-not-a-real-key",
    REFRESH_SESSION: {
      idFromName(name: string): string {
        return name;
      },
      get(id: string) {
        let instance = objects.get(id);
        if (!instance) {
          instance = new RefreshSessionDurableObject({ storage: new MemoryStorage() }, {});
          objects.set(id, instance);
        }
        return { fetch(request: Request) { return instance!.fetch(request); } };
      },
    },
  } as WorkerEnv;
}

function epoch(iso: string): string {
  return String(Math.floor(Date.parse(iso) / 1000));
}

type OpenAiCall = { url: string; init?: RequestInit };

interface SnapshotSeed {
  resource: "costs" | "usage";
  periodStart: string;
  capturedAt: string;
  status?: "ready" | "error";
  value?: unknown;
  error?: string;
}

function makeSnapshotRow(seed: SnapshotSeed) {
  const failed = seed.status === "error";
  return {
    user_id: OWNER_ID,
    provider_key: "openai-api",
    provider_account_id: null,
    captured_at: seed.capturedAt,
    created_at: seed.capturedAt,
    status: failed ? "error" : "ready",
    payload: {
      resource: seed.resource,
      periodStart: seed.periodStart,
      ...(failed ? { error: seed.error ?? "upstream_failed" } : { value: seed.value }),
    },
  };
}

interface MockOptions {
  now?: string;
  costPages?: unknown[][];
  usagePages?: unknown[][];
  costStatus?: number;
  usageStatus?: number;
  userId?: string | null;
  // Supabase 匿名会话标记（is_anonymous 用户不得访问组织数据）
  isAnonymous?: boolean;
  // 预置快照行（stale / 跨期失效测试）
  seedSnapshots?: SnapshotSeed[];
  // 费用第 N 页失败（末页失败不可当作完整快照）
  costFailAtPage?: number;
}

function installFetch(options: MockOptions = {}) {
  const openAiCalls: OpenAiCall[] = [];
  const costPages = options.costPages ?? [[]];
  const usagePages = options.usagePages ?? [[]];
  const snapshotRows: any[] = (options.seedSnapshots ?? []).map(makeSnapshotRow);
  const writtenSnapshots: any[] = [];
  let costCallCount = 0;
  let usageCallCount = 0;

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();

    if (url.includes("/auth/v1/user")) {
      if (options.userId === null) {
        return new Response("unauthorized", { status: 401 });
      }
      const user: Record<string, unknown> = { id: options.userId ?? OWNER_ID, email: "owner@example.test" };
      if (options.isAnonymous) user.is_anonymous = true;
      return Response.json(user);
    }

    if (url.startsWith(`${SUPABASE_URL}/rest/v1/usage_snapshots`)) {
      if (init?.method === "POST") {
        const row = JSON.parse(String(init.body ?? "{}"));
        writtenSnapshots.push(row);
        snapshotRows.push(row); // 写后可读：模拟真实 Supabase 内存库
        return new Response("", { status: 201 });
      }
      // GET：按实现的 PostgREST 过滤条件返回（payload->>text、status=eq.ready 等）
      const parsed = new URL(url);
      const resource = parsed.searchParams.get("payload->>resource");
      const periodStart = parsed.searchParams.get("payload->>periodStart");
      const onlySuccess = parsed.searchParams.get("status") === "eq.ready";
      const filtered = snapshotRows.filter((row) => {
        if (resource && row.payload?.resource !== resource.slice(3)) return false;
        if (periodStart && row.payload?.periodStart !== periodStart.slice(3)) return false;
        if (onlySuccess && row.status === "error") return false;
        return true;
      });
      return Response.json(filtered);
    }
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      return Response.json([]);
    }

    if (url.startsWith(COST_ENDPOINT)) {
      openAiCalls.push({ url, init });
      costCallCount += 1;
      if (options.costStatus && options.costStatus !== 200) {
        return new Response("upstream failed", { status: options.costStatus });
      }
      if (options.costFailAtPage === costCallCount) {
        return new Response("upstream failed", { status: 429 });
      }
      const page = costPages[Math.min(costCallCount - 1, costPages.length - 1)] ?? [];
      const hasMore = costCallCount < costPages.length;
      return Response.json({ data: page, has_more: hasMore, next_page: hasMore ? "cursor-next" : null });
    }

    if (url.startsWith(USAGE_ENDPOINT)) {
      openAiCalls.push({ url, init });
      usageCallCount += 1;
      if (options.usageStatus && options.usageStatus !== 200) {
        return new Response("upstream failed", { status: options.usageStatus });
      }
      const page = usagePages[Math.min(usageCallCount - 1, usagePages.length - 1)] ?? [];
      const hasMore = usageCallCount < usagePages.length;
      return Response.json({ data: page, has_more: hasMore, next_page: hasMore ? "cursor-next" : null });
    }

    // 其它 provider 不是本测试关注对象，返回安全空结果避免干扰
    return Response.json({});
  });

  vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
  if (options.now) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(options.now));
  }
  return { fetchImpl, openAiCalls, writtenSnapshots };
}

async function refreshDashboard(
  env: WorkerEnv,
  sessionKey = "openai-api-test",
  overrides: { body?: unknown; token?: string | null } = {},
): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = overrides.token === undefined ? "owner-test-token" : overrides.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  const body = overrides.body === undefined ? { sessionKey } : overrides.body;
  const response = await handleApiRequest(
    new Request("https://api.monitor.local/api/refresh", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    env,
  );
  return { response, payload: (await response.json()) as any };
}

async function usageDashboard(env: WorkerEnv, token: string | null = "owner-test-token"): Promise<any> {
  const response = await handleApiRequest(
    new Request("https://api.monitor.local/api/usage", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    env,
  );
  return { response, payload: (await response.json()) as any };
}

function openAiCard(payload: any): any {
  return payload?.data?.cards?.find((card: any) => card.providerId === "openai-api");
}

// 官方 Costs API bucket：{start_time, end_time, results:[{amount:{value,currency}}]}
const BUCKET_START = 1763145600;
const BUCKET_END = 1763232000;

function costBucket(value: string, currency = "usd") {
  return {
    start_time: BUCKET_START,
    end_time: BUCKET_END,
    results: [{ amount: { value, currency } }],
  };
}

function emptyCostBucket() {
  return { start_time: BUCKET_START, end_time: BUCKET_END, results: [] };
}

// 官方 completions（group_by=model）bucket：results 直接是模型行
function usageBucket(rows: unknown[]) {
  return { start_time: BUCKET_START, end_time: BUCKET_END, results: rows };
}

function emptyUsageBucket() {
  return { start_time: BUCKET_START, end_time: BUCKET_END, results: [] };
}

const COST_PAGES = [
  [costBucket("12.34"), costBucket("5.66")],
  [costBucket("2"), emptyCostBucket()], // 空 results 合法且不影响汇总
];

const USAGE_PAGES = [
  [
    usageBucket([
      { model: "gpt-5", num_model_requests: 10, input_tokens: 1000, output_tokens: 500, input_cached_tokens: 300 },
      { model: "gpt-4o", num_model_requests: 8, input_tokens: 600, output_tokens: 900, input_cached_tokens: 0 },
    ]),
    usageBucket([
      { model: "gpt-5", num_model_requests: 5, input_tokens: 200, output_tokens: 300, input_cached_tokens: 50 },
      { model: null, num_model_requests: 1, input_tokens: 100, output_tokens: 0, input_cached_tokens: 0 },
    ]),
    emptyUsageBucket(), // 空桶应被跳过，但整页数据仍完整
  ],
  [
    usageBucket([
      { model: "alpha", num_model_requests: 4, input_tokens: 400, output_tokens: 100, input_cached_tokens: 0 },
      { model: "beta", num_model_requests: 4, input_tokens: 400, output_tokens: 100, input_cached_tokens: 0 },
      { model: "gpt-4o-mini", num_model_requests: 2, input_tokens: 200, output_tokens: 100, input_cached_tokens: 0 },
      { model: "o3", num_model_requests: 1, input_tokens: 50, output_tokens: 0, input_cached_tokens: 0 },
    ]),
  ],
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OpenAI API 周期边界（通过 handleApiRequest 跨端契约）", () => {
  it("UTC 14 日最后一秒：period 为上月 15 日到本月 15 日，end_time 为采集时刻", async () => {
    const now = "2026-11-14T23:59:59.000Z";
    const { openAiCalls } = installFetch({ now });
    const env = createEnv();

    const { payload } = await refreshDashboard(env);
    const costUrl = new URL(openAiCalls.find((call) => call.url.startsWith(COST_ENDPOINT))!.url);

    // spec: 区间起点包含，终点排他；查询截至采集时刻且排他，故 end_time = now（非 period.end）
    expect(costUrl.searchParams.get("start_time")).toBe(epoch("2026-10-15T00:00:00.000Z"));
    expect(costUrl.searchParams.get("end_time")).toBe(epoch(now));

    const card = openAiCard(payload);
    expect(card.meta.openaiApi.period).toEqual({
      start: "2026-10-15T00:00:00.000Z",
      end: "2026-11-15T00:00:00.000Z",
    });
  });

  it("UTC 15 日首秒零上游零写入，移动假时钟到 +1 秒后两接口正常请求", async () => {
    const { openAiCalls, writtenSnapshots } = installFetch({ now: "2026-11-15T00:00:00.000Z" });
    const env = createEnv(); // 同一 env/DO，复用同一节流实例

    // 首秒 now==start：end_time <= start_time，跳过上游且不写快照
    const { payload: firstPayload } = await refreshDashboard(env, "openai-api-boundary");
    expect(openAiCalls).toHaveLength(0);
    // 只检查 OpenAI 写入；其它 provider 仍按既有逻辑持久化
    expect(writtenSnapshots.filter((row) => row.provider_key === "openai-api")).toHaveLength(0);
    expect(openAiCard(firstPayload).meta.openaiApi.period).toEqual({
      start: "2026-11-15T00:00:00.000Z",
      end: "2026-12-15T00:00:00.000Z",
    });

    // 同一 env/DO，假时钟前进一秒：下一整秒即可预约并检查两接口请求
    const nextSecond = "2026-11-15T00:00:01.000Z";
    vi.setSystemTime(new Date(nextSecond));
    const { payload: secondPayload } = await refreshDashboard(env, "openai-api-boundary");

    const costUrl = new URL(openAiCalls.find((call) => call.url.startsWith(COST_ENDPOINT))!.url);
    const usageUrl = new URL(openAiCalls.find((call) => call.url.startsWith(USAGE_ENDPOINT))!.url);
    expect(costUrl.searchParams.get("start_time")).toBe(epoch("2026-11-15T00:00:00.000Z"));
    expect(costUrl.searchParams.get("end_time")).toBe(epoch(nextSecond));
    expect(usageUrl.searchParams.get("end_time")).toBe(epoch(nextSecond));
    expect(openAiCard(secondPayload).meta.openaiApi.period).toEqual({
      start: "2026-11-15T00:00:00.000Z",
      end: "2026-12-15T00:00:00.000Z",
    });
  });

  it("跨年的一月仍以去年 12 月 15 日为周期起点，end 为次年 1 月 15 日", async () => {
    const now = "2027-01-14T12:00:00.000Z";
    const { openAiCalls } = installFetch({ now });
    const env = createEnv();

    const { payload } = await refreshDashboard(env);
    const costUrl = new URL(openAiCalls.find((call) => call.url.startsWith(COST_ENDPOINT))!.url);

    expect(costUrl.searchParams.get("start_time")).toBe(epoch("2026-12-15T00:00:00.000Z"));
    expect(costUrl.searchParams.get("end_time")).toBe(epoch(now));
    expect(openAiCard(payload).meta.openaiApi.period).toEqual({
      start: "2026-12-15T00:00:00.000Z",
      end: "2027-01-15T00:00:00.000Z",
    });
  });

  it("费用与文本用量使用相同 Unix 秒区间且用量按模型分组", async () => {
    const { openAiCalls } = installFetch({ now: "2026-11-20T08:30:00.000Z" });
    const env = createEnv();

    await refreshDashboard(env);

    const costUrl = new URL(openAiCalls.find((call) => call.url.startsWith(COST_ENDPOINT))!.url);
    const usageUrl = new URL(openAiCalls.find((call) => call.url.startsWith(USAGE_ENDPOINT))!.url);
    expect(costUrl.searchParams.get("start_time")).toBe(usageUrl.searchParams.get("start_time"));
    expect(costUrl.searchParams.get("end_time")).toBe(usageUrl.searchParams.get("end_time"));
    expect(usageUrl.searchParams.get("group_by")).toBe("model");
    expect(Number(usageUrl.searchParams.get("end_time"))).toBe(
      Math.floor(Date.parse("2026-11-20T08:30:00.000Z") / 1000),
    );
  });
});

describe("OpenAI API 费用与用量条款（通过 handleApiRequest 跨端契约）", () => {
  it("汇总分页费用与跨桶跨页模型用量，生成 Top 5 和全量占比", async () => {
    installFetch({ now: "2026-11-20T08:30:00.000Z", costPages: COST_PAGES, usagePages: USAGE_PAGES });
    const env = createEnv();

    const { response, payload } = await refreshDashboard(env);
    const card = openAiCard(payload);

    expect(response.status).toBe(200);
    expect(card).toMatchObject({
      providerId: "openai-api",
      providerName: "OpenAI API",
      sourceUrl: "https://platform.openai.com/settings/organization/analytics/overview",
    });
    expect(card.accounts).toEqual([]);
    expect(card.windows).toEqual([]);
    expect(card.trend).toEqual([]);
    expect(card.metrics).toEqual({});

    const data = card.meta.openaiApi;
    expect(data.period).toEqual({
      start: "2026-11-15T00:00:00.000Z",
      end: "2026-12-15T00:00:00.000Z",
    });
    expect(data.costs).toMatchObject({ status: "ready", value: 20 });
    expect(data.usage.status).toBe("ready");
    expect(data.usage.value).toMatchObject({ requests: 35, inputTokens: 2950, outputTokens: 2000 });
    expect(data.usage.value.topModels.map((model: any) => model.model)).toEqual([
      "gpt-5", "gpt-4o", "alpha", "beta", "gpt-4o-mini",
    ]);
    expect(data.usage.value.topModels[0]).toMatchObject({ tokens: 2000, requests: 15 });
    expect(data.usage.value.topModels[0].share).toBeCloseTo(2000 / 4950, 5);
  });

  it("缓存命中的输入 Token 不重复计入总量", async () => {
    installFetch({
      now: "2026-11-20T08:30:00.000Z",
      costPages: [[costBucket("0")]],
      usagePages: [[usageBucket([
        { model: "gpt-5", num_model_requests: 1, input_tokens: 1000, output_tokens: 100, input_cached_tokens: 700 },
      ])]],
    });
    const env = createEnv();

    const { payload } = await refreshDashboard(env);
    const usage = openAiCard(payload).meta.openaiApi.usage;

    expect(usage.value.inputTokens).toBe(1000);
    expect(usage.value.topModels[0].tokens).toBe(1100);
  });

  it("两个接口都返回完整空结果时输出零值和空模型列表", async () => {
    installFetch({ now: "2026-11-20T08:30:00.000Z", costPages: [[]], usagePages: [[]] });
    const env = createEnv();

    const { payload } = await refreshDashboard(env);
    const data = openAiCard(payload).meta.openaiApi;

    expect(data.costs).toMatchObject({ status: "ready", value: 0 });
    expect(data.usage).toMatchObject({ status: "ready" });
    expect(data.usage.value).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0, topModels: [] });
  });

  it("费用接口失败但用量成功时两区状态独立，卡片为 partial", async () => {
    installFetch({
      now: "2026-11-20T08:30:00.000Z",
      costStatus: 429,
      usagePages: USAGE_PAGES,
    });
    const env = createEnv();

    const { payload } = await refreshDashboard(env);
    const card = openAiCard(payload);
    const data = card.meta.openaiApi;

    expect(data.costs.status).toBe("unavailable");
    expect(data.costs.value).toBeNull();
    expect(data.usage.status).toBe("ready");
    expect(card.status).toBe("partial");
  });

  it("严格跟随 has_more/next_page 分页：游标随页传递且区间不变", async () => {
    const { openAiCalls } = installFetch({
      now: "2026-11-20T08:30:00.000Z",
      costPages: COST_PAGES,
      usagePages: USAGE_PAGES,
    });
    const env = createEnv();

    const { payload } = await refreshDashboard(env);

    const costCalls = openAiCalls.filter((call) => call.url.startsWith(COST_ENDPOINT));
    const usageCalls = openAiCalls.filter((call) => call.url.startsWith(USAGE_ENDPOINT));
    expect(costCalls).toHaveLength(2);
    expect(usageCalls).toHaveLength(2);
    // 第二页必须携带下一页游标，且区间与第一页一致
    for (const calls of [costCalls, usageCalls]) {
      const first = new URL(calls[0]!.url);
      const second = new URL(calls[1]!.url);
      expect(second.searchParams.get("page")).toBe("cursor-next");
      expect(second.searchParams.get("start_time")).toBe(first.searchParams.get("start_time"));
      expect(second.searchParams.get("end_time")).toBe(first.searchParams.get("end_time"));
    }
    // 费用 20 来自两页之和，证实第二页被实际消费
    expect(openAiCard(payload).meta.openaiApi.costs.value).toBe(20);
  });

  it("末页失败时丢弃该资源本轮累计，不把部分数据当作完整快照", async () => {
    installFetch({
      now: "2026-11-20T08:30:00.000Z",
      costPages: COST_PAGES,
      costFailAtPage: 2,
      usagePages: USAGE_PAGES,
    });
    const env = createEnv();

    const { payload } = await refreshDashboard(env);
    const data = openAiCard(payload).meta.openaiApi;

    expect(data.costs.status).toBe("unavailable");
    expect(data.costs.value).toBeNull();
    expect(data.usage.status).toBe("ready");
  });
});

describe("OpenAI API 授权与缓存/节流回归", () => {
  it("全量刷新：非 Owner/匿名/未登录均无卡且零上游访问", async () => {
    for (const variant of [
      { name: "非 Owner", userId: "00000000-0000-0000-0000-0000000000bb", token: "other-user-token" },
      { name: "Supabase 匿名会话", userId: OWNER_ID, isAnonymous: true, token: "anon-session-token" },
      { name: "未登录", userId: null, token: null },
    ]) {
      const { openAiCalls } = installFetch({
        now: "2026-11-20T08:30:00.000Z",
        userId: variant.userId,
        isAnonymous: variant.isAnonymous,
      });
      const env = createEnv();
      // 匿名场景：即使无 Bearer 时 env.SUPABASE_USER_ID 就是 Owner，也不得因此获得组织数据
      if (variant.isAnonymous) env.SUPABASE_USER_ID = OWNER_ID;

      const { payload } = await refreshDashboard(env, `openai-api-${variant.name}`, { token: variant.token });

      expect(openAiCalls, variant.name).toHaveLength(0);
      expect(openAiCard(payload), variant.name).toBeUndefined();
    }
  });

  it("匿名会话 GET（无 Bearer，但 env 为 Owner）不得返回组织卡或触发上游", async () => {
    const { openAiCalls } = installFetch({
      now: "2026-11-20T08:30:00.000Z",
      isAnonymous: true,
      userId: OWNER_ID,
    });
    const env = createEnv();
    // 无 Bearer 时 resolveRequestUserId 直接采用 env.SUPABASE_USER_ID；
    // is_anonymous 必须在无 token 路径也被识别，否则匿名会话会读到 Owner 组织数据
    env.SUPABASE_USER_ID = OWNER_ID;

    const { response, payload } = await usageDashboard(env, null);

    expect(response.status).toBe(200);
    expect(openAiCard(payload)).toBeUndefined();
    expect(openAiCalls).toHaveLength(0);
  });

  it("显式刷新：未登录 401、非 Owner 与匿名 403，且零上游访问", async () => {
    for (const variant of [
      { name: "未登录", userId: null, token: null, status: 401, code: "unauthorized" },
      { name: "非 Owner", userId: "00000000-0000-0000-0000-0000000000bb", token: "other", status: 403, code: "forbidden" },
      { name: "匿名会话", userId: OWNER_ID, isAnonymous: true, token: "anon", status: 403, code: "forbidden" },
    ]) {
      const { openAiCalls } = installFetch({
        now: "2026-11-20T08:30:00.000Z",
        userId: variant.userId,
        isAnonymous: variant.isAnonymous,
      });
      const env = createEnv();

      const { response, payload } = await refreshDashboard(env, "explicit", {
        token: variant.token,
        body: { providerId: "openai-api", sessionKey: "any" },
      });

      expect(response.status, variant.name).toBe(variant.status);
      expect(payload.error?.code, variant.name).toBe(variant.code);
      expect(openAiCalls, variant.name).toHaveLength(0);
    }
  });

  it("Owner Secret 缺失时显式刷新 403，且零上游访问", async () => {
    const { openAiCalls } = installFetch({ now: "2026-11-20T08:30:00.000Z" });
    const env = createEnv();
    delete env.OPENAI_API_OWNER_USER_ID;

    const { response, payload } = await refreshDashboard(env, "explicit", {
      body: { providerId: "openai-api", sessionKey: "any" },
    });

    expect(response.status).toBe(403);
    expect(payload.error?.code).toBe("forbidden");
    expect(openAiCalls).toHaveLength(0);
  });

  it("Owner 缺 Admin Key 时：本周期无成功快照报 not_configured，有成功快照则保留值形成 stale", async () => {
    const periodStart = "2026-11-15T00:00:00.000Z";
    const successAt = "2026-11-18T08:30:00.000Z";

    // 场景一：无历史成功 → unavailable + not_configured
    const noSeed = installFetch({ now: "2026-11-20T08:30:00.000Z" });
    const envA = createEnv();
    delete envA.OPENAI_ADMIN_API_KEY;
    const { payload: payloadA } = await refreshDashboard(envA);
    const dataA = openAiCard(payloadA).meta.openaiApi;
    expect(noSeed.openAiCalls).toHaveLength(0);
    expect(dataA.costs.status).toBe("unavailable");
    expect(dataA.costs.error).toBe("not_configured");
    expect(dataA.usage.error).toBe("not_configured");

    // 场景二：已有本周期成功快照 → stale 保留值与采集时间
    installFetch({
      now: "2026-11-20T08:30:00.000Z",
      seedSnapshots: [
        { resource: "costs", periodStart, capturedAt: successAt, value: 20 },
        {
          resource: "usage", periodStart, capturedAt: successAt,
          value: { requests: 1, inputTokens: 10, outputTokens: 5, topModels: [] },
        },
      ],
    });
    const envB = createEnv();
    delete envB.OPENAI_ADMIN_API_KEY;
    const { payload: payloadB } = await refreshDashboard(envB);
    const dataB = openAiCard(payloadB).meta.openaiApi;
    expect(dataB.costs.status).toBe("stale");
    expect(dataB.costs.value).toBe(20);
    expect(dataB.costs.updatedAt).toBe(successAt);
    expect(dataB.costs.error).toBe("not_configured");
  });

  it("GET /api/usage 只读快照：不访问 OpenAI 上游，且按 payload->> 查询保留状态", async () => {
    const periodStart = "2026-11-15T00:00:00.000Z";
    const successAt = "2026-11-18T08:30:00.000Z";
    const { openAiCalls } = installFetch({
      now: "2026-11-20T08:30:00.000Z",
      seedSnapshots: [{ resource: "costs", periodStart, capturedAt: successAt, value: 20 }],
    });
    const env = createEnv();

    const { response, payload } = await usageDashboard(env);
    const data = openAiCard(payload).meta.openaiApi;

    expect(response.status).toBe(200);
    expect(openAiCalls).toHaveLength(0);
    // GET 通过 payload->>resource / periodStart / status=eq.ready 过滤，保留成功值与采集时间
    expect(data.costs).toMatchObject({ status: "ready", value: 20, updatedAt: successAt });
  });

  it("同周期失败保留最近成功值形成 stale（采集时间与错误码不丢失）", async () => {
    const periodStart = "2026-11-15T00:00:00.000Z";
    const successAt = "2026-11-18T08:30:00.000Z";
    installFetch({
      now: "2026-11-20T08:30:00.000Z",
      costStatus: 500,
      seedSnapshots: [{ resource: "costs", periodStart, capturedAt: successAt, value: 20 }],
    });
    const env = createEnv();

    const { payload } = await refreshDashboard(env, "openai-api-stale");
    const data = openAiCard(payload).meta.openaiApi;

    expect(data.costs.status).toBe("stale");
    expect(data.costs.value).toBe(20);
    expect(data.costs.updatedAt).toBe(successAt);
    expect(data.costs.error).toBe("upstream_failed");
  });

  it("跨周期后旧周期成功值不再作为新周期的 ready/stale 返回", async () => {
    installFetch({
      now: "2026-11-20T08:30:00.000Z",
      costStatus: 500,
      seedSnapshots: [{
        resource: "costs",
        periodStart: "2026-10-15T00:00:00.000Z",
        capturedAt: "2026-11-10T08:30:00.000Z",
        value: 12,
      }],
    });
    const env = createEnv();

    const { payload } = await refreshDashboard(env, "openai-api-next-period");
    const data = openAiCard(payload).meta.openaiApi;

    expect(data.period.start).toBe("2026-11-15T00:00:00.000Z");
    expect(data.costs.value).not.toBe(12);
    expect(data.costs.status).not.toBe("stale");
  });

  it("显式刷新与全量刷新共享 COOLDOWN，冷却期内无上游访问且读回缓存", async () => {
    const { openAiCalls } = installFetch({
      now: "2026-11-20T08:30:00.000Z",
      costPages: COST_PAGES,
      usagePages: USAGE_PAGES,
    });
    const env = createEnv();

    await refreshDashboard(env, "dashboard");
    const afterFirst = openAiCalls.length;
    expect(afterFirst).toBeGreaterThan(0);

    const { payload } = await refreshDashboard(env, "client-forged-key", {
      body: { providerId: "openai-api", sessionKey: "client-forged-key" },
    });

    expect(openAiCalls).toHaveLength(afterFirst);
    const data = openAiCard(payload)?.meta?.openaiApi;
    expect(data).toBeDefined();
    expect(data.costs.status).toBe("ready");
    expect(data.costs.value).toBe(20);
  });
});

describe("OpenAI API 内部会话路径防护", () => {
  const cases = [
    { name: "内部路径直连", path: `/api/session/${INTERNAL_SESSION_KEY}`, method: "GET" },
    { name: "内部 decide 路径", path: "/api/session/__internal_openai_api/decide", method: "GET" },
    { name: "URL 编码路径别名", path: "/api/session/%5F%5Finternal_openai_api%2Fdecide", method: "GET" },
    { name: "公开 session 转发内部 decide", path: "/api/session/public-key/decide", method: "POST" },
  ];

  for (const item of cases) {
    it(`${item.name} 返回 404 且不触及内部实例`, async () => {
      installFetch({ now: "2026-11-20T08:30:00.000Z" });
      const env = createEnv();

      const response = await handleApiRequest(
        new Request(`https://api.monitor.local${item.path}`, { method: item.method }),
        env,
      );

      expect(response.status).toBe(404);
    });
  }

  for (const sessionKey of [INTERNAL_SESSION_KEY, "__internal_openai_api/decide", "__internal_openai_api"]) {
    it(`通用刷新伪造 sessionKey=${sessionKey} 返回 404`, async () => {
      const { openAiCalls } = installFetch({ now: "2026-11-20T08:30:00.000Z" });
      const env = createEnv();

      const { response } = await refreshDashboard(env, "ignored", {
        body: { providerId: "openrouter", sessionKey },
      });

      expect(response.status).toBe(404);
      expect(openAiCalls).toHaveLength(0);
    });
  }
});
