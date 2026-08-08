param(
  [string]$Installer = 'packaging/windows/hosted-install.ps1',
  [string]$Scenario = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrEmpty($Scenario)) {
  $ErrorActionPreference = 'Continue'
  $installerPath = (Resolve-Path -LiteralPath $Installer).Path
  $success = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath `
    -Installer $installerPath -Scenario success 2>&1
  if ($LASTEXITCODE -ne 0 -or ($success -join "`n") -ne 'InFlow was installed.') {
    throw "The successful install failed: $($success -join ' | ')"
  }
  $failures = @(
    @('mutable-release', 'The latest InFlow release is not published and immutable.'),
    @('missing-asset', 'The latest InFlow release does not contain exactly one'),
    @('duplicate-asset', 'The latest InFlow release does not contain exactly one'),
    @('invalid-url', 'The InFlow installer URL is invalid.'),
    @('invalid-digest', 'The InFlow installer digest is invalid.'),
    @('invalid-signature', 'The InFlow installer signature is invalid: Not signed'),
    @('publisher-mismatch', 'The InFlow installer publisher is invalid: CN=Unexpected'),
    @('checksum-mismatch', 'The InFlow installer checksum is invalid.')
  )
  foreach ($failure in $failures) {
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath `
      -Installer $installerPath -Scenario $failure[0] 2>&1
    if ($LASTEXITCODE -eq 0) {
      throw "The $($failure[0]) case was accepted."
    }
    if (($output -join "`n") -notlike "*$($failure[1])*") {
      throw "The $($failure[0]) case returned an unexpected error: $($output -join ' | ')"
    }
  }
  Write-Output 'Windows hosted installer tests passed.'
  exit 0
}

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$assetName = "inflow-1.2.3-windows-$architecture.msi"
$publisher = 'CN="Jarwin, Inc.", O="Jarwin, Inc.", L=Gilroy, S=California, C=US'

function Invoke-RestMethod {
  param($Headers, $Uri)
  $asset = [pscustomobject]@{
    browser_download_url = if ($Scenario -eq 'invalid-url') {
      'https://example.com/inflow.msi'
    } else {
      "https://github.com/inflowpayai/inflow-cli/releases/download/v1.2.3/$assetName"
    }
    digest = if ($Scenario -eq 'invalid-digest') { 'invalid' } else { "sha256:$('a' * 64)" }
    name = $assetName
  }
  return [pscustomobject]@{
    assets = if ($Scenario -eq 'missing-asset') { @() } elseif ($Scenario -eq 'duplicate-asset') { @($asset, $asset) } else { @($asset) }
    draft = $false
    immutable = $Scenario -ne 'mutable-release'
    prerelease = $false
    tag_name = 'v1.2.3'
  }
}

function Invoke-WebRequest {
  param($Headers, $OutFile, $Uri, [switch]$UseBasicParsing)
  [System.IO.File]::WriteAllText($OutFile, 'test msi')
}

function Get-FileHash {
  param($Algorithm, $LiteralPath)
  return [pscustomobject]@{ Hash = if ($Scenario -eq 'checksum-mismatch') { 'b' * 64 } else { 'a' * 64 } }
}

function Get-AuthenticodeSignature {
  param($LiteralPath)
  return [pscustomobject]@{
    SignerCertificate = [pscustomobject]@{
      Subject = if ($Scenario -eq 'publisher-mismatch') { 'CN=Unexpected' } else { $publisher }
    }
    Status = if ($Scenario -eq 'invalid-signature') {
      [System.Management.Automation.SignatureStatus]::NotSigned
    } else {
      [System.Management.Automation.SignatureStatus]::Valid
    }
    StatusMessage = if ($Scenario -eq 'invalid-signature') { 'Not signed' } else { 'Valid' }
  }
}

function Start-Process {
  param($ArgumentList, $FilePath, [switch]$PassThru, $Verb, [switch]$Wait)
  return [pscustomobject]@{ ExitCode = 0 }
}

& $Installer
