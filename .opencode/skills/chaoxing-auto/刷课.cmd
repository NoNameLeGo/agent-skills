@echo off
setlocal
chcp 65001 >nul
REM One-click: start muted debug Edge (9223) if needed, then run the course loop.
REM Keep this window OPEN. Do NOT minimize the Edge window.

cd /d "%~dp0"

set "PORT=9223"
set "PROFILE=%~dp0.cache\edge-profile"
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"

curl -s -m 2 --noproxy "*" http://127.0.0.1:%PORT%/json/version >nul 2>&1
if errorlevel 1 (
  echo [1/2] Starting debug Edge on port %PORT% ...
  if not exist "%PROFILE%" mkdir "%PROFILE%"
  start "" "%EDGE%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --mute-audio --no-first-run --no-default-browser-check "https://i.chaoxing.com/base"
  timeout /t 6 >nul
) else (
  echo [1/2] Edge already running on port %PORT%.
)

echo.
echo [2/2] Checking login state ...
node run.js status
if errorlevel 1 goto :end

echo.
echo Starting course loop. Press Ctrl+C to stop.
echo The web page MUST stay visible - do not minimize Edge.
echo.
node run.js course

:end
echo.
echo Done. Log: %~dp0state\course*.log
pause
