@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ==================================================
echo   ApiMonitor 本地预览（wrangler dev @ 127.0.0.1:8787）
echo ==================================================

if not exist ".env" (
    echo [FAIL] 缺少 .env（需要 Supabase 四键等配置），中止。
    pause
    exit /b 1
)

REM 1) 生成本地开发密钥文件 .dev.vars（wrangler dev 专用，已被 .gitignore 忽略）
if not exist ".dev.vars" (
    echo [INFO] 首次运行：从 .env 生成 .dev.vars ...
    powershell -NoProfile -Command "Copy-Item '.env' '.dev.vars'"
    if errorlevel 1 (
        echo [FAIL] .dev.vars 生成失败，中止。
        pause
        exit /b 1
    )
    echo [OK] 已生成 .dev.vars（本地专用，不进 git；改过 .env 后请删除 .dev.vars 重建）
) else (
    echo [SKIP] .dev.vars 已存在
)

REM 2) 生成本地 wrangler 配置：去掉 [browser] 段（Browser Rendering 不支持本地模拟）
echo [INFO] 生成本地配置 .dev-wrangler.toml（每次运行重建，已 gitignore）...
powershell -NoProfile -Command "$lines = Get-Content 'wrangler.toml'; $out = New-Object System.Collections.Generic.List[string]; $skip = $false; foreach ($l in $lines) { if ($l -match '^\[browser\]') { $skip = $true; continue }; if ($skip -and $l -match '^\[') { $skip = $false }; if (-not $skip) { $out.Add($l) } }; $out | Set-Content -Encoding UTF8 '.dev-wrangler.toml'"
if errorlevel 1 (
    echo [FAIL] 本地配置生成失败，中止。
    pause
    exit /b 1
)

REM 3) 构建前端：wrangler dev 从 frontend/dist 提供页面与同源 /api
echo [INFO] 构建前端 ...
call npm --prefix frontend run build
if errorlevel 1 (
    echo [FAIL] 前端构建失败，中止。
    pause
    exit /b 1
)

echo.
echo [提示] 如果还没导入 ChatGPT 凭据，先在另一个终端运行（本目录）：
echo        node --experimental-strip-types scripts/import-chatgpt-credentials.ts --check
echo        node --experimental-strip-types scripts/import-chatgpt-credentials.ts
echo        （数据会写入你的真实 Supabase，看板刷新即可见 ChatGPT 卡片）
echo.
echo [INFO] 启动本地 Worker，浏览器将自动打开 http://127.0.0.1:8787
echo        停止服务：回到本窗口按 Ctrl+C
echo        （本地模式不支持 opencode-go 的 Browser Rendering 链路，该卡本地不刷新属正常）
echo.
timeout /t 3 >nul
start "" "http://127.0.0.1:8787"
call npx wrangler dev -c .dev-wrangler.toml --port 8787
