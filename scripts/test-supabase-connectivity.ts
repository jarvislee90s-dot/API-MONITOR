/**
 * Supabase 连通性环境测试脚本
 *
 * 目的:定位"本机连不上 Supabase"发生在哪一层(DNS / TCP / TLS-SNI / HTTP),
 *      并自动探测本机代理(环境变量 / Windows 系统代理 / 常见端口),验证走代理能否恢复。
 *      只读 .env 中的 SUPABASE_URL,不读取、不输出任何密钥。
 *
 * 使用:
 *   node --experimental-strip-types scripts/test-supabase-connectivity.ts
 *   node --experimental-strip-types scripts/test-supabase-connectivity.ts --proxy=http://127.0.0.1:7890
 *   node --experimental-strip-types scripts/test-supabase-connectivity.ts --url=https://xxxx.supabase.co
 *
 * 判读要点:
 *   - TCP 通 + TLS 握手被 reset = 典型 SNI 阻断(改 DNS/hosts 无效,需代理或换域名)
 *   - 直连失败但"经代理 REST"成功 = 代理有效,可让 Node 走代理(NODE_USE_ENV_PROXY=1,Node>=24)
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";

const TCP_PORT = 443;
const TIMEOUT_MS = 10_000;
const DIRECT_ROUNDS = 5;
const PROXY_ROUNDS = 3;
// 常见代理客户端的本地 HTTP 代理端口(Clash / Clash Verge / v2rayN / Privado 等)
const COMMON_PROXY_PORTS = [7890, 7897, 10809, 8118, 2080, 8080];

type ProbeResult = { ok: boolean; ms: number; detail: string };

function print(text: string): void {
  console.log(text);
}

// 只提取 SUPABASE_URL,不碰其他行;支持 --url= 覆盖
function resolveSupabaseUrl(): string {
  const args = process.argv.slice(2);
  const urlArg = args.find((a) => a.startsWith("--url="))?.slice(6);
  if (urlArg) return urlArg.replace(/^["']|["']$/g, "");
  try {
    const content = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    for (const line of content.split(/\r?\n/)) {
      if (/^SUPABASE_URL\s*=/.test(line.trim())) {
        return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // .env 不存在时由调用方提示
  }
  return "";
}

// ---- 基础探测原语 ----

function tcpConnect(host: string, port: number, timeoutMs = TIMEOUT_MS): Promise<ProbeResult> {
  return new Promise((res) => {
    const start = Date.now();
    const sock = net.connect({ host, port });
    const done = (ok: boolean, detail: string) => {
      sock.destroy();
      res({ ok, ms: Date.now() - start, detail });
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true, "TCP 建连成功"));
    sock.once("timeout", () => done(false, "连接超时"));
    sock.once("error", (err: NodeJS.ErrnoException) => done(false, err.code ?? err.message));
  });
}

function tlsHandshake(host: string, timeoutMs = TIMEOUT_MS): Promise<ProbeResult> {
  return new Promise((res) => {
    const start = Date.now();
    const sock = tls.connect({ host, port: TCP_PORT, servername: host });
    const done = (ok: boolean, detail: string) => {
      sock.destroy();
      res({ ok, ms: Date.now() - start, detail });
    };
    sock.setTimeout(timeoutMs);
    sock.once("secureConnect", () => done(true, `TLS 握手成功 (${sock.getProtocol()})`));
    sock.once("timeout", () => done(false, "TLS 握手超时"));
    sock.once("error", (err: NodeJS.ErrnoException) => done(false, err.code ?? err.message));
  });
}

// 与刷新脚本同路径:全局 fetch 直连 REST(不带任何密钥,任何 HTTP 状态都算"可达")
async function fetchRest(baseOrigin: string): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const resp = await fetch(`${baseOrigin}/rest/v1/`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    return { ok: true, ms: Date.now() - start, detail: `HTTP ${resp.status}(可达)` };
  } catch (err) {
    const cause = (err as Error & { cause?: NodeJS.ErrnoException }).cause;
    const code = cause?.code ?? cause?.message ?? (err as Error).message;
    return { ok: false, ms: Date.now() - start, detail: `fetch 失败: ${code}` };
  }
}

// 基线对照:证明本机基础外网是通的(排除"整个断网/代理全挂"的情况)
async function fetchControl(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const resp = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { ok: resp.ok, ms: Date.now() - start, detail: `HTTP ${resp.status}` };
  } catch (err) {
    const cause = (err as Error & { cause?: NodeJS.ErrnoException }).cause;
    return { ok: false, ms: Date.now() - start, detail: cause?.code ?? (err as Error).message };
  }
}

// ---- 代理探测与代理通道测试 ----

type ProxyEndpoint = { host: string; port: number; source: string };

function detectWindowsSystemProxy(): ProxyEndpoint | null {
  try {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const enableOut = execSync(`reg query "${key}" /v ProxyEnable`, { encoding: "utf-8" });
    if (!/0x1/.test(enableOut)) return null;
    const serverOut = execSync(`reg query "${key}" /v ProxyServer`, { encoding: "utf-8" });
    const raw = serverOut.match(/ProxyServer\s+REG_SZ\s+(.+)/)?.[1]?.trim();
    if (!raw) return null;
    let hostPort = raw;
    if (raw.includes("=")) {
      const parts = Object.fromEntries(
        raw.split(";").map((p) => [p.split("=")[0]?.toLowerCase(), p.split("=")[1]]),
      );
      hostPort = parts["https"] ?? parts["http"] ?? raw.split(";")[0];
    }
    const [host, portStr] = hostPort.split(":");
    const port = Number(portStr);
    if (!host || !Number.isFinite(port)) return null;
    return { host, port, source: "Windows 系统代理" };
  } catch {
    return null;
  }
}

function envProxy(): ProxyEndpoint | null {
  const raw =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!url.hostname || !url.port) return null;
    return { host: url.hostname, port: Number(url.port), source: "环境变量" };
  } catch {
    return null;
  }
}

// 对候选代理发 HTTP CONNECT,成功返回可复用的隧道 socket
function proxyConnect(
  proxy: ProxyEndpoint,
  targetHost: string,
  targetPort: number,
): Promise<{ ok: boolean; socket?: net.Socket; detail: string; ms: number }> {
  return new Promise((res) => {
    const start = Date.now();
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    let buffer = "";
    const finish = (ok: boolean, detail: string, socket?: net.Socket) => {
      if (!ok) sock.destroy();
      res({ ok, detail, socket, ms: Date.now() - start });
    };
    sock.setTimeout(TIMEOUT_MS);
    sock.once("connect", () => {
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    sock.once("data", (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      if (!buffer.includes("\r\n\r\n")) return;
      const ok = /^HTTP\/1\.[01] 200/.test(buffer);
      finish(ok, ok ? "CONNECT 成功" : buffer.split("\r\n")[0], ok ? sock : undefined);
    });
    sock.once("timeout", () => finish(false, "代理连接超时"));
    sock.once("error", (err: NodeJS.ErrnoException) => finish(false, err.code ?? err.message));
  });
}

// 经 CONNECT 隧道发一次 TLS+HTTP GET,验证代理端到端可用
function restViaProxy(proxy: ProxyEndpoint, targetHost: string, path: string): Promise<ProbeResult> {
  return new Promise((res) => {
    const start = Date.now();
    proxyConnect(proxy, targetHost, TCP_PORT).then((conn) => {
      if (!conn.ok || !conn.socket) {
        res({ ok: false, ms: conn.ms, detail: `CONNECT 失败: ${conn.detail}` });
        return;
      }
      const tlsSock = tls.connect({ socket: conn.socket, servername: targetHost });
      let body = "";
      const finish = (ok: boolean, detail: string) => {
        tlsSock.destroy();
        res({ ok, ms: Date.now() - start, detail });
      };
      tlsSock.setTimeout(TIMEOUT_MS);
      tlsSock.once("secureConnect", () => {
        tlsSock.write(`GET ${path} HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`);
      });
      tlsSock.once("data", (chunk: Buffer) => {
        body += chunk.toString("latin1");
        const statusLine = body.split("\r\n")[0];
        if (statusLine.startsWith("HTTP/")) {
          finish(true, statusLine);
        }
      });
      tlsSock.once("timeout", () => finish(false, "经代理请求超时"));
      tlsSock.once("error", (err: NodeJS.ErrnoException) => finish(false, err.code ?? err.message));
    });
  });
}

async function resolveProxyCandidates(targetHost: string): Promise<ProxyEndpoint[]> {
  const candidates: ProxyEndpoint[] = [];
  const env = envProxy();
  if (env) candidates.push(env);
  const sys = detectWindowsSystemProxy();
  if (sys) candidates.push(sys);
  for (const port of COMMON_PROXY_PORTS) {
    candidates.push({ host: "127.0.0.1", port, source: "常见端口" });
  }

  const usable: ProxyEndpoint[] = [];
  for (const candidate of candidates) {
    if (usable.some((u) => u.host === candidate.host && u.port === candidate.port)) continue;
    const probe = await proxyConnect(candidate, targetHost, TCP_PORT);
    print(
      `   探测 ${candidate.host}:${candidate.port}(${candidate.source}) → ${probe.ok ? "✅ 可用" : "❌ 不可用"} ${probe.detail}`,
    );
    if (probe.ok) usable.push(candidate);
  }
  return usable;
}

// ---- DNS ----

async function dnsOverHttps(endpoint: string, host: string): Promise<string | null> {
  try {
    const resp = await fetch(`${endpoint}?name=${encodeURIComponent(host)}&type=A`, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await resp.json()) as { Answer?: Array<{ type: number; data: string }> };
    const a = json.Answer?.find((r) => r.type === 1)?.data;
    return a ?? null;
  } catch {
    return null;
  }
}

// ---- 主流程 ----

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const explicitProxy = args.find((a) => a.startsWith("--proxy="))?.slice(8);
  const baseOrigin = resolveSupabaseUrl();

  print("━━━ Supabase 连通性环境测试 ━━━");
  if (!baseOrigin) {
    print("❌ 未找到 SUPABASE_URL(可用 --url=https://xxxx.supabase.co 指定)");
    process.exit(1);
  }
  const host = new URL(baseOrigin).hostname;
  print(`目标: ${baseOrigin}(host: ${host})`);
  const nodeMajor = Number(process.version.slice(1).split(".")[0]);
  print(`Node: ${process.version}(NODE_USE_ENV_PROXY 支持: ${nodeMajor >= 24 ? "是" : "否"})`);
  print("");

  // 1. DNS
  print("[1] DNS 解析");
  let localIp: string | null = null;
  try {
    localIp = (await dns.resolve4(host))[0] ?? null;
  } catch (err) {
    print(`   本地解析失败: ${(err as Error).message}`);
  }
  const alidns = await dnsOverHttps("https://dns.alidns.com/resolve", host);
  const cloudflare = await dnsOverHttps("https://cloudflare-dns.com/dns-query", host);
  print(`   本地解析: ${localIp ?? "失败"} | DoH(阿里): ${alidns ?? "失败"} | DoH(Cloudflare): ${cloudflare ?? "失败"}`);
  if (localIp && alidns && localIp !== alidns) print("   ⚠️ 本地解析与 DoH 不一致,可能存在 DNS 污染或 hosts 劫持");
  print("");

  // 2. 基线对照
  const control = await fetchControl();
  print(`[2] 基线对照(直连 cloudflare.com): ${control.ok ? "✅" : "❌"} ${control.detail}(${control.ms}ms)`);
  if (!control.ok) print("   ⚠️ 基线都不通,说明本机外网或代理全局异常,先修这个");
  print("");

  // 3. 直连四层
  print(`[3] 直连 TCP 443(${DIRECT_ROUNDS} 次)`);
  let tcpOk = 0;
  for (let i = 0; i < DIRECT_ROUNDS; i += 1) {
    const r = await tcpConnect(host, TCP_PORT);
    if (r.ok) tcpOk += 1;
    print(`   #${i + 1} ${r.ok ? "✅" : "❌"} ${r.detail}(${r.ms}ms)`);
  }
  print("");

  print(`[4] 直连 TLS 握手 / SNI(${DIRECT_ROUNDS} 次)`);
  let tlsOk = 0;
  let tlsError = "";
  for (let i = 0; i < DIRECT_ROUNDS; i += 1) {
    const r = await tlsHandshake(host);
    if (r.ok) tlsOk += 1;
    else tlsError = r.detail;
    print(`   #${i + 1} ${r.ok ? "✅" : "❌"} ${r.detail}(${r.ms}ms)`);
  }
  print("");

  print("[5] 直连 REST(fetch,刷新脚本同路径,3 次)");
  let restOk = 0;
  for (let i = 0; i < 3; i += 1) {
    const r = await fetchRest(baseOrigin);
    if (r.ok) restOk += 1;
    print(`   #${i + 1} ${r.ok ? "✅" : "❌"} ${r.detail}(${r.ms}ms)`);
  }
  print("");

  // 4. 代理通道
  print("[6] 本机代理探测(--proxy= / 环境变量 / Windows 系统代理 / 常见端口)");
  const candidates = explicitProxy
    ? [{ host: new URL(explicitProxy).hostname, port: Number(new URL(explicitProxy).port) || 443, source: "--proxy 参数" }]
    : await resolveProxyCandidates(host);
  let workingProxy: ProxyEndpoint | null = null;
  if (explicitProxy) {
    const c = candidates[0];
    const probe = await proxyConnect(c, host, TCP_PORT);
    print(`   探测 ${c.host}:${c.port} → ${probe.ok ? "✅ 可用" : "❌ 不可用"} ${probe.detail}`);
    if (probe.ok) workingProxy = c;
  } else if (candidates.length > 0) {
    workingProxy = candidates[0];
  }
  if (!workingProxy) {
    print("   未发现可用的本地 HTTP 代理。若你已开启代理客户端,请确认其 HTTP 混合端口(如 7890)是否开放。");
  }
  print("");

  let proxyOk = 0;
  if (workingProxy) {
    print(`[7] 经代理 ${workingProxy.host}:${workingProxy.port} 访问 REST(${PROXY_ROUNDS} 次)`);
    for (let i = 0; i < PROXY_ROUNDS; i += 1) {
      const r = await restViaProxy(workingProxy, host, "/rest/v1/");
      if (r.ok) proxyOk += 1;
      print(`   #${i + 1} ${r.ok ? "✅" : "❌"} ${r.detail}(${r.ms}ms)`);
    }
    print("");
  }

  // 5. 结论
  print("━━━ 结论 ━━━");
  const directBlocked = tcpOk === DIRECT_ROUNDS && tlsOk === 0;
  if (restOk === 3) {
    print("✅ 直连 Supabase 完全可用,当前网络环境没有问题(问题可能在别处,如密钥/账号配置)。");
  } else if (directBlocked) {
    print(`❌ 判定:SNI 阻断。TCP 能连上但 TLS 握手被重置(${tlsError}),这是防火墙按域名(SNI)阻断的典型特征。`);
    print("   · 改 DNS / hosts / 换 Supabase 项目区域都无效(阻断发生在 TLS 层,与 IP、地域无关)。");
  } else if (tcpOk === 0) {
    print(`❌ 判定:TCP 层不可达(${tlsError}),可能是 IP 封锁或本地网络问题。`);
  } else {
    print(`⚠️ 直连不稳定:TCP ${tcpOk}/${DIRECT_ROUNDS} 成功,TLS ${tlsOk}/${DIRECT_ROUNDS} 成功,REST ${restOk}/3 成功。`);
  }

  if (workingProxy && proxyOk === PROXY_ROUNDS) {
    print(`✅ 经代理 ${workingProxy.host}:${workingProxy.port} 访问 Supabase 稳定成功。`);
    print(`   让刷新脚本走代理(不改代码,Node≥24):`);
    print(`     $env:NODE_USE_ENV_PROXY=1; $env:HTTPS_PROXY="http://${workingProxy.host}:${workingProxy.port}"; node --experimental-strip-types scripts/refresh-zhipu-cookie.ts`);
    print(`   一劳永逸方案:用 Cloudflare Worker + 自有域名反代 Supabase(见仓库诊断报告),脚本/浏览器/其他项目全部改用该域名。`);
  } else if (workingProxy) {
    print(`⚠️ 代理 ${workingProxy.host}:${workingProxy.port} 存在但经代理访问不稳定(${proxyOk}/${PROXY_ROUNDS}),检查代理节点本身。`);
  }
}

main().catch((err) => {
  print(`[FAIL] 测试脚本执行失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
