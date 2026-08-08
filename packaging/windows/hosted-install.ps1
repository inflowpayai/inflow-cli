# InFlow CLI installer - served at https://inflowcli.ai/install.ps1
# Usage: Invoke-RestMethod https://inflowcli.ai/install.ps1 | Invoke-Expression
$ErrorActionPreference = 'Stop'

$repository = 'inflowpayai/inflow-cli'
$headers = @{ 'User-Agent' = 'inflow-installer' }
$expectedPublisher = 'CN="Jarwin, Inc.", O="Jarwin, Inc.", L=Gilroy, S=California, C=US'
$uninstall = $env:INFLOW_UNINSTALL -eq '1'
if ($uninstall) {
  $product = Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' |
    Where-Object { $_.DisplayName -eq 'InFlow' -and $_.Publisher -eq 'Jarwin, Inc.' } |
    Select-Object -First 1
  if ($null -eq $product) {
    Write-Output 'InFlow is not installed.'
    exit 0
  }
  $process = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" `
    -ArgumentList @('/x', $product.PSChildName, '/qn', '/norestart') -Verb RunAs -Wait -PassThru
  if ($process.ExitCode -notin @(0, 3010)) {
    throw "InFlow uninstall failed with Windows Installer exit code $($process.ExitCode)."
  }
  Write-Output 'InFlow was uninstalled. Encrypted vault data was preserved.'
  exit 0
}

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($architecture -notin @('x64', 'arm64')) {
  throw "InFlow is not published for Windows architecture '$architecture'."
}
$release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repository/releases/latest"
$tag = [string]$release.tag_name
$tagMatch = [regex]::Match($tag, '^v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$')
if (-not $tagMatch.Success) {
  throw 'Could not resolve the latest signed InFlow release.'
}
$version = $tagMatch.Groups[1].Value
if ($release.draft -or $release.prerelease -or $release.immutable -ne $true) {
  throw 'The latest InFlow release is not published and immutable.'
}
$assetName = "inflow-$version-windows-$architecture.msi"
$assets = @($release.assets | Where-Object { $_.name -eq $assetName })
if ($assets.Count -ne 1) {
  throw "The latest InFlow release does not contain exactly one $architecture installer."
}
$asset = $assets[0]
$expectedUri = "https://github.com/$repository/releases/download/$tag/$assetName"
if ([string]$asset.browser_download_url -ne $expectedUri) {
  throw 'The InFlow installer URL is invalid.'
}
$digest = [string]$asset.digest
$digestMatch = [regex]::Match($digest, '^sha256:([0-9a-fA-F]{64})$')
if (-not $digestMatch.Success) {
  throw 'The InFlow installer digest is invalid.'
}
$expectedHash = $digestMatch.Groups[1].Value.ToLowerInvariant()
$installerPath = Join-Path ([System.IO.Path]::GetTempPath()) "$([Guid]::NewGuid()).msi"
$logPath = Join-Path ([System.IO.Path]::GetTempPath()) "inflow-install-$([Guid]::NewGuid()).log"
try {
  Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $expectedUri -OutFile $installerPath
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    throw 'The InFlow installer checksum is invalid.'
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $installerPath
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "The InFlow installer signature is invalid: $($signature.StatusMessage)"
  }
  if ($signature.SignerCertificate.Subject -ne $expectedPublisher) {
    throw "The InFlow installer publisher is invalid: $($signature.SignerCertificate.Subject)"
  }
  $arguments = @('/i', "`"$installerPath`"", '/qn', '/norestart', '/L*v', "`"$logPath`"")
  $process = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" `
    -ArgumentList $arguments -Verb RunAs -Wait -PassThru
  if ($process.ExitCode -notin @(0, 3010)) {
    throw "The InFlow installer failed with Windows Installer exit code $($process.ExitCode). Log: $logPath"
  }
  if ($process.ExitCode -eq 3010) {
    Write-Output 'InFlow was installed. Windows requested a restart.'
  } else {
    Write-Output 'InFlow was installed.'
  }
} finally {
  Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
}
