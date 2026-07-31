$ErrorActionPreference = 'Stop'
$report = 'C:\Users\Public\inflow-powershell-scan-compat.log'

function Read-CompatibleFile([string]$Path) {
  $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
  $stream = [System.IO.File]::Open(
    $Path,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    $share
  )
  $memory = [System.IO.MemoryStream]::new()
  try {
    $stream.CopyTo($memory)
    Write-Output -NoEnumerate $memory.ToArray()
  } finally {
    $memory.Dispose()
    $stream.Dispose()
  }
}

try {
  $utf8 = [System.Text.Encoding]::UTF8.GetBytes('compatibility-secret')
  $hexadecimal = [BitConverter]::ToString($utf8).Replace('-', '')
  $representations = [System.Collections.Generic.List[byte[]]]::new()
  $representations.Add($utf8)
  $representations.Add([System.Text.Encoding]::Unicode.GetBytes('compatibility-secret'))
  $representations.Add([System.Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String($utf8)))
  $representations.Add([System.Text.Encoding]::ASCII.GetBytes($hexadecimal.ToLowerInvariant()))
  $representations.Add([System.Text.Encoding]::ASCII.GetBytes($hexadecimal))
  if ($representations.Count -ne 5) {
    throw 'Typed representation construction failed.'
  }
  foreach ($representation in $representations) {
    if ($null -eq $representation -or $representation.GetType() -ne [byte[]]) {
      throw 'A representation is not a byte array.'
    }
    [Array]::Clear($representation, 0, $representation.Length)
  }

  foreach ($file in Get-ChildItem -LiteralPath 'C:\ProgramData\InFlow\vaults' -File -Recurse -Force) {
    [byte[]]$contents = Read-CompatibleFile $file.FullName
    if ($null -eq $contents) {
      throw "Reading $($file.FullName) returned null."
    }
    [Array]::Clear($contents, 0, $contents.Length)
  }
  'Windows PowerShell 5.1 scan compatibility passed.' | Set-Content -LiteralPath $report -Encoding ascii
} catch {
  "FAIL: $($_.Exception.Message)" | Set-Content -LiteralPath $report -Encoding ascii
  throw
}
