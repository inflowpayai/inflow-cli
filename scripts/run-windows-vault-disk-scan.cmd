@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Public\smoke-windows-vault-lifecycle.ps1" -SkipRelock
echo.
echo Result:
type "C:\Users\Public\inflow-windows-vault-lifecycle.log"
echo.
pause
