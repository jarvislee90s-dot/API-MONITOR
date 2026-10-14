/**
 * ChatGPT 端点一次性探测脚本（需用户真实环境执行）
 *
 * 用 ~/.codex/auth.json 的 token 探测 codex rate_limits / token 刷新 / 网页/订阅端点的
 * 响应结构，输出脱敏结构骨架（不含任何完整 token），供 chatgpt provider 解析器核对。
 *
 * 使用：
 *   node --experimental-strip-types scripts/probe-chatgpt-endpoints.ts
 *   node --experimental-strip-types scripts/probe-chatgpt-endpoints.ts --refresh          # 额外探测刷新端点（会轮换 token）
 *   CHATGPT_SESSION_TOKEN=xxx node --experimental-strip-types scripts/probe-chatgpt-endpoints.ts  # 额外探测网页/订阅端点
 *   CODEX_AUTH_JSON=D:\path\auth.json node --experimental-strip-types scripts/probe-chatgpt-endpoints.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const CODEX_RATE_LIMITS_URL = "https://chatgpt.com/backend-api/codex/rate_limits";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const WEB_SESSION_URL = "https://chatgpt.com/api/auth/session";
const WEB_RATE_LIMITS_URL = "https://chatgpt.com/backend-api/rate_limits";
const SUBSCRIPTION_CHECK_URL = "https://chatgpt.com/backend-api/accounts/check";
// codex CLI 公开 client_id；与 worker/providers/chatgpt.ts（或拆分后的 parser 模块）的 defaultCodexClientId 保持一致
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

type CodexAuthJson = {
  tokens?: { access_token?: string; refresh_token?: string; account_id?: string };
  account_id?: string;
};

function loadAuthJson(): { accessToken: string; refreshToken: string | null; accountId: string | null } | null {
  const path = process.env.CODEX_AUTH_JSON
    ? resolve(process.env.CODEX_AUTH_JSON)
    : resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".codex/auth.json");
  if (!existsSync(path)) return null;
  let raw: CodexAuthJson;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as CodexAuthJson;
  } catch {
    return null;
  }
  const accessToken = raw.tokens?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  return {
    accessToken,
    refreshToken: typeof raw.tokens?.refresh_token === "string" ? raw.tokens.refresh_token : null,
    accountId:
      typeof raw.tokens?.account_id === "string"
        ? raw.tokens.account_id
        : typeof raw.account_id === "string"
          ? raw.account_id
          : null,
  };
}

// 脱敏：长字符串只留首尾片段与长度；数组只看前两项
function maskValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= 8) return "***";
    return `${value.slice(0, 4)}...${value.slice(-3)} (${value.length} chars)`;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, 2).map(maskValue);
    return value.length > 2 ? [...head, `(${value.length} items)`] : head;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, maskValue(entry)]));
  }
  return value;
}

async function probe(name: string, url: string, init: RequestInit): Promise<void> {
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    let body: unknown;
    try {
      body = maskValue(JSON.parse(text));
    } catch {
      // 非 JSON 响应只打印长度与前 200 字符：异常路径（如 Cloudflare 拦截页、网关错误页）的
      // 文本未经脱敏处理，可能携带 token、cookie 等敏感片段，不能像 JSON 那样大段输出
      body = `(non-JSON, ${text.length} chars) ${text.slice(0, 200)}`;
    }
    console.log(`\n=== ${name} → HTTP ${response.status} (cf-mitigated: ${response.headers.get("cf-mitigated") ?? "(none)"}) ===`);
    console.log(JSON.stringify(body, null, 2));
  } catch (error) {
    console.log(`\n=== ${name} → 请求失败: ${error instanceof Error ? error.message : String(error)} ===`);
  }
}

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function main(): Promise<void> {
  const auth = loadAuthJson();
  if (!auth) {
    console.error("[FAIL] 未找到 ~/.codex/auth.json 或缺少 tokens.access_token（请先在 Codex CLI 登录）");
    process.exit(1);
  }
  console.log(`[OK] auth.json 已读取（account_id: ${auth.accountId ?? "(missing)"}）`);

  await probe("codex rate_limits (Bearer + chatgpt-account-id)", CODEX_RATE_LIMITS_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${auth.accessToken}`,
      ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
    },
  });

  if (process.argv.includes("--refresh") && auth.refreshToken) {
    await probe("token refresh（响应含新 token，已脱敏）", CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken,
      }),
    });
  } else {
    console.log("\n[SKIP] 未传 --refresh 或无 refresh token，跳过刷新端点探测（避免轮换）");
  }

  const sessionToken = process.env.CHATGPT_SESSION_TOKEN;
  if (sessionToken) {
    const session = await fetch(WEB_SESSION_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: `__Secure-next-auth.session-token=${sessionToken}`,
        "User-Agent": BROWSER_UA,
      },
    });
    const sessionPayload = (await session.json().catch(() => null)) as { accessToken?: string } | null;
    console.log(`\n=== web session → HTTP ${session.status}，accessToken: ${sessionPayload?.accessToken ? "已获取" : "未获取"} ===`);
    if (sessionPayload?.accessToken) {
      await probe("web rate_limits (Bearer accessToken)", WEB_RATE_LIMITS_URL, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${sessionPayload.accessToken}`,
          "User-Agent": BROWSER_UA,
        },
      });
      await probe("subscription accounts/check (Bearer accessToken)", SUBSCRIPTION_CHECK_URL, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${sessionPayload.accessToken}`,
          "User-Agent": BROWSER_UA,
        },
      });
    }
  } else {
    console.log("[SKIP] 未设置 CHATGPT_SESSION_TOKEN，跳过网页/订阅端点探测");
  }

  console.log("\n[DONE] 请把上方结构骨架与 worker/providers/chatgpt-parser.ts 的解析键核对；");
  console.log("      不符时修正解析器键名/常量并同步更新 tests/worker/providers.test.ts 对应断言。");
}

main().catch((err) => {
  console.error("[FAIL] 脚本执行失败:", err);
  process.exit(1);
});
