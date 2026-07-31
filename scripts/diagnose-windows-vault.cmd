@echo off
sc.exe stop InFlowVault >nul 2>&1
:wait_for_stop
sc.exe query InFlowVault | find "STATE" | find "STOPPED" >nul
if errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto wait_for_stop
)
"C:\Program Files\InFlow\inflow.exe" vault status --format json > "C:\Users\Public\inflow-status-diagnostic.log" 2>&1
echo EXIT=%ERRORLEVEL%>> "C:\Users\Public\inflow-status-diagnostic.log"
