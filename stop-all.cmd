@echo off
rem AI Quota Dashboard - Windows one-click stop (desktop widget + tray + server)
rem Delegates to scripts\stop-all.ps1 (all logic lives there).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-all.ps1"
