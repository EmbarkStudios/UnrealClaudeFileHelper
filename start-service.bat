@echo off
REM Start the unreal-index Docker containers.
REM Double-click this file or run from a command prompt.
REM For full management, use the setup GUI: npm run setup (http://localhost:3846)

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo  Unreal Index Service
echo  ====================
echo.

REM Check if WSL/Docker is available
wsl --status >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: WSL is not installed or not running.
    echo Docker Desktop with WSL 2 backend is required.
    echo Install WSL: https://learn.microsoft.com/en-us/windows/wsl/install
    pause
    exit /b 1
)

wsl -- bash -c "docker compose version" >nul 2>&1
if !ERRORLEVEL! NEQ 0 (
    echo ERROR: Docker Compose not found in WSL.
    echo Install Docker Desktop with WSL 2 backend.
    pause
    exit /b 1
)

REM Convert Windows path to WSL /mnt/c/... path for Docker Compose
set "WIN_DIR=%~dp0"
set "WIN_DIR=%WIN_DIR:\=/%"
set "WSL_DIR=/mnt/c/%WIN_DIR:~3%"

REM Check if containers are already running
for /f "tokens=*" %%i in ('wsl -- bash -c "curl -s http://127.0.0.1:3847/health 2>/dev/null && echo OK || echo DOWN"') do set "HEALTH=%%i"

echo !HEALTH! | findstr /C:"OK" >nul 2>&1
if !ERRORLEVEL! EQU 0 (
    echo  Service is already running.
    echo  Open the dashboard at http://localhost:3846 to manage workspaces.
    pause
    exit /b 0
)

REM Start Docker containers
echo  Starting Docker containers...
echo.
wsl -- bash -c "cd '%WSL_DIR%' && docker compose up -d"

if !ERRORLEVEL! NEQ 0 (
    echo.
    echo  Failed to start containers. Check logs:
    echo    docker compose logs
    echo.
    echo  Or run the setup GUI to configure workspaces:
    echo    npm run setup
    pause
    exit /b 1
)

REM Wait for service to come up
echo  Waiting for service on port 3847...
set TRIES=0
:wait_check
if %TRIES% GEQ 60 (
    echo ERROR: Service did not start within 60s
    echo Check logs: docker compose logs
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
curl -s http://127.0.0.1:3847/health >nul 2>&1 && goto service_up
set /a TRIES+=1
goto wait_check

:service_up
echo  Service is running.
echo.
echo  To start file watchers, use the setup GUI dashboard:
echo    npm run setup
echo    http://localhost:3846
echo.
pause
