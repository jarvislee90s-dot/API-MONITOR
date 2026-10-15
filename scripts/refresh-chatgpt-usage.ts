/**
 * ChatGPT 用量本机抓取 + 推送脚本
 *
 * 背景（2026-10-14 实测）：Cloudflare Worker 出口与 Browser Rendering 出口访问 chatgpt.com
 * 均被 403 整体拒绝（robots.txt 也 403，且无 cf-mitigated 头、返回 CF 拦截 HTML 页），
 * 云端无法取数；只有本机浏览器会话（住宅 IP + 真实浏览器指纹 + cf_clearance）能取到。
 * 因此本脚本在本机取数，把**原始 payload** 推给 Worker 的 /api/ingest/chatgpt，
 * 由 Worker 侧复用同一套解析器组装快照（避免脚本与 Worker 两处解析逻辑漂移）。
 *
 * 抓取内容：
 *   1. codex /backend-api/codex/usage —— Codex 额度窗口 + 订阅档位（Bearer 用 ~/.codex/auth.json 的 accessToken）
 *   2. web   /backend-api/rate_limits —— 网页对话 5 小时额度（Bearer 用 session 换来的 accessToken）
 *   3. sub   /backend-api/accounts/check —— 订阅档位与续费日期
 * 三者在页面内同源 fetch，借用 Profile 中的登录态与 cf_clearance。
 *
 * 前置条件：
 *   .env 中已配置 INGEST_API_KEY 与 APIMONITOR_INGEST_URL（与其它 refresh-*.ts 一致）
 *
 * 使用：
 *   node --experimental-strip-types scripts/refresh-chatgpt-usage.ts
 *   node --experimental-strip-types scripts/refresh-chatgpt-usage.ts --auth-json <路径>   # 自定义 codex auth.json
 *   CHATGPT_ACCESS_TOKEN=xxx CHATGPT_ACCOUNT_ID=xxx node --experimental-strip-types scripts/refresh-chatgpt-usage.ts
 *     # 覆盖 codex token（auth.json 过期/失效时用；账号 id 也可只给 token）
 *   node --experimental-strip-types scripts/refresh-chatgpt-usage.ts --local
 *     # 只读 Codex 本地会话日志推送额度（免浏览器、免代理、秒级；与 CLI「剩余用量」同源），
 *     # 订阅档位/续费时间沿用库里最近一次成功快照
 *
 * 鉴权语义（2026-10-15 实测）：
 *   - codex/usage 必须用 Codex Bearer，且**不能**同时带 session cookie（会被判 token_expired）
 *     → 该请求用 credentials:"omit"；
 *   - 网页端点用 cookie-only（session 换来的 accessToken 已不被 backend-api 接受），
 *     accounts/check 用 v4 端点；访客/免费会话拿不到订阅档位，此时由 codex 响应的 plan_type 兜底。
 *
 * 安全：只打印脱敏 hint 与状态码，不打印 token / cookie；原始 payload 不含凭据。
 */

import { resolve } from "node:path";
import {
  AUTH_SESSION_URL,
  CODEX_USAGE_URL,
  ensureProxyOrRespawn,
  extractSessionToken,
  fetchInPage,
  loadEnv,
  maskHint,
  readCodexAuthJson,
  SUBSCRIPTION_CHECK_V4_URL,
  parseWebPlanType,
} from "./chatgpt-browser.ts"; // Node 类型剥离模式需要显式扩展名（scripts/ 不在 tsc 覆盖范围）
import {
  accessTokenAccountId,
  accessTokenPlanType,
  loadStoredChatgptCredential,
  refreshStoredChatgptCredential,
  type StoredChatgptCredential,
} from "./chatgpt-credentials.ts";
import { readLatestCodexUsage, type CodexRateLimitWindow } from "./chatgpt-codex-log.ts";

const WEB_RATE_LIMITS_URL = "https://chatgpt.com/backend-api/rate_limits";
// 实测 cookie-only 下 v4 端点返回 accounts/entitlement（含 subscription_plan / renews_at），旧路径 405
const SUBSCRIPTION_CHECK_URL = SUBSCRIPTION_CHECK_V4_URL;

type FetchedPayload = { status: number; cfMitigated: string | null; body: unknown };

