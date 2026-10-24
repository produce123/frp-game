@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 重启 frp-game 服务端 ===
echo.
node tools\service.mjs restart
echo.
pause