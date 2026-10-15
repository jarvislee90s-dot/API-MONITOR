/**
 * ChatGPT 凭据一次性导入脚本（需用户真实环境执行）
 *
 * 1. 读取 ~/.codex/auth.json（Codex CLI 登录产物），提取 accessToken / refreshToken / accountId；
 * 2. 复用项目专用浏览器 Profile（output/chatgpt-browser-profile，已 gitignore）打开 chatgpt.com，
 *    已登录则提取 __Secure-next-auth.session-token 并调 /api/auth/session 验证服务端仍认可，
 *    未登录（含 Profile 残留已被服务端失效的死 cookie）时等待人工 Google 登录（不自动化登录）；
 * 3. 用 accessToken 试调一次 codex rate_limits，成功才继续；
 * 4. AES-GCM 加密凭据，按 provider_key=chatgpt + account_label=默认账号 upsert 到 Supabase；
 * 5. --check 干跑：只读取与校验，不写库。
 *
 * 使用：
 *   node --experimental-strip-types scripts/import-chatgpt-credentials.ts --check
 *   node --experimental-strip-types scripts/import-chatgpt-credentials.ts [--skip-browser] [--auth-json <路径>]
 *
 *   --relogin：进入浏览器后先清除 Profile 中的旧 cookie，再走登录检测/等待（换账号或 cookie 污染时使用）。
 *   --web-only：只更新网页 session cookie（不读取/校验本地 codex token），用于登录态或订阅档位变化后的续期；
 *               写入时与 Supabase 已存凭据合并，不会抹掉 accessToken / refreshToken / accountId。
 *
 * 网络与凭据说明：
 *   - 检测到 Windows 系统代理（或 HTTPS_PROXY）时自动以 NODE_USE_ENV_PROXY=1 重启自身，使 Node fetch 走代理；
 *   - NextAuth 的 session token 超过单 cookie 上限会分片存储（.0/.1），脚本收集分片、
 *     按浏览器原样形态（name.0=v0; name.1=v1）存入 Supabase，Worker 侧原样回发；
 *   - 登录与否的唯一判定信号是服务端 /api/auth/session 验证，不做任何页面 DOM 选择器假设。
 *
 * 安全：auth.json 与 cookie 仅在内存中转，不复制进项目目录、不进 git；输出只打印脱敏 hint。
 * --check 干跑只读取与校验，不写库，也不依赖 .env（Supabase 配置仅在真正写入前加载）。
 */

import { resolve } from "node:path";
// 浏览器会话 / 代理自适配 / 页面内 fetch 等共享工具已抽到 chatgpt-browser.ts（与用量推送脚本共用）
import {
  AUTH_SESSION_URL,
  CHATGPT_HOME,
  CODEX_USAGE_URL,
  ensureProxyOrRespawn,
  extractSessionToken,
  fetchInPage,
  loadEnv,
  maskHint,
  readCodexAuthJson,
} from "./chatgpt-browser.ts"; // Node 类型剥离模式需要显式扩展名（scripts/ 不在 tsc 覆盖范围）

