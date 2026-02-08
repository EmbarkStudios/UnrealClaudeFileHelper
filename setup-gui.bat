@echo off
cd /d "%~dp0"

:: Try the embark-claude-code installer venv first (has PySide6)
set "VENV_PYTHON=%USERPROFILE%\.claude\repos\installer-venv\Scripts\python.exe"
if exist "%VENV_PYTHON%" (
    "%VENV_PYTHON%" tools\launcher.py %*
    exit /b %ERRORLEVEL%
)

:: Fallback: system python
where python >nul 2>&1 && (
    python -c "import PySide6" >nul 2>&1 || pip install -q PySide6
    python tools\launcher.py %*
    exit /b %ERRORLEVEL%
)

echo Python not found. Install Python 3.10+ or run the embark-claude-code installer first.
pause
exit /b 1
