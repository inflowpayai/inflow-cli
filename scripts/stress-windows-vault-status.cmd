@echo off
setlocal
set "REPORT=C:\Users\Public\inflow-status-stress.log"
break > "%REPORT%"
for /l %%I in (1,1,25) do (
  "C:\Program Files\InFlow\inflow.exe" vault status --format json >> "%REPORT%" 2>&1
  if errorlevel 1 (
    echo FAILED_ITERATION=%%I>> "%REPORT%"
    exit /b 1
  )
)
echo PASS=25>> "%REPORT%"
