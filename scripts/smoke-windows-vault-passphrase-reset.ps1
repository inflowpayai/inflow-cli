param(
  [string]$Executable = 'C:\Program Files\InFlow\inflow.exe',
  [string]$Report = 'C:\Users\Public\inflow-windows-vault-passphrase-reset.log',
  [switch]$SkipReset
)

$ErrorActionPreference = 'Stop'
$results = [System.Collections.Generic.List[string]]::new()

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) {
    throw $Message
  }
}

function Add-Result([string]$Message) {
  $results.Add("PASS: $Message")
}

function Invoke-InFlowJson([string[]]$Arguments) {
  $output = & $Executable @Arguments 2>&1
  Assert-True ($LASTEXITCODE -eq 0) "InFlow failed: $($output -join [Environment]::NewLine)"
  return ($output -join [Environment]::NewLine) | ConvertFrom-Json
}

function Get-VaultState {
  return (Invoke-InFlowJson @('vault', 'status', '--format', 'json')).lock_state
}

try {
  Assert-True (Test-Path -LiteralPath $Executable -PathType Leaf) "InFlow is not installed at $Executable."
  $initialState = Get-VaultState
  Assert-True ($initialState -ne 'not_initialized') 'The passphrase-change test requires an initialized vault.'

  if ($initialState -eq 'locked') {
    Write-Host 'Enter the CURRENT vault passphrase.'
    & $Executable vault unlock
    Assert-True ($LASTEXITCODE -eq 0) 'Unlock with the current passphrase failed.'
  }
  $stateAfterUnlock = Get-VaultState
  Assert-True ($stateAfterUnlock -eq 'unlocked') "Expected unlocked after unlock, received $stateAfterUnlock."

  Write-Host ''
  Write-Host 'Change the passphrase: enter the CURRENT passphrase once, then the NEW passphrase twice.'
  & $Executable vault change-passphrase
  Assert-True ($LASTEXITCODE -eq 0) 'Passphrase change failed.'
  Add-Result 'passphrase change'

  Invoke-InFlowJson @('vault', 'lock', '--format', 'json') | Out-Null
  Assert-True ((Get-VaultState) -eq 'locked') 'The vault did not lock after the passphrase change.'

  Write-Host ''
  Write-Host 'NEGATIVE TEST: enter the OLD passphrase. InFlow must reject it.'
  & $Executable vault unlock
  Assert-True ($LASTEXITCODE -ne 0) 'The old passphrase was accepted after the passphrase change.'
  Assert-True ((Get-VaultState) -eq 'locked') 'The vault did not remain locked after the old passphrase attempt.'
  Add-Result 'old passphrase rejection'

  Write-Host ''
  Write-Host 'POSITIVE TEST: enter the NEW passphrase. InFlow must accept it.'
  & $Executable vault unlock
  Assert-True ($LASTEXITCODE -eq 0) 'The new passphrase was rejected.'
  Assert-True ((Get-VaultState) -eq 'unlocked') 'The vault is not unlocked with the new passphrase.'
  Add-Result 'new passphrase unlock'

  if ($SkipReset) {
    $results.Add('Windows packaged vault passphrase-change smoke passed.')
    return
  }

  Write-Host ''
  Write-Host 'The reset test permanently removes this Windows user vault and its stored credentials.'
  $confirmation = Read-Host 'Type RESET to continue'
  Assert-True ($confirmation -ceq 'RESET') 'Reset test cancelled.'
  Invoke-InFlowJson @('vault', 'reset', '--force', '--format', 'json') | Out-Null
  Assert-True ((Get-VaultState) -eq 'not_initialized') 'The vault remained initialized after reset.'
  Add-Result 'vault reset and tenant-state removal'

  Write-Host ''
  Write-Host 'Create the replacement vault passphrase you want to keep after this test.'
  & $Executable vault unlock
  Assert-True ($LASTEXITCODE -eq 0) 'Vault reinitialization after reset failed.'
  Assert-True ((Get-VaultState) -eq 'unlocked') 'The replacement vault is not unlocked.'
  Add-Result 'clean reinitialization after reset'
} catch {
  $results.Add("FAIL: $($_.Exception.Message)")
  throw
} finally {
  $results | Set-Content -LiteralPath $Report -Encoding ascii
}
