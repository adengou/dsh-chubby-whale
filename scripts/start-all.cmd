@echo off
rem scripts/start-all.cmd —— 双击启动 dsh web + LAN 代理（幂等，已在跑就跳过）
rem 实际逻辑在 start-all.mjs；服务在后台继续运行，本窗口可关闭。
title 肥鲸服务启动
node "%~dp0start-all.mjs"
echo.
echo 按任意键关闭此窗口（服务已在后台继续运行）…
pause >nul
