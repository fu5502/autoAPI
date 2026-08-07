@echo off
setlocal
chcp 65001 >nul
set "AUTOAPI_ROOT=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%AUTOAPI_ROOT%start-autoapi.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo autoAPI launcher exited with code %EXIT_CODE%.
  pause
)
endlocal & exit /b %EXIT_CODE%
