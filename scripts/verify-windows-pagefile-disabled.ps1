$ErrorActionPreference = 'Stop'
$report = 'C:\Users\Public\inflow-pagefile-status.log'

try {
  $automatic = [bool](Get-CimInstance Win32_ComputerSystem).AutomaticManagedPagefile
  $settings = @(Get-CimInstance Win32_PageFileSetting -ErrorAction SilentlyContinue)
  $usage = @(Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue)
  if ($automatic -or $settings.Count -ne 0 -or $usage.Count -ne 0) {
    throw "Pagefile remains configured or active: automatic=$automatic settings=$($settings.Count) usage=$($usage.Count)."
  }
  'Windows pagefile is disabled and inactive.' | Set-Content -LiteralPath $report -Encoding ascii
} catch {
  "FAIL: $($_.Exception.Message)" | Set-Content -LiteralPath $report -Encoding ascii
  throw
}
