@echo off
title Unreal Index - Full Reindex
cd /d "%~dp0"
node scripts\full-reindex.js %*
pause
