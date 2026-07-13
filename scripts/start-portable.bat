@echo off
setlocal
set APPDIR=%~dp0..
set ELECTRON=%APPDIR%\AutoViral.exe
if not exist "%ELECTRON%" (
  echo AutoViral.exe not found in portable directory.
  pause
  exit /b 1
)
set AUTOVIRAL_DATA_DIR=%APPDIR%\data
if not exist "%AUTOVIRAL_DATA_DIR%" mkdir "%AUTOVIRAL_DATA_DIR%"
start "" "%ELECTRON%" --no-sandbox %*
endlocal
