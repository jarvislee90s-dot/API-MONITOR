@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ApiMonitor 一键刷新（看板显示中的供应商）

echo ============================================================
echo   ApiMonitor 一键刷新
echo   先看「智谱 / Ollama / ChatGPT / OpenCode Go」谁在看板上显示，
echo   再依次刷新处于显示状态的那些账号。
echo ============================================================
echo.

if not exist ".env" (
    echo [FAIL] 缺少 .env（需要 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 等），中止。
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo [FAIL] 未找到 node，请先安装 Node.js 并加入 PATH。
    pause
    exit /b 1
)

echo [提示] 刷新动作说明：
echo        智谱    —— 账号密码登录刷新 cookie（可能出现验证码，需人工完成）
echo        Ollama  —— 专用 Profile 复用登录态，失效时会弹出浏览器登录
echo        ChatGPT —— 读 Codex 本地会话日志（免代理、免浏览器，秒级）
echo        OpenCode—— 需先关闭 Edge；未设首页显示的账号会被跳过
echo.
echo [提示] 只想看状态不刷新：refresh-enabled.bat --list
echo.

node --experimental-strip-types scripts/refresh-enabled-providers.ts %*

echo.
if errorlevel 1 (
    echo [注意] 有刷新项失败，详情见上方输出；看板会继续显示最近成功快照。
) else (
    echo [完成] 刷新流程结束，打开看板即可看到最新数据。
)
echo.
pause
