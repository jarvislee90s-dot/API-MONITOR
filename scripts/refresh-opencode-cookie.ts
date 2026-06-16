// scripts/refresh-opencode-cookie.ts
// 从 Chrome Profile 提取 OpenCode Go auth cookie，加密写入 Supabase

import { readFileSync } from "node:fs";
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
    const key = trimmed.slice(0, eqIdx);
    let value = trimmed.slice(eqIdx + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

async function main(): Promise<void> {
  const env = loadEnv();

  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_USER_ID", "CREDENTIAL_ENCRYPTION_KEY"];
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`缺少环境变量: ${missing.join(", ")}。请在 .env 中配置。`);
    process.exit(1);
  }

  console.log("✅ 环境变量加载成功");
}

main().catch((err) => {
  console.error("❌ 脚本执行失败:", err);
  process.exit(1);
});
