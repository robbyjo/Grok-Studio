@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0release\Grok-Workbench-0.6.3-Portable.exe" (
  start "" "%~dp0release\Grok-Workbench-0.6.3-Portable.exe"
  exit /b 0
)
if exist "%~dp0release\win-unpacked\Grok Workbench.exe" (
  start "" "%~dp0release\win-unpacked\Grok Workbench.exe"
  exit /b 0
)
if exist "%~dp0release\Grok-Studio-0.6.0-Portable.exe" (
  start "" "%~dp0release\Grok-Studio-0.6.0-Portable.exe"
  exit /b 0
)
if exist "%~dp0release\win-unpacked\Grok Studio.exe" (
  start "" "%~dp0release\win-unpacked\Grok Studio.exe"
  exit /b 0
)
echo Build the app first with npm run build, then run npm start.
pause
