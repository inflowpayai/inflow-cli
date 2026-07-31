@echo off
setlocal
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d C:\Users\Public\inflow-windows-msi
call corepack.cmd pnpm --filter @inflowpayai/inflow-core exec vitest run test/unit/secure-storage/vault-local-backend.test.ts --coverage=false > "C:\Users\Public\inflow-windows-backend-test.log" 2>&1
echo EXIT=%ERRORLEVEL%>> "C:\Users\Public\inflow-windows-backend-test.log"
