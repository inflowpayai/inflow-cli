@echo off
setlocal
set "REPORT=C:\Users\Public\inflow-diagnostic-install-start.log"
powershell.exe -NoLogo -NoProfile -Command "$service = Get-Service -Name InFlowVault; if ($service.Status -ne 'Stopped') { Stop-Service -Name InFlowVault; $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30)) }" > "%REPORT%" 2>&1
if errorlevel 1 exit /b 1
copy /y "C:\Users\Public\inflow-windows-msi\dist\windows\payload\inflow.exe" "C:\Program Files\InFlow\inflow.exe" >> "%REPORT%" 2>&1
if errorlevel 1 exit /b 1
copy /y "C:\Users\Public\inflow-windows-msi\dist\windows\payload\native\vault_peer_windows.node" "C:\Program Files\InFlow\native\vault_peer_windows.node" >> "%REPORT%" 2>&1
if errorlevel 1 exit /b 1
certutil.exe -hashfile "C:\Program Files\InFlow\inflow.exe" SHA256 >> "%REPORT%" 2>&1
certutil.exe -hashfile "C:\Program Files\InFlow\native\vault_peer_windows.node" SHA256 >> "%REPORT%" 2>&1
sc.exe start InFlowVault >> "%REPORT%" 2>&1
exit /b %ERRORLEVEL%
