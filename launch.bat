@echo off
setlocal

echo ============================================
echo  Unreal Index Launcher
echo ============================================
echo.

:: Check Python is available
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Python not found. Install from https://www.python.org/ or via winget:
    echo   winget install Python.Python.3.12
    pause
    exit /b 1
)

:: Install dependencies from requirements.txt
echo Installing dependencies...
pip install -q -r tools\requirements.txt
if %errorlevel% neq 0 (
    echo ERROR: Failed to install dependencies.
    pause
    exit /b 1
)
echo Dependencies OK.
echo.

:: Launch the GUI — start /wait + exit avoids "Terminate batch job (Y/N)?" on Ctrl+C
echo Starting launcher...
start /wait "" python tools\launcher.py
exit /b 0
