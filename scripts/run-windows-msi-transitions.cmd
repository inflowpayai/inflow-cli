@echo off
net session >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoLogo -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0smoke-windows-msi-transitions.ps1"
echo.
echo Result:
type "C:\Users\Public\inflow-windows-msi-transitions.log"
echo.
pause
