@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ApiMonitor ChatGPT(Codex) 快速刷新

echo ============================================================
echo   ChatGPT (Codex) 快速刷新
echo   读 Codex 本地会话日志推送额度（与 CLI「剩余用量」同源）
echo   免代理、免浏览器、免验证码，通常 2 秒内完成
echo ============================================================
echo.

if not exist ".env" (
    echo [FAIL] 缺少 .env，中止。
    pause
    exit /b 1
)

node --experimental-strip-types scripts/refresh-chatgpt-usage.ts --local %*

echo.
if errorlevel 1 (
    echo [注意] 刷新失败：可能是最近没在 Codex 里发过请求（日志里还没有额度快照），
    echo        或 .env 缺少 INGEST_API_KEY / APIMONITOR_INGEST_URL。
) else (
    echo [完成] 打开看板刷新即可看到最新额度（卡片「推送时间」= Codex 观测到该额度的时间）。
)
echo.
echo [提示] 需要同时刷新智谱 / Ollama 时，双击 refresh-enabled.bat。
pause
