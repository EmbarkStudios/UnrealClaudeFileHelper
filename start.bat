@echo off
title Unreal Index Dashboard
cd /d "%~dp0"

:: Kill any existing dashboard process on port 3846
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3846 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1

:: Start the dashboard
echo Starting dashboard at http://localhost:3846 ...
node src\setup-gui.js %*
