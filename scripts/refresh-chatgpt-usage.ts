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
} from "./chatgpt-browser.ts"; // Node 类型剥离模式需要显式扩展名（scripts/ 不在 tsc 覆盖范围）

const WEB_RATE_LIMITS_URL = "https://chatgpt.com/backend-api/rate_limits";
const SUBSCRIPTION_CHECK_URL = "https://chatgpt.com/backend-api/accounts/check";

type FetchedPayload = { status: number; cfMitigated: string | null; body: unknown };

function describeFetch(label: string, result: FetchedPayload | null): string {
  if (!result) return `${label}: 请求未完成（网络或页面内 fetch 失败）`;
  if (result.cfMitigated) return `${label}: HTTP ${result.status}（Cloudflare 质询，建议更换代理节点重试）`;
  if (result.status === 401 || result.status === 403) return `${label}: HTTP ${result.status}（登录态/token 失效）`;
  if (result.status < 200 || result.status >= 300) return `${label}: HTTP ${result.status}`;
  return `${label}: HTTP ${result.status}${result.body === null ? "（响应非 JSON）" : ""}`;
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

  const codex = readCodexAuthJson(authJsonPath);
  if (codex) {
    console.log(`[OK] codex auth.json 已读取（accessToken ${maskHint(codex.accessToken)}）`);
  } else {
    console.warn(`[WARN] 未读取到 codex 凭据（${authJsonPath}），将只抓取网页/订阅链路`);
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

    if (codex) {
      const codexResult = await fetchInPage(session.page, CODEX_USAGE_URL, {
        Accept: "application/json",
        Authorization: `Bearer ${codex.accessToken}`,
        ...(codex.accountId ? { "chatgpt-account-id": codex.accountId } : {}),
      });
      console.log(describeFetch("codex/usage", codexResult));
      if (codexResult && codexResult.status >= 200 && codexResult.status < 300 && codexResult.body) {
        payloads.codex = codexResult.body;
      }
    }

    if (session.cookieHeader) {
      const sessionResult = await fetchInPage(session.page, AUTH_SESSION_URL, { Accept: "application/json" });
      const webToken =
        sessionResult && typeof (sessionResult.body as { accessToken?: unknown } | null)?.accessToken === "string"
          ? ((sessionResult.body as { accessToken: string }).accessToken)
          : null;
      console.log(describeFetch("auth/session", sessionResult));
      if (!webToken) {
        console.warn("[WARN] 未取得网页 accessToken，跳过 rate_limits / accounts/check");
      } else {
        const authHeaders = { Accept: "application/json", Authorization: `Bearer ${webToken}` };
        const rateLimits = await fetchInPage(session.page, WEB_RATE_LIMITS_URL, authHeaders);
        console.log(describeFetch("rate_limits", rateLimits));
        if (rateLimits && rateLimits.status >= 200 && rateLimits.status < 300 && rateLimits.body) {
          payloads.rateLimits = rateLimits.body;
        }
        const subscription = await fetchInPage(session.page, SUBSCRIPTION_CHECK_URL, authHeaders);
        console.log(describeFetch("accounts/check", subscription));
        if (subscription && subscription.status >= 200 && subscription.status < 300 && subscription.body) {
          payloads.subscription = subscription.body;
        }
      }
    }

    if (!payloads.codex && !payloads.rateLimits && !payloads.subscription) {
      console.error("[FAIL] 三个链路均未取到 payload，未推送（请检查登录态与代理节点）");
      process.exitCode = 1;
      return;
    }

    console.log("[INFO] 推送原始 payload 到 Worker ingest 端点 ...");
    const ingestUrl = `${env.APIMONITOR_INGEST_URL.replace(/\/$/, "")}/api/ingest/chatgpt`;
    const response = await fetch(ingestUrl, {
      method: "POST",
      headers: { "X-Ingest-Key": env.INGEST_API_KEY, "content-type": "application/json" },
      body: JSON.stringify(payloads),
    });
    if (response.status === 401) {
      console.error("[FAIL] 推送鉴权失败：INGEST_API_KEY 与 Worker 端不一致");
      process.exitCode = 1;
      return;
    }
    if (!response.ok) {
      console.error(`[FAIL] 推送失败: HTTP ${response.status} - ${await response.text()}`);
      process.exitCode = 1;
      return;
    }
    const result = (await response.json()) as {
      data?: { capturedAt?: string; status?: string; windows?: number; plan?: string | null };
    };
    console.log(
      `[OK] 快照已写入 Supabase：status=${result.data?.status ?? "?"}，windows=${result.data?.windows ?? 0}，plan=${result.data?.plan ?? "?"}（capturedAt: ${result.data?.capturedAt ?? "?"}）`,
    );
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
