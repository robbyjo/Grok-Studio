@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0release\Grok-Desktop-0.1.1-Portable.exe" (
  start "" "%~dp0release\Grok-Desktop-0.1.1-Portable.exe"
  exit /b 0
)
if exist "%~dp0release\win-unpacked\Grok Desktop.exe" (
  start "" "%~dp0release\win-unpacked\Grok Desktop.exe"
  exit /b 0
)
echo Build the app first with npm run build, then run npm start.
pause
