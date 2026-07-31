$ErrorActionPreference = 'Stop'
$backup = 'C:\Users\Public\inflow-pagefile-backup.json'
$report = 'C:\Users\Public\inflow-pagefile-restore.log'

try {
  $saved = Get-Content -LiteralPath $backup -Raw | ConvertFrom-Json
  foreach ($setting in @(Get-CimInstance Win32_PageFileSetting -ErrorAction SilentlyContinue)) {
    Remove-CimInstance -InputObject $setting
  }
  Set-ItemProperty `
    -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management' `
    -Name PagingFiles `
    -Value ([string[]]@($saved.pagingFiles))
  $computer = Get-WmiObject Win32_ComputerSystem -EnableAllPrivileges
  $computer.AutomaticManagedPagefile = [bool]$saved.automaticManagedPagefile
  $computer.Put() | Out-Null
  if (-not [bool]$saved.automaticManagedPagefile) {
    foreach ($setting in @($saved.settings)) {
      New-CimInstance -ClassName Win32_PageFileSetting -Property @{
        InitialSize = [uint32]$setting.initialSize
        MaximumSize = [uint32]$setting.maximumSize
        Name = [string]$setting.name
      } | Out-Null
    }
  }
  $restored = Get-WmiObject Win32_ComputerSystem -EnableAllPrivileges
  if ([bool]$restored.AutomaticManagedPagefile -ne [bool]$saved.automaticManagedPagefile) {
    throw 'Windows did not accept the saved AutomaticManagedPagefile setting.'
  }
  'Original pagefile configuration restored. A reboot is required.' |
    Set-Content -LiteralPath $report -Encoding ascii
} catch {
  "FAIL: $($_.Exception.Message)" | Set-Content -LiteralPath $report -Encoding ascii
  throw
}
