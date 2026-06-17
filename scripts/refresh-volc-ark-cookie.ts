/**
 * 火山方舟 Cookie 刷新脚本
 *
 * 功能：从本地浏览器 Profile 提取火山方舟登录态 cookie（csrfToken/digest/AccountID/userInfo），
 *       调 GetCodingPlanUsage 接口验证有效性后，通过 Cloudflare API 更新 Worker 的
 *       VOLC_ARK_AUTH_COOKIE secret，并同步更新本地 .env。
 *
 * 前置条件：
 *   1. 运行前关闭所有浏览器窗口（含后台进程），避免 Profile 锁定
 *   2. .env 中已配置 CLOUDFLARE_API_TOKEN
 *   3. 若浏览器未登录火山方舟，脚本会弹出窗口，手动登录后自动继续
 *
 * 使用：
 *   node --experimental-strip-types scripts/refresh-volc-ark-cookie.ts
 *
 * 原理：火山方舟控制台登录态 cookie 有效期较短（digest JWT 约 2 天），
 *       过期后看板会显示 login_required。本脚本一次性抓取最新 cookie 并同步到云端与本地。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), ".env");
  const content = readFileSync(envPath, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

const localAppData = process.env.LOCALAPPDATA ?? resolve(process.env.HOME ?? "", "AppData/Local");

// 支持的浏览器列表，按优先级排序：Edge 优先（无 DevTools 远程调试限制）
const BROWSER_TARGETS = [
  {
    name: "Edge",
    userDataDir: resolve(localAppData, "Microsoft/Edge/User Data"),
    channel: "msedge" as const,
  },
  {
    name: "Chrome",
    userDataDir: resolve(localAppData, "Google/Chrome/User Data"),
    channel: "chrome" as const,
  },
];

const SUBSCRIBE_URL =
  "https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=subscribe";
const USAGE_API_URL =
  "https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetCodingPlanUsage?";

// 抓取用量必需的 cookie 名称（均位于 .volcengine.com 域）
const REQUIRED_COOKIES = ["csrfToken", "digest", "AccountID", "userInfo"];

type PlaywrightCookie = {
  name: string;
  value: string;
  domain: string;
  expires: number;
};

// 从浏览器 cookie 列表里挑出火山引擎登录态 cookie，组合成请求头用的 cookie 串
function buildCookieString(cookies: PlaywrightCookie[]): string {
  const picked = new Map<string, string>();
  for (const cookie of cookies) {
    if (!cookie.domain.includes("volcengine.com")) continue;
    if (!REQUIRED_COOKIES.includes(cookie.name)) continue;
    // 同名 cookie 可能因 domain/path 重复，只取第一个
    if (!picked.has(cookie.name)) picked.set(cookie.name, cookie.value);
  }
  return REQUIRED_COOKIES.filter((name) => picked.has(name))
    .map((name) => `${name}=${picked.get(name)}`)
    .join("; ");
}

// 调用火山方舟用量接口验证 cookie 是否有效，顺便回显当前用量
async function validateCookie(cookie: string): Promise<{ valid: boolean; usage?: string; error?: string }> {
  const csrfMatch = cookie.match(/csrfToken=([^;]+)/i);
  const csrf = csrfMatch ? csrfMatch[1] : "";
  try {
    const resp = await fetch(USAGE_API_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-csrf-token": csrf,
        Cookie: cookie,
        Referer: SUBSCRIBE_URL,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApiMonitor/0.1",
      },
      body: "{}",
    });

    if (resp.status === 401 || resp.status === 403) {
      return { valid: false, error: `HTTP ${resp.status}，登录态无效或已过期` };
    }
    if (!resp.ok) {
      return { valid: false, error: `HTTP ${resp.status}` };
    }

    const json = (await resp.json()) as {
      Result?: { QuotaUsage?: Array<{ Level?: string; Percent?: number }> };
    };
    const items = json.Result?.QuotaUsage ?? [];
    if (items.length === 0) {
      return { valid: false, error: "接口未返回用量数据" };
    }
    const summary = items
      .map((item) => `${item.Level}=${Number(item.Percent).toFixed(2)}%`)
      .join(", ");
    return { valid: true, usage: summary };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

// 通过 Cloudflare REST API 更新 Worker secret，避免 wrangler CLI 交互
async function updateWorkerSecret(env: Record<string, string>, cookieValue: string): Promise<void> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const scriptName = env.CLOUDFLARE_WORKER_NAME ?? "apimonitor";
  const baseHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // 1. 获取 account_id（token 关联的账号）
  const acctResp = await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: baseHeaders });
  const acctJson = (await acctResp.json()) as {
    success: boolean;
    result?: Array<{ id: string; name: string }>;
    errors?: Array<{ message: string }>;
  };
  if (!acctJson.success || !acctJson.result?.length) {
    throw new Error(`获取 Cloudflare account 失败: ${JSON.stringify(acctJson.errors)}`);
  }
  const accountId = acctJson.result[0].id;
  console.log(`   Cloudflare account: ${acctJson.result[0].name} (${accountId})`);

  // 2. 更新 secret
  const secretResp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/secrets`,
    {
      method: "PUT",
      headers: baseHeaders,
      body: JSON.stringify({
        name: "VOLC_ARK_AUTH_COOKIE",
        text: cookieValue,
        type: "secret_text",
      }),
    },
  );
  const secretJson = (await secretResp.json()) as {
    success: boolean;
    errors?: Array<{ message: string }>;
  };
  if (!secretJson.success) {
    throw new Error(`更新 Worker secret 失败: ${JSON.stringify(secretJson.errors)}`);
  }

  console.log("✅ Worker secret VOLC_ARK_AUTH_COOKIE 已更新");
}

// 同步更新本地 .env 中的 VOLC_ARK_AUTH_COOKIE，保持本地与云端一致
function updateEnvFile(cookieValue: string): void {
  const envPath = resolve(process.cwd(), ".env");
  const content = readFileSync(envPath, "utf-8");
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const newLine = `VOLC_ARK_AUTH_COOKIE="${cookieValue}"`;
  let found = false;
  const updated = lines.map((line) => {
    if (/^VOLC_ARK_AUTH_COOKIE\s*=/.test(line)) {
      found = true;
      return newLine;
    }
    return line;
  });
  if (!found) {
    updated.push("# 火山方舟", newLine);
  }
  writeFileSync(envPath, updated.join(eol), "utf-8");
  console.log("✅ 本地 .env 的 VOLC_ARK_AUTH_COOKIE 已更新");
}

// 从已建立的浏览器上下文提取火山方舟 cookie（persistent 与临时模式共用）
async function extractFromContext(
  context: import("playwright").BrowserContext,
  label: string,
): Promise<{ cookie: string } | null> {
  const page = await context.newPage();
  await page.goto(SUBSCRIBE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // 未登录会跳转到 signin.volcengine.com，提示用户在弹出的窗口完成登录
  if (page.url().includes("signin.volcengine.com")) {
    console.log(`   ⚠️ ${label} 未登录火山方舟。请在弹出的浏览器窗口完成登录，脚本会自动继续...`);
    // 等待登录成功后跳回控制台，最多等 5 分钟
    await page.waitForURL("**/console.volcengine.com/**", { timeout: 300_000 });
    await page.waitForTimeout(3_000);
    console.log("   ✅ 检测到登录成功，开始提取 cookie");
  } else {
    await page.waitForTimeout(2_000);
    console.log(`   ℹ️ ${label} 已处于登录态，直接提取 cookie`);
  }

  const cookies = (await context.cookies()) as PlaywrightCookie[];
  const localCookie = buildCookieString(cookies);

  const found = REQUIRED_COOKIES.filter((name) => localCookie.includes(`${name}=`));
  if (found.length < REQUIRED_COOKIES.length) {
    const missing = REQUIRED_COOKIES.filter((name) => !found.includes(name));
    console.warn(`   ⚠️ 缺少 cookie: ${missing.join(", ")}（继续尝试验证）`);
  }

  const digestCookie = cookies.find((c) => c.name === "digest" && c.domain.includes("volcengine.com"));
  if (digestCookie?.expires) {
    console.log(`   digest 有效期至: ${new Date(digestCookie.expires * 1000).toISOString()}`);
  }

  return { cookie: localCookie };
}

async function main(): Promise<void> {
  const env = loadEnv();
  console.log("✅ 环境变量加载成功");

  if (!env.CLOUDFLARE_API_TOKEN) {
    console.error("❌ .env 中缺少 CLOUDFLARE_API_TOKEN，无法更新 Worker secret。");
    process.exit(1);
  }

  const { chromium } = await import("playwright");

  let cookieString: string | undefined;
  let usedBrowser: string | undefined;

  // 1. 优先尝试复用本地浏览器 Profile（已登录则免登录）
  for (const target of BROWSER_TARGETS) {
    const userDataDir = process.env.BROWSER_USER_DATA_DIR ?? target.userDataDir;
    console.log(`🔧 尝试 ${target.name}（${userDataDir}）...`);

    let context: import("playwright").BrowserContext | null = null;
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        channel: target.channel,
        args: ["--disable-blink-features=AutomationControlled"],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("lock") || msg.includes("singleton") || msg.includes("closed")) {
        console.error(`   ⚠️ ${target.name} Profile 被占用（浏览器正在运行），将尝试下一个或回退到临时浏览器。`);
        continue;
      }
      console.error(`   ⚠️ ${target.name} 启动失败:`, msg.substring(0, 120));
      continue;
    }

    try {
      const result = await extractFromContext(context, target.name);
      if (result?.cookie) {
        cookieString = result.cookie;
        usedBrowser = `${target.name} Profile`;
        console.log(`✅ 从 ${target.name} Profile 提取到 cookie 串（${result.cookie.length} 字符）`);
        break;
      }
    } finally {
      await context.close();
    }
  }

  // 2. Fallback：本地 Profile 均被占用时，启动临时浏览器让用户登录火山方舟
  if (!cookieString) {
    console.log("🔧 本地浏览器 Profile 均被占用，启动临时浏览器（请在弹出窗口登录火山方舟）...");
    const tmpDir = resolve(process.cwd(), ".tmp-volc-ark-profile");
    let tmpContext: import("playwright").BrowserContext | null = null;
    try {
      tmpContext = await chromium.launchPersistentContext(tmpDir, {
        headless: false,
        args: ["--disable-blink-features=AutomationControlled"],
      });
      const result = await extractFromContext(tmpContext, "临时浏览器");
      if (result?.cookie) {
        cookieString = result.cookie;
        usedBrowser = "临时浏览器";
        console.log(`✅ 从临时浏览器提取到 cookie 串（${result.cookie.length} 字符）`);
      }
    } finally {
      if (tmpContext) await tmpContext.close();
    }
  }

  if (!cookieString) {
    console.error("❌ 未能从浏览器提取火山方舟 cookie。");
    process.exit(1);
  }

  // 跨 await 前固定到 const，避免 TS 丢失窄化
  const finalCookie = cookieString;

  // 验证 cookie 有效性
  console.log("🔎 验证 cookie 有效性...");
  const validation = await validateCookie(finalCookie);
  if (!validation.valid) {
    console.error(`❌ Cookie 无效: ${validation.error}`);
    process.exit(1);
  }
  console.log(`✅ Cookie 验证通过，当前用量: ${validation.usage}`);

  // 更新本地 .env
  console.log("📝 更新本地 .env...");
  updateEnvFile(finalCookie);

  // 更新 Worker secret
  console.log("🔄 通过 Cloudflare API 更新 Worker secret...");
  await updateWorkerSecret(env, finalCookie);

  console.log(`🎉 完成！（来源: ${usedBrowser ?? "未知"}）Worker 下次刷新即使用新 cookie。`);
  console.log("   提示：火山方舟 cookie 约 2 天过期，过期后看板显示 login_required，重新执行本脚本即可。");
}

main().catch((err) => {
  console.error("❌ 脚本执行失败:", err);
  process.exit(1);
});
