@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === frp-game 服务端状态 ===
echo.
node tools\service.mjs status
echo.
pause