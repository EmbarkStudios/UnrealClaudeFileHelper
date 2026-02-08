@echo off
cd /d "%~dp0"
node src/watcher/watcher-client.js %*
