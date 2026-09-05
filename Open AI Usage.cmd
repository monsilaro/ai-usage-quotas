@echo off
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.16 or newer is required. Install from https://nodejs.org
  pause
  exit /b 1
)
node "%~dp0scripts\launch.mjs"
if errorlevel 1 pause
