@echo off
chcp 65001 >nul
title EVEjs-mods review console
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto NONODE
echo ============================================================
echo  EVEjs-mods review console
echo  repo : %CD%
echo  page : http://127.0.0.1:8790/
echo  Keep this window open while you use the page.
echo ============================================================
echo.
node --use-system-ca "scripts\review-console.mjs"
echo.
echo Console stopped.
pause
exit /b 0
:NONODE
echo [ERROR] Node.js not found.
echo Install Node.js from https://nodejs.org and run this file again.
pause
exit /b 1
