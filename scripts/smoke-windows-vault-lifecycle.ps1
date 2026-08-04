param(
  [string]$Executable = 'C:\Program Files\InFlow\inflow.exe',
  [string]$VaultRoot = 'C:\ProgramData\InFlow\vaults',
  [string]$Report = 'C:\Users\Public\inflow-windows-vault-lifecycle.log',
  [switch]$SkipRelock,
  [switch]$ProbeMemoryScanner
)

$ErrorActionPreference = 'Stop'
$results = [System.Collections.Generic.List[string]]::new()
$apiKey = "inflow_windows_smoke_$([Guid]::NewGuid().ToString('N'))"
$server = $null

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class InFlowProcessMemoryScanner {
  [StructLayout(LayoutKind.Sequential)]
  private struct MemoryBasicInformation {
    public IntPtr BaseAddress;
    public IntPtr AllocationBase;
    public uint AllocationProtect;
    public UIntPtr RegionSize;
    public uint State;
    public uint Protect;
    public uint Type;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern UIntPtr VirtualQueryEx(
    IntPtr process,
    IntPtr address,
    out MemoryBasicInformation information,
    UIntPtr length
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool ReadProcessMemory(
    IntPtr process,
    IntPtr address,
    byte[] buffer,
    UIntPtr size,
    out UIntPtr bytesRead
  );

  public static string FindAny(int processId, byte[][] patterns) {
    const uint processQueryLimitedInformation = 0x1000;
    const uint processVirtualMemoryRead = 0x0010;
    const uint memoryCommit = 0x1000;
    const uint pageGuard = 0x100;
    const uint pageNoAccess = 0x01;
    IntPtr process = OpenProcess(
      processQueryLimitedInformation | processVirtualMemoryRead,
      false,
      processId
    );
    if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    int longest = 1;
    foreach (byte[] pattern in patterns) {
      if (pattern != null && pattern.Length > longest) longest = pattern.Length;
    }
    byte[] buffer = new byte[1024 * 1024 + longest - 1];
    byte[] readBuffer = new byte[1024 * 1024];
    try {
      ulong address = 0;
      int informationSize = Marshal.SizeOf(typeof(MemoryBasicInformation));
      while (address < 0x00007fffffffffffUL) {
        MemoryBasicInformation information;
        UIntPtr queried = VirtualQueryEx(
          process,
          new IntPtr(unchecked((long)address)),
          out information,
          (UIntPtr)informationSize
        );
        if (queried == UIntPtr.Zero) break;
        ulong baseAddress = unchecked((ulong)information.BaseAddress.ToInt64());
        ulong regionSize = information.RegionSize.ToUInt64();
        if (regionSize == 0 || baseAddress + regionSize <= address) break;
        if (
          information.State == memoryCommit &&
          (information.Protect & (pageGuard | pageNoAccess)) == 0
        ) {
          int overlap = 0;
          ulong offset = 0;
          while (offset < regionSize) {
            int requested = (int)Math.Min(1024UL * 1024UL, regionSize - offset);
            UIntPtr bytesRead;
            bool readable = ReadProcessMemory(
              process,
              new IntPtr(unchecked((long)(baseAddress + offset))),
              readBuffer,
              (UIntPtr)requested,
              out bytesRead
            );
            if (!readable || bytesRead == UIntPtr.Zero) break;
            int received = checked((int)bytesRead.ToUInt64());
            Buffer.BlockCopy(readBuffer, 0, buffer, overlap, received);
            Array.Clear(readBuffer, 0, received);
            int populated = overlap + received;
            foreach (byte[] pattern in patterns) {
              int found = IndexOf(buffer, populated, pattern);
              if (found >= 0) {
                return "0x" + (baseAddress + offset - (ulong)overlap + (ulong)found).ToString("x");
              }
            }
            overlap = Math.Min(longest - 1, populated);
            Buffer.BlockCopy(buffer, populated - overlap, buffer, 0, overlap);
            Array.Clear(buffer, overlap, populated - overlap);
            offset += bytesRead.ToUInt64();
          }
          Array.Clear(buffer, 0, buffer.Length);
        }
        address = baseAddress + regionSize;
      }
      return null;
    } finally {
      Array.Clear(buffer, 0, buffer.Length);
      Array.Clear(readBuffer, 0, readBuffer.Length);
      CloseHandle(process);
    }
  }

  private static int IndexOf(byte[] buffer, int length, byte[] pattern) {
    if (pattern == null || pattern.Length == 0 || length < pattern.Length) return -1;
    for (int offset = 0; offset <= length - pattern.Length; offset++) {
      int index = 0;
      while (index < pattern.Length && buffer[offset + index] == pattern[index]) index++;
      if (index == pattern.Length) return offset;
    }
    return -1;
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

function Invoke-InFlowJson([string[]]$Arguments) {
  $output = & $Executable @Arguments 2>&1
  Assert-True ($LASTEXITCODE -eq 0) "InFlow failed: $($output -join [Environment]::NewLine)"
  return ($output -join [Environment]::NewLine) | ConvertFrom-Json
}

function Assert-VaultState([string]$Expected) {
  $status = Invoke-InFlowJson @('vault', 'status', '--format', 'json')
  Assert-True ($status.lock_state -eq $Expected) "Expected vault state $Expected, received $($status.lock_state)."
}

function Find-ByteSequence([byte[]]$Contents, [byte[]]$Needle) {
  if ($Needle.Length -eq 0 -or $Contents.Length -lt $Needle.Length) {
    return $false
  }
  for ($offset = 0; $offset -le $Contents.Length - $Needle.Length; $offset += 1) {
    $matches = $true
    for ($index = 0; $index -lt $Needle.Length; $index += 1) {
      if ($Contents[$offset + $index] -ne $Needle[$index]) {
        $matches = $false
        break
      }
    }
    if ($matches) {
      return $true
    }
  }
  return $false
}

function Assert-SecretAbsentFromVaultFiles([string]$Value, [string]$Label) {
  $utf8 = [System.Text.Encoding]::UTF8.GetBytes($Value)
  $hexadecimal = [BitConverter]::ToString($utf8).Replace('-', '')
  $representations = [System.Collections.Generic.List[byte[]]]::new()
  $representations.Add($utf8)
  $representations.Add([System.Text.Encoding]::Unicode.GetBytes($Value))
  $representations.Add([System.Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String($utf8)))
  $representations.Add([System.Text.Encoding]::ASCII.GetBytes($hexadecimal.ToLowerInvariant()))
  $representations.Add([System.Text.Encoding]::ASCII.GetBytes($hexadecimal))
  try {
    foreach ($file in Get-ChildItem -LiteralPath $VaultRoot -File -Recurse -Force) {
      $contents = Read-LiveFile $file.FullName
      try {
        foreach ($representation in $representations) {
          Assert-True (-not (Find-ByteSequence $contents $representation)) "The $Label was found in $($file.FullName)."
        }
      } finally {
        [Array]::Clear($contents, 0, $contents.Length)
      }
    }
  } finally {
    foreach ($representation in $representations) {
      [Array]::Clear($representation, 0, $representation.Length)
    }
  }
}

function Assert-SecretAbsentFromServiceMemory([string]$Value, [string]$Label) {
  $utf8 = [System.Text.Encoding]::UTF8.GetBytes($Value)
  $hexadecimal = [BitConverter]::ToString($utf8).Replace('-', '')
  $representations = [System.Collections.Generic.List[byte[]]]::new()
  $representations.Add($utf8)
  $representations.Add([System.Text.Encoding]::Unicode.GetBytes($Value))
  $representations.Add([System.Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String($utf8)))
  $representations.Add([System.Text.Encoding]::ASCII.GetBytes($hexadecimal.ToLowerInvariant()))
  $representations.Add([System.Text.Encoding]::ASCII.GetBytes($hexadecimal))
  try {
    $service = Get-CimInstance Win32_Service -Filter "Name='InFlowVault'"
    Assert-True ($service.ProcessId -gt 0) 'The Windows vault service process is unavailable.'
    $found = [InFlowProcessMemoryScanner]::FindAny(
      [int]$service.ProcessId,
      $representations.ToArray()
    )
    Assert-True ($null -eq $found) "The $Label remained in vault service memory at $found."
  } finally {
    foreach ($representation in $representations) {
      [Array]::Clear($representation, 0, $representation.Length)
    }
  }
}

function Read-LiveFile([string]$Path) {
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

function Start-ApiServer {
  $listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    0
  )
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  $job = Start-Job -ArgumentList $port, $apiKey -ScriptBlock {
    param($Port, $ApiKey)
    $http = [System.Net.HttpListener]::new()
    $http.Prefixes.Add("http://127.0.0.1:$Port/")
    $http.Start()
    Write-Output 'ready'
    try {
      for ($requestNumber = 0; $requestNumber -lt 4; $requestNumber += 1) {
        $context = $http.GetContext()
        $authorized = (
          $context.Request.Url.AbsolutePath -eq '/v1/users/self' -and
          $context.Request.Headers['x-api-key'] -ceq $ApiKey
        )
        if ($authorized) {
          $body = [System.Text.Encoding]::UTF8.GetBytes(
            '{"id":"windows-vault-user","email":"windows-vault@inflow.test"}'
          )
          $context.Response.StatusCode = 200
          $context.Response.ContentType = 'application/json'
        } else {
          $body = [System.Text.Encoding]::UTF8.GetBytes('{"code":"unauthorized"}')
          $context.Response.StatusCode = 401
          $context.Response.ContentType = 'application/json'
        }
        $context.Response.OutputStream.Write($body, 0, $body.Length)
        $context.Response.Close()
      }
    } finally {
      $http.Close()
    }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $jobOutput = @(Receive-Job -Job $job)
    if ($jobOutput -contains 'ready') {
      break
    }
    if ($job.State -eq 'Failed') {
      $failure = Receive-Job -Job $job -Keep 2>&1
      throw "The local API server failed: $($failure -join [Environment]::NewLine)"
    }
    Start-Sleep -Milliseconds 50
  } while ([DateTime]::UtcNow -lt $deadline)
  Assert-True ($jobOutput -contains 'ready') 'The local API server did not become ready.'
  return @{
    Endpoint = "http://127.0.0.1:$port"
    Job = $job
  }
}

try {
  if ($ProbeMemoryScanner) {
    $probe = [System.Text.Encoding]::UTF8.GetBytes("inflow-memory-probe-$([Guid]::NewGuid().ToString('N'))")
    try {
      $service = Get-CimInstance Win32_Service -Filter "Name='InFlowVault'"
      Assert-True ($service.ProcessId -gt 0) 'The Windows vault service process is unavailable.'
      $probePatterns = [System.Collections.Generic.List[byte[]]]::new()
      $probePatterns.Add($probe)
      $found = [InFlowProcessMemoryScanner]::FindAny([int]$service.ProcessId, $probePatterns.ToArray())
      Assert-True ($null -eq $found) "The scanner-only probe unexpectedly matched service memory at $found."
      $results.Add('Windows process-memory scanner compatibility passed.')
      return
    } finally {
      [Array]::Clear($probe, 0, $probe.Length)
    }
  }

  $initial = Invoke-InFlowJson @('vault', 'status', '--format', 'json')
  if ($initial.lock_state -eq 'not_initialized') {
    $firstAuthStatus = Invoke-InFlowJson @('auth', 'status', '--format', 'json')
    Assert-True (-not $firstAuthStatus.authenticated) 'First-run auth status did not report an unauthenticated session.'
    Add-Result 'first-run auth status activated the vault service without requiring unlock'
    Write-Host 'Choose a temporary vault passphrase, then enter the same value at each InFlow prompt.'
    & $Executable vault unlock
    Assert-True ($LASTEXITCODE -eq 0) 'Vault initialization failed.'
    Add-Result 'first-run vault initialization and unlock'
  } elseif ($initial.lock_state -eq 'locked') {
    Write-Host 'Enter the temporary vault passphrase chosen during the prior run.'
    & $Executable vault unlock
    Assert-True ($LASTEXITCODE -eq 0) 'Vault unlock failed.'
    Add-Result 'existing vault unlock'
  } else {
    Assert-True ($initial.lock_state -eq 'unlocked') "Unexpected initial vault state $($initial.lock_state)."
    Add-Result 'existing vault remained unlocked after the interrupted run'
  }
  Assert-VaultState 'unlocked'

  $server = Start-ApiServer
  $login = Invoke-InFlowJson @(
    '--api-key', $apiKey,
    '--base-url', $server.Endpoint,
    'auth', 'login',
    '--format', 'json'
  )
  Assert-True ($login.authenticated -eq $true) 'API-key login was not authenticated.'
  Assert-True ($login.method -eq 'api_key') 'API-key login reported the wrong authentication method.'
  Add-Result 'credential storage through the packaged command path'

  $authStatus = Invoke-InFlowJson @('auth', 'status', '--format', 'json')
  Assert-True ($authStatus.authenticated -eq $true) 'Stored credential validation failed.'
  Assert-True ($authStatus.auth_method -eq 'api_key') 'Stored credential reported the wrong authentication method.'
  Add-Result 'stored credential retrieval'

  Assert-SecretAbsentFromVaultFiles $apiKey 'stored credential'
  Add-Result 'stored credential absent from persistent vault files in raw, UTF-16, Base64, and hexadecimal forms'
  Assert-SecretAbsentFromServiceMemory $apiKey 'stored credential'
  Add-Result 'stored credential absent from readable committed vault-service memory'
  $pageFiles = @(Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue)
  $activePageFiles = @(
    $pageFiles | Where-Object {
      $null -ne $_ -and $null -ne $_.AllocatedBaseSize -and [uint32]$_.AllocatedBaseSize -gt 0
    }
  )
  if ($activePageFiles.Count -eq 0) {
    Add-Result 'pagefile disabled during process-memory scan'
  } else {
    $results.Add('LIMITATION: the Windows pagefile was enabled and was not scanned.')
  }
  if ($SkipRelock) {
    $results.Add('Windows packaged vault credential-storage and disk-scan smoke passed.')
    return
  }

  $lock = Invoke-InFlowJson @('vault', 'lock', '--format', 'json')
  Assert-True ($lock.locked -eq $true) 'Vault lock did not report success.'
  Assert-VaultState 'locked'
  Add-Result 'explicit vault lock'

  Write-Host 'Enter the same temporary vault passphrase once more.'
  & $Executable vault unlock
  Assert-True ($LASTEXITCODE -eq 0) 'Vault re-unlock failed.'
  Assert-VaultState 'unlocked'
  $persistedStatus = Invoke-InFlowJson @('auth', 'status', '--format', 'json')
  Assert-True ($persistedStatus.authenticated -eq $true) 'Credential did not survive lock and unlock.'
  Add-Result 'credential persistence across lock and unlock'

  $results.Add('Windows packaged vault lifecycle smoke passed.')
} catch {
  $results.Add("FAIL: $($_.Exception.Message)")
  throw
} finally {
  if ($null -ne $server) {
    Stop-Job -Job $server.Job -ErrorAction SilentlyContinue
    Remove-Job -Job $server.Job -Force -ErrorAction SilentlyContinue
  }
  $apiKey = $null
  $results | Set-Content -LiteralPath $Report -Encoding ascii
}