function describeFetch(label: string, result: FetchedPayload | null): string {
  if (!result) return `${label}: 请求未完成（网络或页面内 fetch 失败）`;
  if (result.cfMitigated) return `${label}: HTTP ${result.status}（Cloudflare 质询，建议更换代理节点重试）`;
  if (result.status === 401 || result.status === 403) return `${label}: HTTP ${result.status}（登录态/token 失效）`;
  if (result.status < 200 || result.status >= 300) return `${label}: HTTP ${result.status}`;
  return `${label}: HTTP ${result.status}${result.body === null ? "（响应非 JSON）" : ""}`;
}

// Codex 日志窗口 → /backend-api/codex/usage 形状（worker 解析器两种都认）
function toApiWindow(window: CodexRateLimitWindow): Record<string, unknown> {
  return {
    ...(typeof window.used_percent === "number" ? { used_percent: window.used_percent } : {}),
    ...(typeof window.resets_at === "number" ? { reset_at: window.resets_at } : {}),
    ...(typeof window.window_minutes === "number" ? { limit_window_seconds: window.window_minutes * 60 } : {}),
  };
}

// 从库内最近一次成功快照取订阅档位与续费时间（本地模式下免网络沿用）
async function loadPreviousSubscription(
  env: Record<string, string>,
): Promise<{ plan: string; planRenewAt: string | null } | null> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const url = new URL("/rest/v1/usage_snapshots", SUPABASE_URL);
    url.searchParams.set("select", "payload,captured_at");
    url.searchParams.set("provider_key", "eq.chatgpt");
    url.searchParams.set("order", "captured_at.desc");
    url.searchParams.set("limit", "10");
    const response = await fetch(url, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!response.ok) return null;
    const rows = (await response.json()) as Array<{
      payload?: { metrics?: { plan?: unknown; planRenewAt?: unknown } };
    }>;
    for (const row of rows) {
      const plan = row.payload?.metrics?.plan;
      if (typeof plan === "string" && plan.length > 0 && plan !== "unknown") {
        const renew = row.payload?.metrics?.planRenewAt;
        return { plan, planRenewAt: typeof renew === "string" ? renew : null };
      }
    }
  } catch {
    return null;
  }
  return null;
}

// 合成 v4 accounts/check 形状，让 worker 侧解析器直接复用（plan_type 优先、renews_at 取续费时间）
function synthesizeSubscription(plan: string, planRenewAt: string | null): Record<string, unknown> {
  return {
    accounts: {
      default: {
        account: { plan_type: plan },
        entitlement: { subscription_plan: plan, renews_at: planRenewAt, has_active_subscription: plan !== "guest" },
      },
    },
    account_ordering: ["default"],
  };
}

