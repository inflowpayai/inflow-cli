import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SecureStorageError } from '../../../src/secure-storage/errors.js';
import { vaultFilePaths } from '../../../src/secure-storage/vault-files.js';
import {
  __testing,
  type LocalVaultPeerRecoveryDependencies,
  shutdownUnverifiedLocalVaultDaemon,
} from '../../../src/secure-storage/vault-peer-recovery.js';

function dependencies(overrides: Partial<LocalVaultPeerRecoveryDependencies> = {}): LocalVaultPeerRecoveryDependencies {
  return {
    currentProcessId: 999,
    inspectPeer: vi.fn(() => Promise.resolve({ path: '/old/inflow', pid: 123, uid: 501 })),
    isVaultDaemonProcess: vi.fn(() => true),
    now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(2),
    platform: 'darwin',
    processRunning: vi.fn(() => false),
    signal: vi.fn(),
    sleep: vi.fn(() => Promise.resolve()),
    socketReachable: vi.fn(() => Promise.resolve(false)),
    usesLinuxService: false,
    ...overrides,
  };
}

describe('vault peer recovery', () => {
  it.runIf(process.platform === 'darwin' || process.platform === 'linux')(
    'shuts down a same-user local daemon through the public recovery boundary',
    async () => {
      const rootDirectory = mkdtempSync(join(tmpdir(), 'inflow-vault-recovery-'));
      const socketPath = vaultFilePaths(rootDirectory).socket;
      const child = spawn(
        process.execPath,
        [
          '-e',
          [
            "const { mkdirSync } = require('node:fs');",
            "const { dirname } = require('node:path');",
            "const { createServer } = require('node:net');",
            'const socketPath = process.argv[1];',
            'mkdirSync(dirname(socketPath), { recursive: true });',
            'const server = createServer(() => {});',
            "server.listen(socketPath, () => process.send('ready'));",
            "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
          ].join(''),
          socketPath,
          '--daemon',
          'vault',
        ],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
      );
      try {
        await once(child, 'message');
        await expect(shutdownUnverifiedLocalVaultDaemon(rootDirectory)).resolves.toBeUndefined();
        expect(child.exitCode).toBe(0);
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        rmSync(rootDirectory, { force: true, recursive: true });
      }
    },
  );

  it('signals a same-user local daemon and waits for its socket to close', async () => {
    const harness = dependencies();

    await expect(
      __testing.shutdownUnverifiedLocalVaultDaemonWithDependencies('/vault.sock', harness),
    ).resolves.toBeUndefined();

    expect(harness.inspectPeer).toHaveBeenCalledWith('/vault.sock');
    expect(harness.signal).toHaveBeenCalledWith(123, 'SIGTERM');
    expect(harness.processRunning).toHaveBeenCalledWith(123);
    expect(harness.socketReachable).toHaveBeenCalledWith('/vault.sock');
  });

  it.each([
    ['win32', false],
    ['linux', true],
  ] as const)('refuses recovery on %s when service management is %s', async (platform, usesLinuxService) => {
    const harness = dependencies({ platform, usesLinuxService });

    await expect(
      __testing.shutdownUnverifiedLocalVaultDaemonWithDependencies('/vault.sock', harness),
    ).rejects.toMatchObject({
      message: 'Vault peer verification failed.',
      secureStorageCode: 'secure_storage_peer_verification_failed',
    });

    expect(harness.inspectPeer).not.toHaveBeenCalled();
    expect(harness.signal).not.toHaveBeenCalled();
  });

  it('refuses to signal the current process', async () => {
    const harness = dependencies({
      inspectPeer: vi.fn(() => Promise.resolve({ path: '/old/inflow', pid: 999, uid: 501 })),
    });

    await expect(
      __testing.shutdownUnverifiedLocalVaultDaemonWithDependencies('/vault.sock', harness),
    ).rejects.toBeInstanceOf(SecureStorageError);
    expect(harness.signal).not.toHaveBeenCalled();
  });

  it('refuses to signal a same-user process that is not a vault daemon', async () => {
    const harness = dependencies({ isVaultDaemonProcess: vi.fn(() => false) });

    await expect(
      __testing.shutdownUnverifiedLocalVaultDaemonWithDependencies('/vault.sock', harness),
    ).rejects.toMatchObject({ message: 'Vault peer verification failed.' });
    expect(harness.signal).not.toHaveBeenCalled();
  });

  it('recognizes only the vault daemon argument forms', () => {
    expect(__testing.hasVaultDaemonArguments(['/opt/inflow', '--daemon', 'vault'])).toBe(true);
    expect(__testing.hasVaultDaemonArguments(['/opt/inflow', '--daemon=vault'])).toBe(true);
    expect(__testing.hasVaultDaemonArguments(['/opt/inflow', '--daemon', 'vault-service'])).toBe(false);
    expect(__testing.hasVaultDaemonArguments(['/opt/inflow', 'vault'])).toBe(false);
  });

  it('reads macOS-style process arguments and detects running processes', () => {
    const execute = vi.fn(() => '/usr/local/bin/node /workspace/cli.js --daemon vault\n');
    expect(__testing.readDarwinArguments(123, execute)).toEqual([
      '/usr/local/bin/node',
      '/workspace/cli.js',
      '--daemon',
      'vault',
    ]);
    expect(execute).toHaveBeenCalledWith('/bin/ps', ['-p', '123', '-o', 'command='], { encoding: 'utf8' });

    expect(
      __testing.processRunning(
        123,
        vi.fn(() => true),
      ),
    ).toBe(true);
    expect(
      __testing.processRunning(
        123,
        vi.fn(() => {
          throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        }),
      ),
    ).toBe(false);
    expect(() =>
      __testing.processRunning(
        123,
        vi.fn(() => {
          throw Object.assign(new Error('denied'), { code: 'EPERM' });
        }),
      ),
    ).toThrow('denied');
  });

  it('recognizes packaged, Linux development, and macOS development vault daemons', () => {
    const peer = { path: '/usr/local/bin/node', pid: 123, uid: 501 };
    const readers = {
      readDarwinArguments: vi.fn(() => ['/usr/local/bin/node', '/workspace/cli.js', '--daemon', 'vault']),
      readLinuxArguments: vi.fn(() => ['/usr/local/bin/node', '/workspace/cli.js', '--daemon', 'vault']),
    };

    expect(
      __testing.isVaultDaemonProcess(
        { ...peer, path: '/Applications/InFlow.app/Contents/MacOS/inflow' },
        {
          platform: 'darwin',
          ...readers,
        },
      ),
    ).toBe(true);
    expect(__testing.isVaultDaemonProcess(peer, { platform: 'linux', ...readers })).toBe(true);
    expect(__testing.isVaultDaemonProcess(peer, { platform: 'darwin', ...readers })).toBe(true);
    expect(readers.readLinuxArguments).toHaveBeenCalledWith(123);
    expect(readers.readDarwinArguments).toHaveBeenCalledWith(123);
  });

  it('refuses unrecognized platforms and failed process inspection', () => {
    const peer = { path: '/usr/local/bin/node', pid: 123, uid: 501 };
    const readFailure = vi.fn((): string[] => {
      throw new Error('unavailable');
    });

    expect(
      __testing.isVaultDaemonProcess(peer, {
        platform: 'win32',
        readDarwinArguments: vi.fn(() => []),
        readLinuxArguments: vi.fn(() => []),
      }),
    ).toBe(false);
    expect(
      __testing.isVaultDaemonProcess(peer, {
        platform: 'linux',
        readDarwinArguments: vi.fn(() => []),
        readLinuxArguments: readFailure,
      }),
    ).toBe(false);
  });

  it('preserves the peer-verification failure when inspection or signaling fails', async () => {
    const inspection = dependencies({ inspectPeer: vi.fn(() => Promise.reject(new Error('inspection failed'))) });
    await expect(
      __testing.shutdownUnverifiedLocalVaultDaemonWithDependencies('/vault.sock', inspection),
    ).rejects.toMatchObject({ message: 'Vault peer verification failed.' });

    const signaling = dependencies({
      signal: vi.fn(() => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      }),
    });
    await expect(
      __testing.shutdownUnverifiedLocalVaultDaemonWithDependencies('/vault.sock', signaling),
    ).rejects.toMatchObject({ message: 'Vault peer verification failed.' });
  });

  it('accepts an already-exited peer only after its socket becomes unreachable', async () => {
    const harness = dependencies({
      signal: vi.fn(() => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }),
    });

    await expect(
      __testing.shutdownUnverifiedLocalVaultDaemonWithDependencies('/vault.sock', harness),
    ).resolves.toBeUndefined();
  });

  it('refuses recovery when the socket remains reachable past the deadline', async () => {
    const harness = dependencies({
      now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(2_000),
      socketReachable: vi.fn(() => Promise.resolve(true)),
      processRunning: vi.fn(() => true),
    });

    await expect(
      __testing.shutdownUnverifiedLocalVaultDaemonWithDependencies('/vault.sock', harness),
    ).rejects.toMatchObject({ message: 'Vault peer verification failed.' });
    expect(harness.sleep).toHaveBeenCalledWith(25);
  });
});
