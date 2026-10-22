@echo off
rem bili-learn 本地仪表盘：双击启动，自动打开浏览器
chcp 65001 >nul
cd /d "%~dp0.."
if "%PORT%"=="" set PORT=8787

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%/'"
node dashboard\server.js

echo.
echo 服务已退出。按任意键关闭窗口。
pause >nul
