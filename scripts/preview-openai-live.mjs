import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../frontend", import.meta.url));
const shared = fileURLToPath(new URL("../shared", import.meta.url));
const host = "127.0.0.1";
const port = 5174;
const localHosts = new Set([`${host}:${port}`, `localhost:${port}`]);
const analytics = "https://platform.openai.com/settings/organization/analytics/overview";
const endpoint = "/__local/openai/usage";
const [keyFlag, keyPath, ...extraArgs] = process.argv.slice(2);
if (extraArgs.length || (keyFlag !== undefined && (keyFlag !== "--admin-key-file" || !keyPath))) {
  throw new Error("用法：node scripts/preview-openai-live.mjs [--admin-key-file <路径>]");
}

async function loadAdminKey() {
  if (!keyPath) return process.env.OPENAI_ADMIN_API_KEY?.trim();
  const repository = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  const resolved = await realpath(keyPath).catch(() => {
    throw new Error("无法读取指定的 Admin API Key 文件。");
  });
  const relativePath = relative(repository, resolved);
  if (!isAbsolute(relativePath) && !/^\.\.(?:[\\/]|$)/.test(relativePath)) {
    throw new Error("请把 Admin API Key 文件放在项目目录外。");
  }
  const text = await readFile(resolved, "utf8").catch(() => {
    throw new Error("无法读取指定的 Admin API Key 文件。");
  });
  const matches = new Set(text.match(/\bsk-admin-[A-Za-z0-9_-]{20,512}\b/g) ?? []);
  if (matches.size !== 1) throw new Error("密钥文件必须恰好包含一把 Admin API Key。");
  return matches.values().next().value;
}

// 仅保存在本地服务进程中，不进入 Vite 客户端环境。
const adminKey = await loadAdminKey();
let latest;
let pending;
let lastAttempt = 0;

function utcDate(iso) {
  const date = new Date(iso);
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
}

function readMetric(snapshot, pattern) {
  const value = snapshot.match(pattern)?.[1]?.replaceAll(",", "");
  if (!value) throw new Error("overview_unavailable");
  return Number(value);
}

