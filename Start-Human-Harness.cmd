@echo off
setlocal
cd /d "%~dp0"
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.19 or later, then run this launcher again.
  pause
  exit /b 1
)
if not exist "node_modules\next\package.json" (
  call npm.cmd ci
  if errorlevel 1 goto failed
)
call npm.cmd run local -- %*
if not errorlevel 1 exit /b 0
:failed
pause
exit /b 1
