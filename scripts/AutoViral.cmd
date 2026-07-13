@echo off
setlocal
set APPDIR=%~dp0..
set ELECTRON=%APPDIR%\AutoViral.exe
if not exist "%ELECTRON%" (
  echo AutoViral.exe not found. Please reinstall AutoViral.
  pause
  exit /b 1
)
start "" "%ELECTRON%" --no-sandbox %*
endlocal
