@echo off
REM Start the unreal-index service (Docker-first, WSL fallback) and the file watcher.
REM Double-click this file or run from a command prompt.

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo  Unreal Index Service
echo  ====================
echo.

if not exist config.json (
    echo config.json not found.
    echo Run setup.bat to create your config, or copy config.example.json to config.json and edit it.
    pause
    exit /b 1
)

REM Check if WSL is available
wsl --status >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: WSL is not installed or not running.
    echo Install WSL: https://learn.microsoft.com/en-us/windows/wsl/install
    pause
    exit /b 1
)

REM Check if already running
for /f "tokens=*" %%i in ('wsl -- bash -c "curl -s http://127.0.0.1:3847/health 2>/dev/null && echo OK || echo DOWN"') do set "HEALTH=%%i"

echo !HEALTH! | findstr /C:"OK" >nul 2>&1
if !ERRORLEVEL! EQU 0 (
    echo  Service is already running.
    goto start_watcher
)

REM Convert Windows path to WSL /mnt/c/... path for Docker Compose
set "WIN_DIR=%~dp0"
set "WIN_DIR=%WIN_DIR:\=/%"
set "WSL_DIR=/mnt/c/%WIN_DIR:~3%"

REM Try Docker first (via WSL since Docker CLI is in WSL)
echo  Checking for Docker...
wsl -- bash -c "docker compose version" >nul 2>&1
if !ERRORLEVEL! EQU 0 (
    echo  Docker detected. Starting container...
    echo.
    wsl -- bash -c "cd '%WSL_DIR%' && docker compose up -d"
    if !ERRORLEVEL! EQU 0 (
        goto wait_loop
    )
    echo  Docker start failed, falling back to WSL...
    echo.
)

REM Fallback: Start via WSL systemd/screen
echo  Starting service in WSL...
echo.
wsl -- bash -c "export PATH=$HOME/local/node22/bin:$HOME/go/bin:/usr/local/go/bin:$PATH; for d in /mnt/c/Users/*/.[cC]laude/repos/embark-claude-index $HOME/.claude/repos/embark-claude-index $HOME/repos/unreal-index $HOME/.claude/repos/unreal-index; do if [ -f $d/start-service.sh ]; then cd $d && bash start-service.sh --bg; exit; fi; done; echo ERROR: Repo not found in WSL"

if !ERRORLEVEL! NEQ 0 (
    echo.
    echo  Failed to start service. Check logs:
    echo    wsl -- journalctl --user -u unreal-index -n 50 --no-pager
    echo.
    pause
    exit /b 1
)

REM Wait for service to come up
:wait_loop
echo  Waiting for service on port 3847...
set TRIES=0
:wait_check
if %TRIES% GEQ 30 (
    echo ERROR: Service did not start within 30s
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
curl -s http://127.0.0.1:3847/health >nul 2>&1 && goto service_up
set /a TRIES+=1
goto wait_check

:service_up
echo  Service is running.

:start_watcher
echo  Starting file watcher...
echo.
node src/watcher/watcher-client.js
