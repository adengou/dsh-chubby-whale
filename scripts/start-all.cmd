@echo off
rem scripts/start-all.cmd —— 一键打通「桌面端 DSH → 手机版」（幂等，已在跑就跳过）
rem 逻辑在 start-all.mjs（Node 脚本）；不经过 PowerShell，避开杀软对 .ps1 的启发式误报。
rem 需要：DeepSeek Harness 桌面端已打开（监听 127.0.0.1:8983）。
title 肥鲸手机版打通
node "%~dp0start-all.mjs"
echo.
echo 按任意键关闭此窗口（LAN 代理已在后台继续运行）…
pause >nul
