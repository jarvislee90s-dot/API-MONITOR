/**
 * 一键刷新：列出「智谱 / Ollama / ChatGPT(Codex) / OpenCode Go」在看板上的启用状态，并依次刷新**启用中**的那些
 *
 * 由 refresh-enabled.bat 调用（也可单独运行）：
 *   node --experimental-strip-types scripts/refresh-enabled-providers.ts            # 列状态 + 依次刷新
 *   node --experimental-strip-types scripts/refresh-enabled-providers.ts --list      # 只看状态，不刷新
 *
 * 「看板显示」判定与 worker 的 buildProviderConfigs 一致：
 *   供应商启用（provider_preferences.enabled）且（存在首页启用账号 或 该供应商没有真实账号的入口型）
 * 刷新动作按供应商选用既有脚本：
 *   智谱       → refresh-zhipu-cookie.ts（账号密码登录刷新 cookie，云端即可取数）
 *   Ollama     → refresh-ollama-cookie.ts（专用 Profile，登录态失效时弹浏览器）
 *   ChatGPT    → refresh-chatgpt-usage.ts --local（读 Codex 本地会话日志，免浏览器免代理，秒级）
 *   OpenCode Go→ refresh-opencode-usage.ts（需先关闭 Edge，双账号串行抓取后推送）
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type ProviderPlan = {
  key: string;
  label: string;
  refreshArgs: string[];
  note: string;
};

const PROVIDERS: ProviderPlan[] = [
  {
    key: "zhipu",
    label: "智谱 BigModel",
    refreshArgs: ["scripts/refresh-zhipu-cookie.ts"],
    note: "账号密码登录刷新 cookie（可能需人工过验证码）",
  },
  {
    key: "ollama",
    label: "Ollama Pro",
    refreshArgs: ["scripts/refresh-ollama-cookie.ts"],
    note: "专用 Profile 复用登录态，失效时弹浏览器登录",
  },
  {
    key: "chatgpt",
    label: "ChatGPT (Codex)",
    refreshArgs: ["scripts/refresh-chatgpt-usage.ts", "--local"],
    note: "读 Codex 本地会话日志，免浏览器免代理",
  },
  {
    key: "opencode-go",
    label: "OpenCode Go",
    // --no-wait-login：一键刷新时不要在登录失效的账号上卡 5 分钟，直接跳过并提示
    refreshArgs: ["scripts/refresh-opencode-usage.ts", "--no-wait-login"],
    note: "需先关闭 Edge；双账号串行抓取后推送（登录失效时跳过）",
  },
];

function loadEnv(): Record<string, string> {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) throw new Error("未找到 .env（需要 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）");
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[trimmed.slice(0, eq).trim()] = value;
  }
  return vars;
}

type ProviderStatus = {
  providerKey: string;
  providerEnabled: boolean;
  homepageAccounts: number;
  totalAccounts: number;
  visible: boolean;
  skipReason: string | null;
};

async function readStatuses(env: Record<string, string>): Promise<ProviderStatus[]> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  }
  const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
  const keys = PROVIDERS.map((provider) => provider.key);

  const prefUrl = new URL("/rest/v1/provider_preferences", SUPABASE_URL);
  prefUrl.searchParams.set("select", "provider_key,enabled");
  prefUrl.searchParams.set("provider_key", `in.(${keys.join(",")})`);
  const preferences = (await (await fetch(prefUrl, { headers })).json()) as Array<{
    provider_key: string;
    enabled: boolean;
  }>;

  const accUrl = new URL("/rest/v1/provider_accounts", SUPABASE_URL);
  accUrl.searchParams.set("select", "provider_key,homepage_enabled");
  accUrl.searchParams.set("provider_key", `in.(${keys.join(",")})`);
  const accounts = (await (await fetch(accUrl, { headers })).json()) as Array<{
    provider_key: string;
    homepage_enabled: boolean | null;
  }>;

  const prefMap = new Map(preferences.map((row) => [row.provider_key, row.enabled !== false]));
  return PROVIDERS.map((provider) => {
    const providerAccounts = accounts.filter((row) => row.provider_key === provider.key);
    const homepageAccounts = providerAccounts.filter((row) => row.homepage_enabled === true).length;
    // 未落库的供应商：默认启用（与前端 createPreferences 的 enabled ?? true 一致）
    const providerEnabled = prefMap.get(provider.key) ?? true;
    const hasAnyAccount = providerAccounts.length > 0;
    const visible = providerEnabled && (!hasAnyAccount || homepageAccounts > 0);
    const skipReason = !providerEnabled
      ? "供应商已停用"
      : homepageAccounts === 0 && hasAnyAccount
        ? "账号均未设首页显示"
        : null;
    return {
      providerKey: provider.key,
      providerEnabled,
      homepageAccounts,
      totalAccounts: providerAccounts.length,
      visible,
      skipReason,
    };
  });
}

function runRefresh(plan: ProviderPlan): boolean {
  console.log("");
  console.log(`──────── 刷新 ${plan.label}（${plan.note}）────────`);
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", plan.refreshArgs[0]!, ...plan.refreshArgs.slice(1)],
    { stdio: "inherit" },
  );
  if (result.status === 0) {
    console.log(`[OK] ${plan.label} 刷新完成`);
    return true;
  }
  console.error(`[FAIL] ${plan.label} 刷新失败（退出码 ${result.status ?? "?"}），继续下一个`);
  return false;
}

async function main(): Promise<void> {
  const listOnly = process.argv.includes("--list");
  const env = loadEnv();
  const statuses = await readStatuses(env);

  console.log("");
  console.log("=========== 看板启用状态（智谱 / Ollama / ChatGPT / OpenCode Go）===========");
  console.log("供应商          供应商启用   首页账号   看板显示   说明");
  for (const plan of PROVIDERS) {
    const status = statuses.find((item) => item.providerKey === plan.key)!;
    console.log(
      [
        plan.label.padEnd(14, " "),
        (status.providerEnabled ? "启用" : "停用").padEnd(11, " "),
        `${status.homepageAccounts}/${status.totalAccounts}`.padEnd(10, " "),
        (status.visible ? "显示" : "不显示").padEnd(10, " "),
        status.skipReason ?? plan.note,
      ].join(" "),
    );
  }

  const targets = PROVIDERS.filter((plan) => statuses.find((item) => item.providerKey === plan.key)!.visible);
  console.log("");
  if (targets.length === 0) {
    console.log("[INFO] 没有处于「看板显示」状态的供应商，无需刷新。");
    return;
  }
  console.log(
    listOnly
      ? `[INFO] --list：以下 ${targets.length} 个供应商将参与刷新：${targets.map((plan) => plan.label).join("、")}`
      : `[INFO] 开始依次刷新 ${targets.length} 个在看板上显示的供应商：${targets.map((plan) => plan.label).join("、")}`,
  );
  if (listOnly) return;

  const results = targets.map((plan) => ({ label: plan.label, ok: runRefresh(plan) }));

  console.log("");
  console.log("=========== 刷新结果 ===========");
  for (const item of results) {
    console.log(`  ${item.ok ? "[OK]  " : "[FAIL]"} ${item.label}`);
  }
  const failed = results.filter((item) => !item.ok);
  if (failed.length > 0) {
    console.log("");
    console.log("[提示] 失败项通常是因为：代理未开（ChatGPT 非 --local 模式）、浏览器 Profile 被占用（先关闭对应浏览器）、");
    console.log("       登录态过期需要人工登录、或 .env 缺少该脚本所需变量。看板仍可查看失败项的最近成功快照。");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[FAIL]", error instanceof Error ? error.message : error);
  process.exit(1);
});
