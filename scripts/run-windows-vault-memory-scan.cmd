@echo off
net.exe session >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoLogo -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Public\smoke-windows-vault-lifecycle.ps1" -SkipRelock
echo.
echo Result:
type "C:\Users\Public\inflow-windows-vault-lifecycle.log"
echo.
pause
