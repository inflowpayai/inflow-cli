param(
  [string]$Installer = 'packaging/windows/hosted-install.ps1',
  [string]$Template = 'packaging/windows/install.ps1.template',
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
  $alreadyInstalled = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath `
    -Installer $installerPath -Scenario already-installed 2>&1
  if ($LASTEXITCODE -ne 0 -or ($alreadyInstalled -join "`n") -ne 'InFlow 1.2.3 is already installed.') {
    throw "The already-installed case failed: $($alreadyInstalled -join ' | ')"
  }
  $repeat = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath `
    -Installer $installerPath -Scenario repeat 2>&1
  if ($LASTEXITCODE -ne 0 -or ($repeat -join "`n") -ne "InFlow was installed.`nInFlow was installed.") {
    throw "The repeated install failed: $($repeat -join ' | ')"
  }
  $rendered = Join-Path $env:TEMP "inflow-installer-template-$PID.ps1"
  try {
    $fixtureHash = '28fc61bb6e3bc3ec42afd90ee73d74d38cbf718f5be49618e8210859708b92e9'
    $templateContent = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $Template).Path)
    $templateContent = $templateContent.Replace('__INFLOW_VERSION__', '1.2.3')
    $templateContent = $templateContent.Replace('__INFLOW_MSI_SHA256_X64__', $fixtureHash)
    $templateContent = $templateContent.Replace('__INFLOW_MSI_SHA256_ARM64__', $fixtureHash)
    $templateContent = $templateContent.Replace(
      '__INFLOW_WINDOWS_PUBLISHER__',
      'CN="Jarwin, Inc.", O="Jarwin, Inc.", L=Gilroy, S=California, C=US'
    )
    [System.IO.File]::WriteAllText($rendered, $templateContent)
    $templateSuccess = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath `
      -Installer $rendered -Scenario success 2>&1
    if ($LASTEXITCODE -ne 0 -or ($templateSuccess -join "`n") -ne 'InFlow was installed.') {
      throw "The rendered installer failed: $($templateSuccess -join ' | ')"
    }
    $templateAlreadyInstalled = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath `
      -Installer $rendered -Scenario already-installed 2>&1
    if ($LASTEXITCODE -ne 0 -or ($templateAlreadyInstalled -join "`n") -ne 'InFlow 1.2.3 is already installed.') {
      throw "The rendered already-installed case failed: $($templateAlreadyInstalled -join ' | ')"
    }
  } finally {
    Remove-Item -LiteralPath $rendered -Force -ErrorAction SilentlyContinue
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

$assetNames = @('inflow-1.2.3-windows-x64.msi', 'inflow-1.2.3-windows-arm64.msi')
$publisher = 'CN="Jarwin, Inc.", O="Jarwin, Inc.", L=Gilroy, S=California, C=US'
$testMsiHash = '28fc61bb6e3bc3ec42afd90ee73d74d38cbf718f5be49618e8210859708b92e9'
$systemType = (Get-CimInstance Win32_ComputerSystem).SystemType
$expectedArchitecture = if ($systemType -like 'ARM64-*') { 'arm64' } elseif ($systemType -like 'x64-*') { 'x64' } else {
  throw "The test does not support Windows system type '$systemType'."
}

function Invoke-RestMethod {
  param($Headers, $Uri)
  $assets = @($assetNames | ForEach-Object {
    $name = $_
    [pscustomobject]@{
      browser_download_url = if ($Scenario -eq 'invalid-url') {
        'https://example.com/inflow.msi'
      } else {
        "https://github.com/inflowpayai/inflow-cli/releases/download/v1.2.3/$name"
      }
      digest = if ($Scenario -eq 'invalid-digest') {
        'invalid'
      } elseif ($Scenario -eq 'checksum-mismatch') {
        "sha256:$('a' * 64)"
      } else {
        "sha256:$testMsiHash"
      }
      name = $name
    }
  })
  return [pscustomobject]@{
    assets = if ($Scenario -eq 'missing-asset') { @() } elseif ($Scenario -eq 'duplicate-asset') { @($assets + $assets) } else { $assets }
    draft = $false
    immutable = $Scenario -ne 'mutable-release'
    prerelease = $false
    tag_name = 'v1.2.3'
  }
}

function Invoke-WebRequest {
  param($Headers, $OutFile, $Uri, [switch]$UseBasicParsing)
  if ($Uri -notlike "*-windows-$expectedArchitecture.msi") {
    throw "The installer selected the wrong Windows architecture: $Uri"
  }
  [System.IO.File]::WriteAllText($OutFile, 'test msi')
}

function Get-ItemProperty {
  param($Path)
  if ($Scenario -eq 'already-installed') {
    return [pscustomobject]@{
      DisplayName = 'InFlow'
      DisplayVersion = '1.2.3'
      Publisher = 'Jarwin, Inc.'
      PSChildName = '{00000000-0000-0000-0000-000000000000}'
    }
  }
  return @()
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
if ($Scenario -eq 'repeat') {
  & $Installer
}
