param(
  [string]$Executable = 'C:\Program Files\InFlow\inflow.exe',
  [string]$NativeModule = 'C:\Program Files\InFlow\native\vault_peer_windows.node',
  [string]$Report = 'C:\Users\Public\inflow-windows-security-smoke.log'
)

$ErrorActionPreference = 'Stop'
$serviceName = 'InFlowVault'
$scratch = Join-Path $env:TEMP "inflow-windows-smoke-$PID"
$nativeBackup = Join-Path $scratch 'vault_peer_windows.node'
$copyRoot = Join-Path $scratch 'copy'
$results = [System.Collections.Generic.List[string]]::new()

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class InFlowMitigationProbe {
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetProcessMitigationPolicy(
    IntPtr process,
    int policy,
    IntPtr buffer,
    UIntPtr length
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool PeekNamedPipe(
    IntPtr pipe,
    IntPtr buffer,
    uint bufferSize,
    IntPtr bytesRead,
    out uint bytesAvailable,
    IntPtr bytesLeft
  );

  public static uint QueryFlags(int processId, int policy) {
    IntPtr process = OpenProcess(0x0400, false, processId);
    if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    int size = policy == 0 ? 8 : 4;
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      for (int index = 0; index < size; index++) Marshal.WriteByte(buffer, index, 0);
      if (!GetProcessMitigationPolicy(process, policy, buffer, (UIntPtr)size)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      return unchecked((uint)Marshal.ReadInt32(buffer));
    } finally {
      Marshal.FreeHGlobal(buffer);
      CloseHandle(process);
    }
  }

  public static int QueryPipeState(IntPtr pipe) {
    uint bytesAvailable;
    if (PeekNamedPipe(pipe, IntPtr.Zero, 0, IntPtr.Zero, out bytesAvailable, IntPtr.Zero)) {
      return bytesAvailable == 0 ? 0 : 1;
    }
    int error = Marshal.GetLastWin32Error();
    if (error == 109 || error == 232) return 2;
    throw new Win32Exception(error);
  }
}
'@

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) {
    throw $Message
  }
}

function Add-Result([string]$Message) {
  $results.Add("PASS: $Message")
}

function Invoke-InFlow([string]$Path, [string[]]$Arguments) {
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Path
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Arguments = $Arguments -join ' '
  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  return @{
    ExitCode = $process.ExitCode
    Stderr = $stderr
    Stdout = $stdout
  }
}

function Start-VaultService {
  Start-Service -Name $serviceName
  (Get-Service -Name $serviceName).WaitForStatus(
    [System.ServiceProcess.ServiceControllerStatus]::Running,
    [TimeSpan]::FromSeconds(25)
  )
}

function Stop-VaultService {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($null -ne $service -and $service.Status -ne 'Stopped') {
    Stop-Service -Name $serviceName
    $service.WaitForStatus(
      [System.ServiceProcess.ServiceControllerStatus]::Stopped,
      [TimeSpan]::FromSeconds(25)
    )
  }
}

function Assert-ProcessMitigations {
  $processes = @(Get-Process -Name inflow -ErrorAction Stop)
  Assert-True ($processes.Count -eq 1) 'The Windows vault service does not have exactly one process.'
  foreach ($process in $processes) {
    $dep = [InFlowMitigationProbe]::QueryFlags($process.Id, 0)
    $extensionPoint = [InFlowMitigationProbe]::QueryFlags($process.Id, 6)
    $imageLoad = [InFlowMitigationProbe]::QueryFlags($process.Id, 10)
    Assert-True (($dep -band 1) -ne 0) "Data Execution Prevention is not enabled for PID $($process.Id)."
    Assert-True (($extensionPoint -band 1) -ne 0) "Extension points are not disabled for PID $($process.Id)."
    Assert-True (($imageLoad -band 1) -ne 0) "Remote image loading is not blocked for PID $($process.Id)."
    Assert-True (($imageLoad -band 2) -ne 0) "Low-integrity image loading is not blocked for PID $($process.Id)."
    Assert-True (($imageLoad -band 4) -ne 0) "System32 image preference is not enabled for PID $($process.Id)."
  }
  Add-Result 'service process mitigations'
}

