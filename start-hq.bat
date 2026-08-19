@echo off
REM ---------------------------------------------------------------------------
REM Claude HQ — start the control room.
REM
REM Despite the name, this depends on Claude for NOTHING. It is a plain Node
REM server that reads transcript files off disk and spawns OpenCode directly.
REM When Claude hits a usage limit, this keeps running and you keep dispatching
REM work — OpenCode bills a different provider entirely.
REM
REM Double-click this file, or pin it to the taskbar. Leave the window open;
REM closing it stops the dashboard.
REM ---------------------------------------------------------------------------

title Claude HQ - control room
cd /d "%~dp0"

echo.
echo   Starting Claude HQ...
echo   Dashboard will open at http://localhost:8737/dash
echo.
echo   This window must stay open. Close it to stop the dashboard.
echo.

REM NO_TUNNEL skips Cloudflare + Telegram — local only, nothing leaves the box.
set NO_TUNNEL=1
set OPEN_BROWSER=1

node server.js

echo.
echo   Dashboard stopped.
pause