// 校验 codex token：优先在浏览器页面内同源请求（绕 CF 质询）；--skip-browser 时退回纯 fetch
async function validateCodexToken(
  codex: { accessToken: string; accountId: string | null },
  page?: import("playwright").Page,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${codex.accessToken}`,
    ...(codex.accountId ? { "chatgpt-account-id": codex.accountId } : {}),
  };
  let status: number | null = null;
  let cfMitigated: string | null = null;
  if (page) {
    const result = await fetchInPage(page, CODEX_USAGE_URL, headers);
    if (result) {
      status = result.status;
      cfMitigated = result.cfMitigated;
    }
  } else {
    try {
      const response = await fetch(CODEX_USAGE_URL, { method: "GET", headers });
      status = response.status;
      cfMitigated = response.headers.get("cf-mitigated");
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (status === null) return { ok: false, status: 0, error: "请求失败（页面内与直连 fetch 均未完成）" };
  if (status === 403 && cfMitigated === "challenge") {
    return { ok: false, status, error: `HTTP 403（Cloudflare 质询，请更换代理出口节点后重试）` };
  }
  if (status === 401 || status === 403) {
    return { ok: false, status, error: `HTTP ${status}，token 已失效（请在 Codex CLI 重新登录后再导入）` };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, status, error: `HTTP ${status}` };
  }
  return { ok: true, status };
}

// AES-GCM 加密，与 worker/security/credentials.ts 保持一致
async function encryptPayload(
  payload: Record<string, string>,
  rawKey: string,
): Promise<{ encryptedPayload: string; nonce: string; keyVersion: string }> {
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(rawKey);
  if (keyBytes.byteLength !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be 32 UTF-8 bytes");
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext);
  const bytesToB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
  return {
    encryptedPayload: bytesToB64(new Uint8Array(encrypted)),
    nonce: bytesToB64(nonce),
    keyVersion: "v1",
  };
}

// 按 provider_key=chatgpt + account_label=默认账号 写入加密凭据与脱敏 hint
async function upsertChatgptAccountCredentials(
  env: Record<string, string>,
  credentials: Record<string, string>,
): Promise<void> {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
  const userId = env.SUPABASE_USER_ID;

  if (!supabaseUrl || !serviceRoleKey || !encryptionKey || !userId) {
    console.warn("[WARN] 缺少 Supabase 配置（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CREDENTIAL_ENCRYPTION_KEY / SUPABASE_USER_ID），跳过凭据写入");
    return;
  }

  const accountLabel = "默认账号";
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // 1. 查找账号
  const findUrl = new URL("/rest/v1/provider_accounts", supabaseUrl);
  findUrl.searchParams.set("select", "id");
  findUrl.searchParams.set("user_id", `eq.${userId}`);
  findUrl.searchParams.set("provider_key", "eq.chatgpt");
  findUrl.searchParams.set("account_label", `eq.${accountLabel}`);
  findUrl.searchParams.set("limit", "1");

  const findResp = await fetch(findUrl, { headers });
  if (!findResp.ok) {
    console.warn(`[WARN] 查询 Supabase 账号失败: HTTP ${findResp.status}`);
    return;
  }
  const rows = (await findResp.json()) as Array<{ id: string }>;
  let accountId = rows[0]?.id ?? null;

  // 2. 未找到则创建
  if (!accountId) {
    const createResp = await fetch(new URL("/rest/v1/provider_accounts", supabaseUrl), {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: userId,
        provider_key: "chatgpt",
        display_name: accountLabel,
        account_label: accountLabel,
        source_url: CHATGPT_HOME,
        auth_mode: "configured",
        status: "ready",
      }),
    });
    if (!createResp.ok) {
      console.warn(`[WARN] 创建 Supabase 账号失败: HTTP ${createResp.status}`);
      return;
    }
    const created = (await createResp.json()) as Array<{ id: string }>;
    accountId = created[0]?.id ?? null;
    if (accountId) console.log(`[OK] 已创建 chatgpt 账号（label=${accountLabel}）`);
  }
  if (!accountId) {
    console.warn("[WARN] 无法确定账号 ID，跳过凭据写入");
    return;
  }

  // 3. 与已存凭据合并后再加密写入：只更新部分字段（如仅续期 session cookie）时不能抹掉其它字段
  let merged: Record<string, string> = { ...credentials };
  try {
    const { loadStoredChatgptCredential } = await import("./chatgpt-credentials.ts");
    const stored = await loadStoredChatgptCredential(env);
    if (stored?.credential) {
      merged = {
        ...(Object.fromEntries(
          Object.entries(stored.credential).filter(([, value]) => typeof value === "string" && value.length > 0),
        ) as Record<string, string>),
        ...credentials,
      };
      const kept = Object.keys(merged).filter((key) => !(key in credentials));
      if (kept.length > 0) console.log(`[INFO] 合并已存凭据，保留字段: ${kept.join(", ")}`);
    }
  } catch (error) {
    console.warn(`[WARN] 读取已存凭据失败，按新建写入：${error instanceof Error ? error.message : error}`);
  }

  const encrypted = await encryptPayload(merged, encryptionKey);
  const credUrl = new URL("/rest/v1/provider_account_credentials", supabaseUrl);
  credUrl.searchParams.set("on_conflict", "provider_account_id");
  const credResp = await fetch(credUrl, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      user_id: userId,
      provider_account_id: accountId,
      encrypted_payload: encrypted.encryptedPayload,
      nonce: encrypted.nonce,
      key_version: encrypted.keyVersion,
    }),
  });
  if (!credResp.ok) {
    console.warn(`[WARN] 加密凭据写入失败: HTTP ${credResp.status}`);
    console.warn("[WARN] 凭据未写入，账号状态未变更");
    return;
  }
  console.log("[OK] 加密凭据已写入 provider_account_credentials");

  // 4. 同步脱敏 hint 与账号状态（凭据写入成功才把账号标为 ready）
  const hint = Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, maskHint(value)]));
  const patchResp = await fetch(new URL(`/rest/v1/provider_accounts?id=eq.${accountId}`, supabaseUrl), {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({ credential_hint: hint, status: "ready", auth_mode: "configured" }),
  });
  console.log(patchResp.ok ? "[OK] 账号 credential_hint 已更新" : `[WARN] hint 更新失败: HTTP ${patchResp.status}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const skipBrowser = args.includes("--skip-browser");
  const forceRelogin = args.includes("--relogin");
  // --web-only：只续期网页 session cookie（换账号 / 让订阅档位与续费日期可见），
  // 不校验本地 codex token —— 本地 token 失效（如订阅变更被判废）时也能用
  const webOnly = args.includes("--web-only");
  const authJsonIndex = args.indexOf("--auth-json");
  const authJsonPath =
    authJsonIndex >= 0 && args[authJsonIndex + 1]
      ? resolve(args[authJsonIndex + 1]!)
      : resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".codex/auth.json");

  // --check 干跑只读取与校验，不写库，因此不加载 .env（loadEnv 延迟到真正写入前）

  const codex = webOnly ? null : readCodexAuthJson(authJsonPath);
  if (!webOnly && !codex) {
    console.error(`[FAIL] 未读取到 Codex 凭据：${authJsonPath} 缺少 tokens.access_token（请先在 Codex CLI 登录）`);
    process.exit(1);
  }
  if (codex) {
    console.log(`[OK] auth.json 已读取（accessToken ${maskHint(codex.accessToken)}）`);
  } else {
    console.log("[INFO] --web-only：只更新网页 session cookie，不读取本地 codex token");
  }

  let browser: Awaited<ReturnType<typeof extractSessionToken>> = null;
  let sessionToken: string | null = null;
  if (skipBrowser) {
    if (forceRelogin) {
      console.warn("[WARN] --relogin 与 --skip-browser 同时传入：未打开浏览器，--relogin 不生效");
    }
    console.warn("[WARN] --skip-browser：跳过网页 session cookie 提取（codex 校验退回直连 fetch，可能被 CF 质询拦截）");
  } else {
    browser = await extractSessionToken(forceRelogin);
    sessionToken = browser?.cookieHeader ?? null;
    if (sessionToken) {
      console.log(`[OK] session cookie 已提取并获服务端认可（${maskHint(sessionToken)}，共 ${sessionToken.length} 字符）`);
    } else {
      console.warn("[WARN] 未提取到 __Secure-next-auth.session-token（可仅用 Codex 凭据继续）");
    }
  }

  try {
    const credentials: Record<string, string> = {};
    if (codex) {
      console.log("[INFO] 校验 codex token ...");
      const validation = await validateCodexToken(codex, browser?.page);
      if (!validation.ok) {
        console.error(`[FAIL] codex token 校验失败：${validation.error}`);
        process.exitCode = 1;
        return;
      }
      console.log(`[OK] codex rate_limits HTTP ${validation.status}`);
      credentials.accessToken = codex.accessToken;
      if (codex.refreshToken) credentials.refreshToken = codex.refreshToken;
      if (codex.accountId) credentials.accountId = codex.accountId;
    }
    if (sessionToken) credentials.sessionToken = sessionToken;
    if (sessionToken && webOnly) {
      // 仅网页会话续期：至少要确认服务端认可该 cookie，避免写入死会话
      const sessionResult = await fetchInPage(browser!.page, AUTH_SESSION_URL, { Accept: "application/json" });
      if (sessionResult?.status !== 200) {
        console.error(`[FAIL] 网页 session 校验失败：HTTP ${sessionResult?.status ?? "(failed)"}`);
        process.exitCode = 1;
        return;
      }
      console.log("[OK] 网页 session 已获服务端认可");
    }

    if (checkOnly) {
      console.log("\n[--check] 干跑结束，未写入任何数据。将导入的字段：");
      for (const [key, value] of Object.entries(credentials)) {
        console.log(`  ${key} = ${maskHint(value)}`);
      }
      return;
    }

    // 真正写入前才加载 .env（--check 干跑不依赖 Supabase 配置）
    const env = loadEnv();
    await upsertChatgptAccountCredentials(env, credentials);
    console.log("\n━━━ 完成 ━━━");
    console.log("看板下次刷新即使用新凭据；Codex token 过期后由 Worker 自动刷新。");
    console.log("session cookie 约 30 天有效，过期后重新运行本脚本（第二期提供续期脚本）。");
  } finally {
    await browser?.context.close();
  }
}

// 检测到系统代理时上方函数会重启自身接管执行；正常路径才运行 main
if (!(await ensureProxyOrRespawn())) {
  main().catch((err) => {
    console.error("[FAIL] 脚本执行失败:", err);
    process.exit(1);
  });
}
