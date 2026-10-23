@echo off
docker stop hi-postgres >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8787 ^| findstr LISTENING') do taskkill /pid %%a /f >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do taskkill /pid %%a /f >nul 2>&1
taskkill /im electron.exe /f >nul 2>&1
echo hi-app stopped.
