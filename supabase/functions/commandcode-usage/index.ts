// Supabase Edge Function：commandcode-usage
//
// 用途：从 Supabase（Deno Deploy / AWS ap-northeast-1）出口调用 Command Code 的三个内部接口，
//       绕开可能存在的 Cloudflare 出口拦截。返回合并 JSON：{ summary, byModel, credits }。
//
// 鉴权：请求头 x-proxy-key 必须等于 OPENCODE_PROXY_KEY（与 opencode 函数共用同一把密钥）。
// 配置：COMMANDCODE_SESSION_COOKIE / COMMANDCODE_ACCOUNT 由 Supabase secrets 注入。

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-proxy-key",
  "access-control-allow-methods": "GET, OPTIONS",
};

const SESSION_COOKIE_NAME = "__Secure-commandcode_prod_.session_token";
const DEFAULT_ACCOUNT = "jarvislee90s-dot";
const SITE_ORIGIN = "https://commandcode.ai";
const API_BASE = "https://api.commandcode.ai";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405);

  const expectedKey = Deno.env.get("OPENCODE_PROXY_KEY") ?? "";
  if (!expectedKey || request.headers.get("x-proxy-key") !== expectedKey) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const cookie = Deno.env.get("COMMANDCODE_SESSION_COOKIE") ?? "";
  const account = Deno.env.get("COMMANDCODE_ACCOUNT") ?? DEFAULT_ACCOUNT;
  if (!cookie) return jsonResponse({ error: "missing_config" }, 500);

  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": USER_AGENT,
    cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
    origin: SITE_ORIGIN,
    referer: `${SITE_ORIGIN}/zh/${encodeURIComponent(account)}/settings/usage`,
  };

  const targets = [
    ["summary", `${API_BASE}/internal/usage/summary`],
    ["byModel", `${API_BASE}/internal/usage/by-model`],
    ["credits", `${API_BASE}/internal/billing/credits`],
  ] as const;

  const results: Record<string, { status: number; text: string }> = {};
  for (const [key, url] of targets) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      results[key] = { status: response.status, text: await response.text() };
    } catch (error) {
      return jsonResponse({ error: "upstream_failed", target: key, message: String(error) }, 502);
    }
  }

  const statuses = Object.values(results).map((item) => item.status);
  if (statuses.some((status) => status === 401 || status === 403)) {
    return jsonResponse({ error: "login_required", statuses }, 401);
  }
  if (statuses.some((status) => status !== 200)) {
    return jsonResponse({ error: "upstream_error", statuses }, 502);
  }

  return new Response(
    JSON.stringify({
      summary: JSON.parse(results.summary!.text),
      byModel: JSON.parse(results.byModel!.text),
      credits: JSON.parse(results.credits!.text),
    }),
    { status: 200, headers: { ...CORS_HEADERS, "content-type": "application/json" } },
  );
});
