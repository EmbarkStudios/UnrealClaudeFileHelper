@echo off
:: Kill any existing setup-gui and watcher processes, then start fresh
cd /d "%~dp0"

echo Stopping old processes...
wmic process where "name='node.exe' and CommandLine like '%%setup-gui.js%%'" call terminate >nul 2>&1
wmic process where "name='node.exe' and CommandLine like '%%watcher-client.js%%'" call terminate >nul 2>&1
timeout /t 1 /nobreak >nul

echo Starting setup GUI on http://localhost:3846 ...
start "" http://localhost:3846
node src/setup-gui.js
