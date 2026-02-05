@echo off
cd /d "%~dp0"

if not exist config.json (
    echo config.json not found.
    echo Run setup.bat to create your config, or copy config.example.json to config.json and edit it.
    pause
    exit /b 1
)

echo Starting Unreal Index Service...
node src/service/index.js
pause
