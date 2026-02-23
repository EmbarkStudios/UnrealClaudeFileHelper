@echo off
cd /d "%~dp0"
node src/setup-gui.js %*
pause
