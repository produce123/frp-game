@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 卸掉开机自启 ===
echo.
node tools\service.mjs autostart-remove
echo.
pause