async function postIngest(env: Record<string, string>, payloads: Record<string, unknown>): Promise<boolean> {
  console.log("[INFO] 推送原始 payload 到 Worker ingest 端点 ...");
  const ingestUrl = `${env.APIMONITOR_INGEST_URL!.replace(/\/$/, "")}/api/ingest/chatgpt`;
  const response = await fetch(ingestUrl, {
    method: "POST",
    headers: { "X-Ingest-Key": env.INGEST_API_KEY!, "content-type": "application/json" },
    body: JSON.stringify(payloads),
  });
  if (response.status === 401) {
    console.error("[FAIL] 推送鉴权失败：INGEST_API_KEY 与 Worker 端不一致");
    return false;
  }
  if (!response.ok) {
    console.error(`[FAIL] 推送失败: HTTP ${response.status} - ${await response.text()}`);
    return false;
  }
  const result = (await response.json()) as {
    data?: { capturedAt?: string; status?: string; windows?: number; plan?: string | null };
  };
  console.log(
    `[OK] 快照已写入 Supabase：status=${result.data?.status ?? "?"}，windows=${result.data?.windows ?? 0}，plan=${result.data?.plan ?? "?"}（capturedAt: ${result.data?.capturedAt ?? "?"}）`,
  );
  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const authJsonIndex = args.indexOf("--auth-json");
  const authJsonPath =
    authJsonIndex >= 0 && args[authJsonIndex + 1]
      ? resolve(args[authJsonIndex + 1]!)
      : resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".codex/auth.json");

  const env = loadEnv();
  const missing = ["INGEST_API_KEY", "APIMONITOR_INGEST_URL"].filter((key) => !env[key]);
  if (missing.length > 0) {
    console.error(`[FAIL] .env 缺少: ${missing.join(", ")}（推送端点与密钥）`);
    process.exit(1);
  }
  console.log(`[INFO] 推送目标: ${env.APIMONITOR_INGEST_URL}/api/ingest/chatgpt`);

  // --local：只读 Codex 本地会话日志（与 CLI「剩余用量」同源），免浏览器与代理，秒级完成
  if (args.includes("--local")) {
    const usage = readLatestCodexUsage();
    if (!usage || (!usage.primary && !usage.secondary)) {
      console.error("[FAIL] 未在 ~/.codex/sessions 找到额度快照：请先在 Codex CLI/IDE 里发一次请求，或改用不带 --local 的方式");
      process.exit(1);
    }
    const rateLimit: Record<string, unknown> = {
      ...(usage.primary ? { primary_window: toApiWindow(usage.primary) } : {}),
      ...(usage.secondary ? { secondary_window: toApiWindow(usage.secondary) } : {}),
    };
    const payloads: Record<string, unknown> = {
      // 采集时间用日志时间：卡片「推送时间」即 CLI 观测到该额度的时间
      capturedAt: usage.observedAt,
      codex: { ...(usage.planType ? { plan_type: usage.planType } : {}), rate_limit: rateLimit },
    };
    console.log(
      `[OK] 本地日志额度（${usage.observedAt}，${usage.filePath.split(/[\/]/).pop()}）：5小时已用=${usage.primary?.used_percent ?? "?"}%、每周已用=${usage.secondary?.used_percent ?? "?"}%、plan=${usage.planType ?? "?"}`,
    );
    const previous = await loadPreviousSubscription(env);
    if (previous) {
      payloads.subscription = synthesizeSubscription(previous.plan, previous.planRenewAt);
      console.log(`[INFO] 沿用库内订阅数据：plan=${previous.plan}，续费=${previous.planRenewAt ?? "(无)"}`);
    }
    const ok = await postIngest(env, payloads);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  // 凭据来源优先级：环境变量 → Supabase 存储副本（可自动刷新并写回）→ 本地 auth.json
  const envAccessToken = process.env.CHATGPT_ACCESS_TOKEN?.trim();
  const envAccountId = process.env.CHATGPT_ACCOUNT_ID?.trim() || null;
  let stored: StoredChatgptCredential | null = null;
  let codex: { accessToken: string; accountId: string | null } | null = null;

  if (envAccessToken) {
    codex = { accessToken: envAccessToken, accountId: envAccountId ?? accessTokenAccountId(envAccessToken) };
    console.log(`[OK] 使用 CHATGPT_ACCESS_TOKEN 环境变量（plan=${accessTokenPlanType(envAccessToken) ?? "?"}）`);
  } else {
    try {
      stored = await loadStoredChatgptCredential(env);
    } catch (error) {
      console.warn(`[WARN] 读取 Supabase 存储凭据失败：${error instanceof Error ? error.message : error}`);
    }
    if (stored?.credential.accessToken) {
      codex = {
        accessToken: stored.credential.accessToken,
        accountId: stored.credential.accountId ?? accessTokenAccountId(stored.credential.accessToken),
      };
      console.log(
        `[OK] 使用 Supabase 存储凭据（${stored.accountLabel}，plan=${accessTokenPlanType(codex.accessToken) ?? "?"}，accessToken ${maskHint(codex.accessToken)}）`,
      );
    } else {
      const local = readCodexAuthJson(authJsonPath);
      if (local) {
        codex = { accessToken: local.accessToken, accountId: local.accountId };
        console.log(`[OK] codex auth.json 已读取（accessToken ${maskHint(local.accessToken)}）`);
      } else {
        console.warn(`[WARN] 未读取到 codex 凭据（${authJsonPath}），将只抓取网页/订阅链路`);
      }
    }
  }

  const session = await extractSessionToken(false);
  if (!session) {
    console.error("[FAIL] 浏览器会话创建失败");
    process.exit(1);
  }

  try {
    if (!session.cookieHeader) {
      console.warn("[WARN] 未取得 session cookie，网页/订阅链路将跳过（Codex 链路仍可推送）");
    }

    const payloads: Record<string, unknown> = { capturedAt: new Date().toISOString() };

    const fetchCodexUsage = (token: string, accountId: string | null) =>
      fetchInPage(
        session.page,
        CODEX_USAGE_URL,
        {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(accountId ? { "chatgpt-account-id": accountId } : {}),
        },
        // 不带 session cookie：cookie 与 bearer 同时出现会被判 token_expired（实测）
        "omit",
      );

    if (codex) {
      let codexResult = await fetchCodexUsage(codex.accessToken, codex.accountId);
      // token 失效（含订阅变更后服务端判废）→ 用存储的 refreshToken 刷新一次并写回
      if (
        codexResult &&
        (codexResult.status === 401 || codexResult.status === 403) &&
        !codexResult.cfMitigated &&
        stored?.credential.refreshToken
      ) {
        console.log(`[INFO] codex/usage 返回 ${codexResult.status}，用存储的 refreshToken 刷新 ...`);
        const refreshed = await refreshStoredChatgptCredential(env, stored);
        if (refreshed) {
          console.log(`[OK] token 已刷新并写回 Supabase（plan=${refreshed.planType ?? "?"}）`);
          codex = { accessToken: refreshed.accessToken, accountId: codex.accountId ?? accessTokenAccountId(refreshed.accessToken) };
          codexResult = await fetchCodexUsage(codex.accessToken, codex.accountId);
        } else {
          console.warn("[WARN] 刷新失败（refreshToken 可能已作废），需要重新登录后重试");
        }
      }
      console.log(describeFetch("codex/usage", codexResult));
      if (codexResult && codexResult.status >= 200 && codexResult.status < 300 && codexResult.body) {
        payloads.codex = codexResult.body;
        const body = codexResult.body as { plan_type?: string; rate_limit?: Record<string, unknown> };
        console.log(`[OK] codex 档位=${body.plan_type ?? "?"}，窗口键=${body.rate_limit ? Object.keys(body.rate_limit).join(",") : "(无)"}`);
      }
    }

    if (session.cookieHeader) {
      // 网页端点需要 **cookie + session Bearer** 同时带上（实测 2026-10-15：
      // 真实会话下 cookie-only 会退化成访客视图，bearer-only 直接 403；
      // 只有 cookie+bearer 才能拿到 accounts/check 的 plus 档位与 renews_at）
      const sessionResult = await fetchInPage(session.page, AUTH_SESSION_URL, { Accept: "application/json" });
      const sessionPayload = sessionResult?.body as {
        accessToken?: string;
        user?: { email?: string };
        account?: { planType?: string };
      } | null;
      const webToken = sessionPayload?.accessToken ?? "";
      console.log(
        `auth/session: HTTP ${sessionResult?.status ?? "?"}，user.email=${sessionPayload?.user?.email ? "有" : "无"}，account.planType=${sessionPayload?.account?.planType ?? "(无)"}，accessToken=${webToken ? "有" : "无"}`,
      );
      const webHeaders: Record<string, string> = {
        Accept: "application/json",
        ...(webToken ? { Authorization: `Bearer ${webToken}` } : {}),
      };

      const rateLimits = await fetchInPage(session.page, WEB_RATE_LIMITS_URL, webHeaders);
      console.log(describeFetch("rate_limits", rateLimits));
      if (rateLimits && rateLimits.status >= 200 && rateLimits.status < 300 && rateLimits.body) {
        payloads.rateLimits = rateLimits.body;
      }

      const subscription = await fetchInPage(session.page, SUBSCRIPTION_CHECK_URL, webHeaders);
      console.log(describeFetch("accounts/check(v4)", subscription));
      if (subscription && subscription.status >= 200 && subscription.status < 300 && subscription.body) {
        // 访客会话的 accounts/check 会返回 plan_type=guest，不能覆盖真实档位，交由 codex plan_type 兜底
        const plan = parseWebPlanType(subscription.body);

        if (plan && plan !== "guest") {
          payloads.subscription = subscription.body;
        } else {
          console.log(`[SKIP] accounts/check 档位=${plan ?? "unknown"}（访客/免费会话），不使用其订阅数据`);
        }
      }
    }

    if (!payloads.codex && !payloads.rateLimits && !payloads.subscription) {
      console.error("[FAIL] 三个链路均未取到 payload，未推送（请检查登录态与代理节点）");
      process.exitCode = 1;
      return;
    }

    const ok = await postIngest(env, payloads);
    if (!ok) {
      process.exitCode = 1;
      return;
    }
    console.log("看板刷新即可看到本机推送的 ChatGPT 数据（抓取方式会显示「本机推送」）。");
  } finally {
    await session.context.close();
  }
}

// 检测到系统代理时上方函数会重启自身接管执行；正常路径才运行 main
if (!(await ensureProxyOrRespawn())) {
  main().catch((err) => {
    console.error("[FAIL] 脚本执行失败:", err);
    process.exit(1);
  });
}
