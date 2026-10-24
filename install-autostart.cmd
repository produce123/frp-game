@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 装开机自启（登录时悄悄启动服务端）===
echo.
node tools\service.mjs autostart-install
echo.
echo 如果上面说失败，请右键这个文件 - 以管理员身份运行，再试一次。
echo.
pause