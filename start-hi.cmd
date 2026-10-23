@echo off
setlocal EnableDelayedExpansion
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

rem Logs live in a folder we control (the old %TEMP%\opencode may not exist).
set "LOG=%TEMP%\hi-logs"
if not exist "%LOG%" mkdir "%LOG%" >nul 2>&1

rem If these leak in from a terminal/IDE, electron.exe starts as plain Node
rem and the island window never opens.
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="

echo [start-hi] stopping anything already on 8787/8000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do taskkill /pid %%a /f >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000" ^| findstr "LISTENING"') do taskkill /pid %%a /f >nul 2>&1

echo [start-hi] postgres...
docker inspect hi-postgres >nul 2>&1
if errorlevel 1 (
  docker run -d --name hi-postgres -e POSTGRES_PASSWORD=hi -e POSTGRES_USER=hi -e POSTGRES_DB=hi -p 5432:5432 -v hi-pgdata:/var/lib/postgresql/data postgres:17 >nul 2>&1
) else (
  docker start hi-postgres >nul 2>&1
)
if errorlevel 1 echo [start-hi] WARNING: could not start postgres. Is Docker Desktop running?

rem Build outputs are gitignored. Without server\dist\index.js the backend dies
rem with MODULE_NOT_FOUND, and the island has nothing to load either.
rem Pass --build to force a rebuild after changing sources.
set "NEED_BUILD="
if /i "%~1"=="--build" set "NEED_BUILD=1"
if not exist "%ROOT%\shared\dist\index.js" set "NEED_BUILD=1"
if not exist "%ROOT%\server\dist\index.js" set "NEED_BUILD=1"
if not exist "%ROOT%\desktop\dist-electron\main.js" set "NEED_BUILD=1"
if not exist "%ROOT%\desktop\dist\index.html" set "NEED_BUILD=1"

if defined NEED_BUILD (
  echo [start-hi] building shared, server and desktop...
  pushd "%ROOT%"
  call npm run build -w shared
  if errorlevel 1 goto build_failed
  call npm run build -w server
  if errorlevel 1 goto build_failed
  call npm run build -w desktop
  if errorlevel 1 goto build_failed
  popd
)

echo [start-hi] backend (8787)...
pushd "%ROOT%\server"
start /b "" node "dist\index.js" > "%LOG%\hi-server.out" 2> "%LOG%\hi-server.err"
popd

echo [start-hi] waiting for backend...
set /a TRIES=0
:wait_backend
curl -fsS -o NUL http://localhost:8787/healthz >nul 2>&1
if not errorlevel 1 goto backend_ready
set /a TRIES+=1
if !TRIES! GEQ 20 goto backend_timeout
timeout /t 1 /nobreak >nul
goto wait_backend
:backend_timeout
echo [start-hi] WARNING: backend did not answer on :8787 - see "%LOG%\hi-server.err"
:backend_ready

set "PY="
where py >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  where python >nul 2>&1
  if not errorlevel 1 set "PY=python"
)

if defined PY (
  echo [start-hi] agent gateway...
  pushd "%ROOT%\agents"
  start /b "" !PY! -m hi_agents.gateway > "%LOG%\hi-agents.out" 2> "%LOG%\hi-agents.err"
  popd
) else (
  echo [start-hi] WARNING: Python not found; agent gateway skipped.
)

echo [start-hi] desktop island...
if not exist "%ROOT%\node_modules\electron\dist\electron.exe" (
  echo [start-hi] ERROR: Electron is missing. Run: npm install
  goto failed
)
start "" "%ROOT%\node_modules\electron\dist\electron.exe" "%ROOT%\desktop"

echo.
echo [start-hi] hi-app started. Logs: %LOG%
echo [start-hi] Tip: start-hi.cmd --build forces a fresh build.
exit /b 0

:build_failed
popd
echo [start-hi] build failed. Fix the errors above and run again.
exit /b 1

:failed
exit /b 1