function Assert-ServiceIdentity {
  $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
  Assert-True ($service.StartName -eq 'NT SERVICE\InFlowVault') 'The service account is not NT SERVICE\InFlowVault.'
  $sidType = (& sc.exe qsidtype $serviceName | Out-String)
  Assert-True ($sidType -match 'SERVICE_SID_TYPE:\s+UNRESTRICTED') 'The service security identifier is not unrestricted.'
  Add-Result 'dedicated virtual service account and service security identifier'
}

function Assert-Signatures {
  $signature = Get-AuthenticodeSignature -LiteralPath $Executable
  Assert-True ($signature.Status -eq 'Valid') "Authenticode signature is invalid for $Executable."
  Add-Result 'installed executable Authenticode signature'
}

function Assert-ClientRejectsWrongDaemonIdentity {
  New-Item -ItemType Directory -Path $copyRoot -Force | Out-Null
  Copy-Item -LiteralPath (Split-Path $Executable -Parent) -Destination $copyRoot -Recurse
  $copiedExecutable = Join-Path $copyRoot 'InFlow\inflow.exe'
  $result = Invoke-InFlow $copiedExecutable @('vault', 'status', '--format', 'json')
  Assert-True ($result.ExitCode -ne 0) 'A copied client accepted the installed daemon identity.'
  Add-Result 'client rejects a daemon at a different executable identity'
}

function Assert-DaemonRejectsForeignClient {
  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
    '.',
    'InFlowVault',
    [System.IO.Pipes.PipeDirection]::InOut,
    [System.IO.Pipes.PipeOptions]::None,
    [System.Security.Principal.TokenImpersonationLevel]::Identification
  )
  try {
    $pipe.Connect(5000)
    $handshake = [System.Text.Encoding]::ASCII.GetBytes('INFLOWV1')
    $pipe.Write($handshake, 0, $handshake.Length)
    $pipe.Flush()
    $state = 0
    for ($attempt = 0; $attempt -lt 50 -and $state -eq 0; $attempt += 1) {
      Start-Sleep -Milliseconds 100
      $state = [InFlowMitigationProbe]::QueryPipeState(
        $pipe.SafePipeHandle.DangerousGetHandle()
      )
    }
    Assert-True ($state -eq 2) 'The daemon did not close a foreign named-pipe client.'
  } finally {
    $pipe.Dispose()
  }
  Add-Result 'daemon rejects a foreign named-pipe client before vault protocol data'
}

function Assert-NativeTamperFailsClosed {
  Stop-VaultService
  Copy-Item -LiteralPath $NativeModule -Destination $nativeBackup
  try {
    $stream = [System.IO.File]::Open($NativeModule, 'Open', 'ReadWrite', 'None')
    try {
      $stream.Seek(-1, [System.IO.SeekOrigin]::End) | Out-Null
      $value = $stream.ReadByte()
      $stream.Seek(-1, [System.IO.SeekOrigin]::Current) | Out-Null
      $stream.WriteByte($value -bxor 1)
    } finally {
      $stream.Dispose()
    }
    try {
      Start-VaultService
      throw 'The service started with a tampered native module.'
    } catch {
      $state = (Get-Service -Name $serviceName).Status
      Assert-True ($state -ne 'Running') 'The service remained running with a tampered native module.'
    }
  } finally {
    Stop-VaultService
    Copy-Item -LiteralPath $nativeBackup -Destination $NativeModule -Force
  }
  Add-Result 'native-module tampering fails closed'
}

try {
  New-Item -ItemType Directory -Path $scratch -Force | Out-Null
  Assert-Signatures
  Assert-ServiceIdentity
  Start-VaultService
  $status = Invoke-InFlow $Executable @('vault', 'status', '--format', 'json')
  Assert-True ($status.ExitCode -eq 0) "Authenticated vault status failed: $($status.Stderr)"
  Add-Result 'authenticated vault status'
  Assert-ProcessMitigations
  Assert-ClientRejectsWrongDaemonIdentity
  Assert-DaemonRejectsForeignClient
  Assert-NativeTamperFailsClosed
  Start-VaultService
  $restoredStatus = Invoke-InFlow $Executable @('vault', 'status', '--format', 'json')
  Assert-True ($restoredStatus.ExitCode -eq 0) 'Vault status failed after restoring the native module.'
  Add-Result 'restored installation remains operational'
  $results.Add('Windows system vault security smoke passed.')
} catch {
  $results.Add("FAIL: $($_.Exception.Message)")
  throw
} finally {
  Stop-VaultService
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
  $results | Set-Content -LiteralPath $Report -Encoding ascii
}
