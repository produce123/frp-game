@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 关闭 frp-game 服务端 ===
echo.
node tools\service.mjs stop
echo.
echo 关掉之后它不会自己再起来，直到你下次登录 Windows（如果装了开机自启）。
echo.
pause