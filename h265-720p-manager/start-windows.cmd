@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 18+ and add it to PATH.
  pause
  exit /b 1
)
echo Opening H.265 manager: http://127.0.0.1:4008
start "" "http://127.0.0.1:4008"
node server.js
pause
