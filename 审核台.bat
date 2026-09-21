@echo off
chcp 65001 >nul
title EVEjs-mods review console
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org then run this again.
  pause
  exit /b 1
)
echo Starting EVEjs-mods review console...
node "scripts\review-console.mjs"
echo.
echo Console stopped.
pause