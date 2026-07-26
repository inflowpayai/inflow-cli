@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0smoke-windows-vault-passphrase-reset.ps1" -SkipReset
echo.
echo Result:
type "C:\Users\Public\inflow-windows-vault-passphrase-reset.log"
echo.
pause
