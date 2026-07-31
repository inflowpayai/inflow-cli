$ErrorActionPreference = 'Stop'
$backup = 'C:\Users\Public\inflow-pagefile-backup.json'
$report = 'C:\Users\Public\inflow-pagefile-disable.log'

try {
  $computer = Get-CimInstance Win32_ComputerSystem
  $settings = @(Get-CimInstance Win32_PageFileSetting -ErrorAction SilentlyContinue)
  $pagingFiles = @(
    (Get-ItemProperty `
      -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management' `
      -Name PagingFiles).PagingFiles
  )
  if (Test-Path -LiteralPath $backup) {
    $saved = Get-Content -LiteralPath $backup -Raw | ConvertFrom-Json
    $saved | Add-Member -NotePropertyName pagingFiles -NotePropertyValue $pagingFiles -Force
    $saved | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $backup -Encoding ascii
  } else {
    @{
      automaticManagedPagefile = [bool]$computer.AutomaticManagedPagefile
      pagingFiles = $pagingFiles
      settings = @(
        $settings | ForEach-Object {
          @{
            initialSize = [uint32]$_.InitialSize
            maximumSize = [uint32]$_.MaximumSize
            name = [string]$_.Name
          }
        }
      )
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $backup -Encoding ascii
  }

  Set-CimInstance -InputObject $computer -Property @{ AutomaticManagedPagefile = $false } | Out-Null
  foreach ($setting in $settings) {
    Remove-CimInstance -InputObject $setting
  }
  Set-ItemProperty `
    -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management' `
    -Name PagingFiles `
    -Value ([string[]]@())
  'Pagefile configuration disabled. A reboot is required.' |
    Set-Content -LiteralPath $report -Encoding ascii
} catch {
  "FAIL: $($_.Exception.Message)" | Set-Content -LiteralPath $report -Encoding ascii
  throw
}
