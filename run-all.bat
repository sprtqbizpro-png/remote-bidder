@echo off
cd /d "%~dp0"
echo Starting backend and web...
start "Hidden Star - Backend" cmd /k "cd /d "%~dp0backend" && npm run dev"
start "Hidden Star - Web" cmd /k "cd /d "%~dp0web" && npm run dev"
echo Both services launched in separate windows.
