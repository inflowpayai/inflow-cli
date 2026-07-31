@echo off
(
  echo ==== processes ====
  tasklist /v /fi "IMAGENAME eq inflow.exe"
  tasklist /v /fi "IMAGENAME eq powershell.exe"
  echo ==== jobs ====
  netstat -ano -p tcp
  echo ==== service ====
  sc.exe queryex InFlowVault
) > "C:\Users\Public\inflow-lifecycle-hang.log" 2>&1
