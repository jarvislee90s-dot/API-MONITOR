// Supabase Edge Function：opencode-usage
//
// 用途：从 Supabase（Deno Deploy / AWS ap-northeast-1）出口调用 opencode 新版控制台用量接口，
//       绕开 opencode 对 Cloudflare 出口 IP 的 401 拒绝。
//
// 鉴权：请求头 x-proxy-key 必须等于环境变量 OPENCODE_PROXY_KEY（防止被公开滥用）。
// 配置：OPENCODE_GO_WORKSPACE_ID / OPENCODE_GO_SESSION_COOKIE 由 Supabase secrets 注入。
//
// 调用：GET https://<project-ref>.supabase.co/functions/v1/opencode-usage
//       x-proxy-key: <OPENCODE_PROXY_KEY>

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-proxy-key, x-opencode-activity",
  "access-control-allow-methods": "GET, OPTIONS",
};

const BROWSER_HEADERS: Record<string, string> = {
  accept: "application/json",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (request.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const expectedKey = Deno.env.get("OPENCODE_PROXY_KEY") ?? "";
  const providedKey = request.headers.get("x-proxy-key") ?? "";
  if (!expectedKey || providedKey !== expectedKey) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const workspaceId = Deno.env.get("OPENCODE_GO_WORKSPACE_ID") ?? "";
  const sessionCookie = Deno.env.get("OPENCODE_GO_SESSION_COOKIE") ?? "";
  if (!workspaceId || !sessionCookie) {
    return jsonResponse({ error: "missing_config" }, 500);
  }

  const origin = "https://opencode.ai";
  const consoleUrl = `${origin}/console/${encodeURIComponent(workspaceId)}`;
  const headers = {
    ...BROWSER_HEADERS,
    "x-org-id": workspaceId,
    cookie: `__Host-console_session=${sessionCookie}`,
    origin,
  };
  try {
    const upstream = await fetch(`${origin}/console/api/go/status`, {
      headers: { ...headers, referer: `${consoleUrl}/go` },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const body = await upstream.text();
    // 旧 Worker 继续读取原始用量响应，两个服务可以分开发布。
    if (upstream.status !== 200 || request.headers.get("x-opencode-activity") !== "1") {
      return new Response(upstream.body === null ? null : body, {
        status: upstream.status,
        headers: {
          ...CORS_HEADERS,
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        },
      });
    }

    const status: unknown = JSON.parse(body);
    let activity: unknown = null;
    try {
      const response = await fetch(`${origin}/console/api/activity/go`, {
        headers: { ...headers, referer: `${consoleUrl}/activity` },
        redirect: "manual",
        signal: AbortSignal.timeout(8_000),
      });
      if (response.status === 200) activity = await response.json();
    } catch {
      // Activity 失败时继续提供额度窗口。
    }
    return jsonResponse({ status, activity });
  } catch {
    return jsonResponse({ error: "upstream_failed" }, 502);
  }
});
