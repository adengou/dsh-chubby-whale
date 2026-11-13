@echo off
rem start-all.cmd - open LAN proxy so the phone can reach whale-mobile on desktop DSH.
rem Logic lives in start-all.mjs (pure Node, no PowerShell): avoids AV heuristics on .ps1.
rem Requirement: DeepSeek Harness Desktop is running (127.0.0.1:8983).
chcp 65001 >nul
title Whale Mobile
node "%~dp0start-all.mjs"
echo.
echo Press any key to close this window - the proxy keeps running in background.
pause >nul
