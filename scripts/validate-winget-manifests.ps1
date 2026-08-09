param(
  [Parameter(Mandatory = $true)]
  [string]$ManifestDirectory
)

$ErrorActionPreference = 'Stop'

$winget = Get-Command winget.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
if ([string]::IsNullOrWhiteSpace($winget)) {
  $appInstaller = Get-AppxPackage -AllUsers -Name Microsoft.DesktopAppInstaller |
    Sort-Object Version -Descending |
    Select-Object -First 1
  if ($null -ne $appInstaller) {
    $candidate = Join-Path $appInstaller.InstallLocation 'winget.exe'
    if (Test-Path -LiteralPath $candidate) {
      $winget = $candidate
    }
  }
}

if ([string]::IsNullOrWhiteSpace($winget)) {
  throw 'WinGet is unavailable; generated manifests were not validated with the Windows Package Manager client.'
}

& $winget validate --manifest $ManifestDirectory --disable-interactivity
if ($LASTEXITCODE -ne 0) {
  throw "WinGet manifest validation failed with exit code $LASTEXITCODE."
}

Write-Output 'WinGet manifest validation passed.'
