$memoryPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management'
$crashPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl'
$computer = Get-CimInstance Win32_ComputerSystem
$memory = Get-ItemProperty -LiteralPath $memoryPath
$crash = Get-ItemProperty -LiteralPath $crashPath
@{
  automaticManagedPagefile = [bool]$computer.AutomaticManagedPagefile
  crashDumpEnabled = $crash.CrashDumpEnabled
  existingPageFiles = @($memory.ExistingPageFiles)
  pagingFiles = @($memory.PagingFiles)
  settings = @(
    Get-CimInstance Win32_PageFileSetting -ErrorAction SilentlyContinue |
      Select-Object Name, InitialSize, MaximumSize
  )
  usage = @(
    Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue |
      Select-Object Name, AllocatedBaseSize, CurrentUsage, PeakUsage, TempPageFile
  )
} | ConvertTo-Json -Depth 5 |
  Set-Content -LiteralPath 'C:\Users\Public\inflow-pagefile-diagnostic.json' -Encoding ascii
