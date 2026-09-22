@echo off
rem AI Quota Dashboard - Windows one-click start (server + tray + desktop widget)
rem Delegates to scripts\start-all.ps1 (all logic lives there).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-all.ps1"
echo.
echo Dashboard keeps running in the background. Press any key to close this window...
pause >nul
