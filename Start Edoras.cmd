@echo off
cd /d "%~dp0"
if not exist node_modules\.bin\tsc.cmd call npm install --include=dev
if errorlevel 1 (
  pause
  exit /b 1
)
call npm start
if errorlevel 1 pause
