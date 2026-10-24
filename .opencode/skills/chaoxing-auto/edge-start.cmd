@echo off
setlocal
REM Launch Edge with CDP + browser-wide mute for chaoxing-auto.
REM Node cannot spawn child processes on this machine, so the browser must be started here.

set "PORT=9223"
set "PROFILE=D:\Vibe-Coding\chaoxing-auto\.cache\edge-profile"
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"

if not exist "%PROFILE%" mkdir "%PROFILE%"

start "" "%EDGE%" ^
  --remote-debugging-port=%PORT% ^
  --user-data-dir="%PROFILE%" ^
  --mute-audio ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-features=msEdgeSidebarV2 ^
  "https://i.chaoxing.com/base"

echo Edge started on port %PORT% (muted). Log in to chaoxing in that window if needed.
timeout /t 3 >nul