function chromeData(snapshot, period, now) {
  const dates = snapshot.match(/text: (\d+月\d+日)\s*[-–]\s*(\d+月\d+日)/);
  if (!dates || dates[1] !== utcDate(period.start) || dates[2] !== utcDate(now)) {
    throw new Error("date_range_mismatch");
  }
  const defaults = ["Personal Organization", "API 来源 所有 API 来源", "项目 所有项目", "API 密钥 选择", "模型 选择", "用户 选择"];
  if (defaults.some((item) => !snapshot.includes(item))) throw new Error("filters_unverified");
  return {
    capturedAt: now.toISOString(),
    asOfDate: now.toISOString().slice(0, 10),
    start: period.start,
    costs: readMetric(snapshot, /查看支出总额[：:]\s*US\$([\d,.]+)"/),
    requests: readMetric(snapshot, /查看总请求数[：:]\s*([\d,]+)"/),
    tokens: readMetric(snapshot, /查看总令牌数[：:]\s*([\d,]+)"/),
  };
}

async function readChrome(period, now, refresh) {
  let browser;
  try {
    browser = await chromium.connectOverCDP("chrome", { timeout: 5000 });
    const tabs = browser.contexts().flatMap((context) => context.pages()).filter((page) => page.url().split(/[?#]/)[0] === analytics);
    let reason = "overview_unavailable";
    for (const tab of tabs) {
      try {
        const body = tab.locator("html > body");
        chromeData(await body.ariaSnapshot({ timeout: 3500 }), period, now);
        if (refresh) {
          const button = tab.getByRole("button", { name: "刷新数据", exact: true });
          if ((await button.count()) !== 1) throw new Error("overview_unavailable");
          await button.click({ timeout: 4000 });
          await tab.getByRole("link", { name: /^查看支出总额/ }).waitFor({ state: "visible", timeout: 6000 });
        }
        return chromeData(await body.ariaSnapshot({ timeout: 3500 }), period, new Date());
      } catch (error) {
        if (["date_range_mismatch", "filters_unverified"].includes(error.message)) reason = error.message;
      }
    }
    throw new Error(reason);
  } finally {
    await browser?.close().catch(() => {});
  }
}

function unavailable(error) {
  return { status: "unavailable", updatedAt: null, value: null, error };
}

function section(result, fallback, capturedAt) {
  if (result.value !== null) return { status: "ready", value: result.value, updatedAt: capturedAt };
  if (fallback?.value !== null && fallback?.value !== undefined) {
    return { ...fallback, status: "stale", error: result.error ?? "upstream_failed" };
  }
  return unavailable(result.error ?? "upstream_failed");
}

function fromChrome(reading, period, stale) {
  const ready = { status: stale ? "stale" : "ready", updatedAt: reading.capturedAt, ...(stale ? { error: "upstream_failed" } : {}) };
  return {
    period,
    costs: { ...ready, value: reading.costs },
    usage: reading.requests === 0 && reading.tokens === 0
      ? { ...ready, value: { requests: 0, inputTokens: 0, outputTokens: 0, topModels: [] } }
      : unavailable("not_configured"),
  };
}

const server = await createServer({
  root,
  configFile: false,
  envFile: false,
  plugins: [{
    name: "local-openai-usage",
    enforce: "pre",
    configureServer(vite) {
      vite.middlewares.use(handleUsageRequest);
    },
    transformIndexHtml(html) {
      return html.split("\n").filter((line) => !/https:\/\/fonts\.(googleapis|gstatic)\.com/.test(line)).join("\n");
    },
    transform(code, id) {
      if (id.endsWith("/src/styles.css")) return code.split("\n").filter((line) => !line.includes("https://fonts.googleapis.com")).join("\n");
    },
  }, react()],
  server: {
    host, port, strictPort: true, cors: false,
    fs: {
      allow: [root, shared, fileURLToPath(new URL("../node_modules", import.meta.url))],
      deny: [".env", ".env.*", ".dev.vars", ".dev.vars.*", "*.{crt,pem}", "**/.git/**"],
    },
  },
});

const { deriveOpenAiPeriod } = await server.ssrLoadModule("/@fs/" + shared.replaceAll("\\", "/") + "/openai-api.ts");
const { fetchOpenAiApiData } = await server.ssrLoadModule("/@fs/" + fileURLToPath(new URL("../worker/providers/openai-api.ts", import.meta.url)).replaceAll("\\", "/"));
const { buildOpenAiApiCard } = await server.ssrLoadModule("/@fs/" + fileURLToPath(new URL("../worker/openai-api.ts", import.meta.url)).replaceAll("\\", "/"));

async function collect(refresh) {
  const now = new Date();
  const period = deriveOpenAiPeriod(now);
  const cached = latest?.data.period.start === period.start ? latest : null;
  if (adminKey) {
    const result = await fetchOpenAiApiData({ now, adminKey });
    const official = cached?.source === "api" ? cached.data : null;
    return {
      source: "api",
      data: {
        period,
        costs: section(result.costs, official?.costs, result.capturedAt),
        usage: section(result.usage, official?.usage, result.capturedAt),
      },
      note: "数据来自 OpenAI 组织 Costs API 和文本模型 Usage API。",
    };
  }
  try {
    const reading = await readChrome(period, now, refresh);
    const note = reading.requests || reading.tokens
      ? `Chrome 概览合计 ${reading.requests.toLocaleString("zh-CN")} 次请求、${reading.tokens.toLocaleString("zh-CN")} Token。按模型明细需要组织 Admin API Key。`
      : "数据来自已登录 Chrome 的 Personal 组织分析概览，本期暂无模型调用。";
    return { source: "chrome", reading, data: fromChrome(reading, period, false), note };
  } catch (error) {
    const reason = error.message === "date_range_mismatch" ? "Chrome 分析页日期范围与当前周期不一致。"
      : error.message === "filters_unverified" ? "请在 Chrome 分析页选择 Personal 组织并清除筛选条件。"
      : "暂时无法读取已打开的 Chrome 分析页。";
    if (cached?.source === "chrome") {
      return {
        ...cached,
        data: fromChrome(cached.reading, period, true),
        note: `${reason}当前显示已核对的 Personal 组织读数，分析页日期截至 ${cached.reading.asOfDate}（UTC）。`,
      };
    }
    return { source: "chrome", data: { period, costs: unavailable("upstream_failed"), usage: unavailable("upstream_failed") }, note: reason };
  }
}

async function dashboard(refresh) {
  if (!pending && (!latest || Date.now() - lastAttempt >= 120_000 || latest.data.period.start !== deriveOpenAiPeriod(new Date()).start)) {
    lastAttempt = Date.now();
    pending = collect(refresh).then((value) => { latest = value; }).finally(() => { pending = undefined; });
  }
  if (pending) await pending;
  const now = new Date();
  const period = deriveOpenAiPeriod(now);
  const safeData = latest.data.period.start === period.start ? latest.data
    : { period, costs: unavailable("upstream_failed"), usage: unavailable("upstream_failed") };
  const card = { ...buildOpenAiApiCard(safeData, now), summary: latest.note };
  return { ok: true, data: {
    kind: "usage_dashboard", generatedAt: now.toISOString(), status: card.status,
    summary: latest.note, cards: [card], modelSpends: [],
    totals: { providers: 1, ready: Number(card.status === "ready"), partial: Number(card.status === "partial"), loginRequired: 0, error: Number(card.status === "error") },
  } };
}

function handleUsageRequest(request, response, next) {
  if (request.url?.split("?")[0] !== endpoint) return next();
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  const origin = request.headers.origin;
  const sameOrigin = !origin || origin === `http://${request.headers.host}`;
  if (!localHosts.has(request.headers.host) || !sameOrigin || request.headers["sec-fetch-site"] === "cross-site" || !["GET", "POST"].includes(request.method)) {
    response.statusCode = 403;
    return response.end(JSON.stringify({ ok: false, error: { message: "仅允许本机同源读取。" } }));
  }
  void dashboard(request.method === "POST").then((payload) => {
    response.end(JSON.stringify(payload));
  }).catch(() => {
    response.statusCode = 503;
    response.end(JSON.stringify({ ok: false, error: { message: "本地 OpenAI 数据暂不可用。" } }));
  });
}

await server.listen();
server.printUrls();
