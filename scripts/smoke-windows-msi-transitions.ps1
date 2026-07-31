param(
  [string]$Executable = 'C:\Program Files\InFlow\inflow.exe',
  [string]$FixtureRoot = 'C:\Users\Public\inflow-msi-transitions',
  [string]$Report = 'C:\Users\Public\inflow-windows-msi-transitions.log'
)

$ErrorActionPreference = 'Stop'
$results = [System.Collections.Generic.List[string]]::new()
$oldVersion = '0.9.0'
$newVersion = '0.9.1'
$oldMsi = Join-Path $FixtureRoot "inflow-$oldVersion-windows-arm64.msi"
$newMsi = Join-Path $FixtureRoot "inflow-$newVersion-windows-arm64.msi"

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) {
    throw $Message
  }
}

function Add-Result([string]$Message) {
  $results.Add("PASS: $Message")
}

function Get-InFlowProduct {
  $roots = @(
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  return $roots |
    ForEach-Object { Get-ItemProperty $_ -ErrorAction SilentlyContinue } |
    Where-Object { $_.DisplayName -eq 'InFlow' -and $_.Publisher -eq 'Jarwin, Inc.' } |
    Select-Object -First 1
}

function Assert-InstalledVersion([string]$Expected) {
  $product = Get-InFlowProduct
  Assert-True ($null -ne $product) 'InFlow is not registered as an installed MSI product.'
  Assert-True ($product.DisplayVersion -eq $Expected) (
    "Expected installed version $Expected, received $($product.DisplayVersion)."
  )
}

function Invoke-Msi([string[]]$Arguments) {
  $log = Join-Path $env:TEMP "inflow-msi-$([Guid]::NewGuid().ToString('N')).log"
  $allArguments = $Arguments + @('/qn', '/norestart', '/L*v', "`"$log`"")
  $process = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" `
    -ArgumentList $allArguments -Wait -PassThru
  return @{
    ExitCode = $process.ExitCode
    Log = $log
  }
}

function Invoke-InFlowJson([string[]]$Arguments) {
  $output = & $Executable @Arguments 2>&1
  Assert-True ($LASTEXITCODE -eq 0) "InFlow failed: $($output -join [Environment]::NewLine)"
  return ($output -join [Environment]::NewLine) | ConvertFrom-Json
}

function Get-VaultState {
  return (Invoke-InFlowJson @('vault', 'status', '--format', 'json')).lock_state
}

function Lock-Vault {
  if ((Get-VaultState) -eq 'unlocked') {
    Invoke-InFlowJson @('vault', 'lock', '--format', 'json') | Out-Null
  }
  Assert-True ((Get-VaultState) -eq 'locked') 'The initialized vault could not be locked.'
}

function Unlock-And-Verify([string]$Prompt) {
  Write-Host ''
  Write-Host $Prompt
  & $Executable vault unlock
  Assert-True ($LASTEXITCODE -eq 0) 'Vault unlock failed after an MSI transition.'
  Assert-True ((Get-VaultState) -eq 'unlocked') 'The vault did not remain unlocked after an MSI transition.'
}

try {
  Assert-True (Test-Path -LiteralPath $oldMsi -PathType Leaf) "The old MSI is missing: $oldMsi"
  Assert-True (Test-Path -LiteralPath $newMsi -PathType Leaf) "The new MSI is missing: $newMsi"
  foreach ($path in @($oldMsi, $newMsi)) {
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    Assert-True (
      $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid
    ) "The MSI signature is invalid: $path"
  }
  Assert-InstalledVersion $oldVersion
  Assert-True ((Get-VaultState) -ne 'not_initialized') 'The transition test requires an initialized vault.'
  Lock-Vault

  $upgrade = Invoke-Msi @('/i', "`"$newMsi`"")
  Assert-True ($upgrade.ExitCode -in @(0, 3010)) "MSI upgrade failed with $($upgrade.ExitCode). Log: $($upgrade.Log)"
  Assert-InstalledVersion $newVersion
  Assert-True ((Get-VaultState) -eq 'locked') 'The vault was not preserved as locked after upgrade.'
  Unlock-And-Verify 'Enter the replacement vault passphrase to verify the 0.9.1 upgrade.'
  Add-Result '0.9.0 to 0.9.1 upgrade and vault preservation'

  Lock-Vault
  $rejectedDowngrade = Invoke-Msi @('/i', "`"$oldMsi`"")
  Assert-True ($rejectedDowngrade.ExitCode -ne 0) 'The MSI unexpectedly allowed a direct downgrade.'
  Assert-InstalledVersion $newVersion
  Assert-True ((Get-VaultState) -eq 'locked') 'Rejected downgrade changed the vault lock state.'
  Add-Result 'direct downgrade rejection without installed-state or vault-state loss'

  $newProduct = Get-InFlowProduct
  $uninstall = Invoke-Msi @('/x', $newProduct.PSChildName)
  Assert-True ($uninstall.ExitCode -in @(0, 3010)) (
    "MSI uninstall before rollback failed with $($uninstall.ExitCode). Log: $($uninstall.Log)"
  )
  Assert-True ($null -eq (Get-InFlowProduct)) 'The newer MSI remained registered after uninstall.'

  $rollback = Invoke-Msi @('/i', "`"$oldMsi`"")
  Assert-True ($rollback.ExitCode -in @(0, 3010)) (
    "MSI rollback install failed with $($rollback.ExitCode). Log: $($rollback.Log)"
  )
  Assert-InstalledVersion $oldVersion
  Assert-True ((Get-VaultState) -eq 'locked') 'The vault was not preserved as locked after rollback.'
  Unlock-And-Verify 'Enter the same vault passphrase to verify rollback to 0.9.0.'
  Add-Result 'supported uninstall/install rollback and vault preservation'

  Lock-Vault
  $reupgrade = Invoke-Msi @('/i', "`"$newMsi`"")
  Assert-True ($reupgrade.ExitCode -in @(0, 3010)) (
    "MSI re-upgrade failed with $($reupgrade.ExitCode). Log: $($reupgrade.Log)"
  )
  Assert-InstalledVersion $newVersion
  Assert-True ((Get-VaultState) -eq 'locked') 'The vault was not preserved as locked after re-upgrade.'
  Unlock-And-Verify 'Enter the same vault passphrase once more to verify the final 0.9.1 installation.'
  Add-Result 'final re-upgrade and vault preservation'
  $results.Add('Windows MSI transition smoke passed.')
} catch {
  $results.Add("FAIL: $($_.Exception.Message)")
  throw
} finally {
  $results | Set-Content -LiteralPath $Report -Encoding ascii
}
