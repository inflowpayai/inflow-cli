param(
  [string]$Repository = 'C:\Users\Public\inflow-windows-msi',
  [string]$FixtureRoot = 'C:\Users\Public\inflow-msi-transitions',
  [string]$NewVersion = '0.9.1',
  [string]$Report = 'C:\Users\Public\inflow-windows-transition-build.log'
)

$ErrorActionPreference = 'Stop'
$manifestPath = Join-Path $Repository 'packages\cli\package.json'
$oldMsi = Join-Path $Repository 'dist\windows\inflow-0.9.0-windows-arm64.msi'
$newMsi = Join-Path $Repository "dist\windows\inflow-$NewVersion-windows-arm64.msi"
$originalManifest = $null

try {
  if (-not (Test-Path -LiteralPath $oldMsi -PathType Leaf)) {
    throw "The preserved baseline MSI is missing: $oldMsi"
  }
  New-Item -ItemType Directory -Path $FixtureRoot -Force | Out-Null
  Copy-Item -LiteralPath $oldMsi -Destination (Join-Path $FixtureRoot 'inflow-0.9.0-windows-arm64.msi') -Force

  $originalManifest = [System.IO.File]::ReadAllBytes($manifestPath)
  $manifestText = [System.Text.Encoding]::UTF8.GetString($originalManifest)
  $updatedManifest = [regex]::Replace(
    $manifestText,
    '"version"\s*:\s*"[^"]+"',
    "`"version`": `"$NewVersion`"",
    1
  )
  if ($updatedManifest -ceq $manifestText) {
    throw 'The CLI package version was not updated.'
  }
  [System.IO.File]::WriteAllText(
    $manifestPath,
    $updatedManifest,
    [System.Text.UTF8Encoding]::new($false)
  )

  & 'C:\Users\Public\build-inflow-windows-permanent.cmd'
  if ($LASTEXITCODE -ne 0) {
    throw "The signed Windows build failed with exit code $LASTEXITCODE."
  }
  if (-not (Test-Path -LiteralPath $newMsi -PathType Leaf)) {
    throw "The signed transition MSI is missing: $newMsi"
  }
  Copy-Item -LiteralPath $newMsi -Destination (Join-Path $FixtureRoot "inflow-$NewVersion-windows-arm64.msi") -Force

  foreach ($path in @(
    (Join-Path $FixtureRoot 'inflow-0.9.0-windows-arm64.msi'),
    (Join-Path $FixtureRoot "inflow-$NewVersion-windows-arm64.msi")
  )) {
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
      throw "The signature is invalid for $path`: $($signature.StatusMessage)"
    }
  }

  @(
    'PASS: preserved signed 0.9.0 MSI'
    "PASS: built signed $NewVersion MSI"
    'PASS: both MSI signatures valid'
  ) | Set-Content -LiteralPath $Report -Encoding ascii
} catch {
  "FAIL: $($_.Exception.Message)" | Set-Content -LiteralPath $Report -Encoding ascii
  throw
} finally {
  if ($null -ne $originalManifest) {
    [System.IO.File]::WriteAllBytes($manifestPath, $originalManifest)
  }
}
