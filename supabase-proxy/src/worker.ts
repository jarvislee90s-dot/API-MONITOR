/**
 * Supabase 反向代理 Worker
 *
 * 职责:把 supabase.bondtoolbox.asia 收到的请求原样转发到 Supabase 项目域名,
 *      让境内网络环境无法直连 *.supabase.co 时,改走自有域名经 Cloudflare 网络中转。
 *
 * 安全设计:
 *   - 目标主机固定为 UPSTREAM_HOST(wrangler.toml [vars] 注入),路径无法改变转发目的地,
 *     因此不会被当作任意目标的开放代理;调用方仍需自带 apikey/Authorization 才能访问数据。
 *   - 不记录、不修改任何凭据,apikey/Authorization/Cookie 等请求头原样透传。
 *   - WebSocket(Realtime) 按 Cloudflare 标准透传方式处理。
 */

interface Env {
  UPSTREAM_HOST: string;
  // 可选:按入口域名映射到不同上游项目,JSON 格式
  // {"supabase.bondtoolbox.asia":"cdzjuvewreribelvpccz.supabase.co","supabase2.bondtoolbox.asia":"onexoaebobgpwokgoxwy.supabase.co"}
  UPSTREAM_MAP?: string;
}

// 按请求的入口域名解析上游项目;映射未命中时退回 UPSTREAM_HOST
function resolveUpstream(env: Env, requestHost: string): string | null {
  if (env.UPSTREAM_MAP) {
    try {
      const map = JSON.parse(env.UPSTREAM_MAP) as Record<string, string>;
      if (map[requestHost]) return map[requestHost];
    } catch {
      // JSON 解析失败时退回默认上游
    }
  }
  return env.UPSTREAM_HOST ?? null;
}

// 需要替换掉的事件相关请求头,避免上游收到真实客户端 IP 等信息判定异常
const STRIP_HEADERS = ["cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-proto"];

// 浏览器 CORS 预检必须在反代本地应答:上游网关对不带 apikey 的 OPTIONS 返回 401,
// 而浏览器要求预检必须是 2xx,转发会导致前端 "Failed to fetch"
function preflightResponse(request: Request): Response {
  const origin = request.headers.get("Origin") ?? "*";
  // 请求头名是 Access-Control-Request-Headers(不是 Allow),原样回显给浏览器
  const requestHeaders = request.headers.get("Access-Control-Request-Headers");
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
      "Access-Control-Allow-Headers": requestHeaders ?? "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin, Access-Control-Request-Headers",
    },
  });
}

function buildUpstreamRequest(request: Request, upstreamHost: string, url: URL): Request {
  const target = new URL(url.toString());
  target.hostname = upstreamHost;
  target.protocol = "https:";
  target.port = "";

  // 必须用 new Request(url, request) 整体透传:展开语法 {...request} 会丢掉 method 和 body,
  // 导致 POST 被降级成 GET(上游回 405)
  const upstreamRequest = new Request(target.toString(), request);
  for (const name of STRIP_HEADERS) {
    upstreamRequest.headers.delete(name);
  }
  return upstreamRequest;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 健康检查:验证反代本身可达,不经过上游
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    const upstreamHost = resolveUpstream(env, url.hostname);
    if (!upstreamHost) {
      return new Response(`no upstream mapped for host: ${url.hostname}`, { status: 404 });
    }

    // CORS 预检:反代本地直接应答(上游会回 401 导致浏览器 Failed to fetch)
    if (request.method === "OPTIONS" && request.headers.has("Origin")) {
      return preflightResponse(request);
    }

    // WebSocket(Realtime) 透传:fetch 会把 101 升级响应原样还给客户端
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      try {
        return await fetch(buildUpstreamRequest(request, upstreamHost, url));
      } catch (err) {
        return new Response(`websocket proxy error: ${err instanceof Error ? err.message : "unknown"}`, {
          status: 502,
        });
      }
    }

    try {
      return await fetch(buildUpstreamRequest(request, upstreamHost, url));
    } catch (err) {
      return new Response(`upstream error: ${err instanceof Error ? err.message : "unknown"}`, {
        status: 502,
      });
    }
  },
};
