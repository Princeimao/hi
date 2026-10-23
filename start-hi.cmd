@echo off
setlocal EnableDelayedExpansion
set ROOT=%~dp0
set LOG=%TEMP%\opencode
set ELECTRON_RUN_AS_NODE=
set ELECTRON_NO_ATTACH_CONSOLE=

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

echo [start-hi] backend (8787)...
cd /d "%ROOT%server"
start /b "" "node" "dist\index.js" > "%LOG%\hi-server.out" 2> "%LOG%\hi-server.err"

echo [start-hi] agent gateway...
cd /d "%ROOT%agents"
start /b "" "C:\Python314\python.exe" "-m" "hi_agents.gateway" > "%LOG%\hi-agents.out" 2> "%LOG%\hi-agents.err"

echo [start-hi] desktop island...
cd /d "%ROOT%"
start "" ""%ROOT%node_modules\electron\dist\electron.exe"" "%ROOT%desktop"

echo hi-app started. Windows may prompt once about defender/network on first launch.
