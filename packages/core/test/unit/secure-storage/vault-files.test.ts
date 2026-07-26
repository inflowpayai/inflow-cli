import { lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultVaultRoot,
  linuxVaultServiceUserId,
  removeVaultLocalState,
  usesLinuxVaultService,
  vaultFilePaths,
} from '../../../src/secure-storage/vault-files.js';

describe('vault file cleanup', () => {
  let tmpDir: string;
  const originalPlatform = process.platform;
  const originalExecPath = process.execPath;
  const originalXdgDataHome = process.env['XDG_DATA_HOME'];
  let server: Server | undefined;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'inflow-vault-files-')));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    server = undefined;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'execPath', { value: originalExecPath });
    if (originalXdgDataHome === undefined) {
      delete process.env['XDG_DATA_HOME'];
    } else {
      process.env['XDG_DATA_HOME'] = originalXdgDataHome;
    }
    await rm(tmpDir, { force: true, recursive: true });
  });

  it('uses the Linux data directory for vault state', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env['XDG_DATA_HOME'] = tmpDir;

    expect(defaultVaultRoot()).toBe(join(tmpDir, 'inflow'));
  });

  it('uses the platform fallback data directory outside macOS and Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    expect(defaultVaultRoot()).toMatch(/\.inflow$/);
    expect(usesLinuxVaultService()).toBe(false);
  });

  it('computes the database, sidecar, write-ahead log, shared-memory, and socket paths under one root', () => {
    const paths = vaultFilePaths(tmpDir);

    expect(paths).toEqual({
      database: join(tmpDir, 'inflow.sqlite3'),
      runDirectory: join(tmpDir, 'run'),
      sharedMemory: join(tmpDir, 'inflow.sqlite3-shm'),
      sidecar: join(tmpDir, 'inflow.vault'),
      socket: join(tmpDir, 'run', 'vault.sock'),
      writeAheadLog: join(tmpDir, 'inflow.sqlite3-wal'),
    });
  });

  it('uses the systemd socket for the installed Linux executable', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'execPath', { value: '/opt/inflow/bin/inflow' });

    expect(usesLinuxVaultService()).toBe(true);
    expect(vaultFilePaths().socket).toBe('/run/inflow/vault.sock');
  });

  it('reads a safely contained vault service socket owner', async () => {
    const socketPath = join(tmpDir, 'vault.sock');
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve));

    expect(linuxVaultServiceUserId(socketPath)).toBe(lstatSync(socketPath).uid);
  });

  it('distinguishes a missing service socket from an invalid socket identity', () => {
    const missing = join(tmpDir, 'missing.sock');
    const invalid = join(tmpDir, 'invalid.sock');
    writeFileSync(invalid, '');

    expect(captureError(() => linuxVaultServiceUserId(missing))).toMatchObject({
      secureStorageCode: 'secure_storage_unavailable',
    });
    expect(captureError(() => linuxVaultServiceUserId(invalid))).toMatchObject({
      secureStorageCode: 'secure_storage_peer_verification_failed',
    });
  });

  it('removes local vault state files while leaving unrelated files in place', async () => {
    const paths = vaultFilePaths(tmpDir);
    mkdirSync(paths.runDirectory);
    for (const filePath of [paths.database, paths.writeAheadLog, paths.sharedMemory, paths.sidecar, paths.socket]) {
      writeFileSync(filePath, 'x');
    }
    writeFileSync(join(tmpDir, 'unrelated'), 'keep');

    await removeVaultLocalState(paths);

    await expect(lstat(paths.database)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(paths.writeAheadLog)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(paths.sharedMemory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(paths.sidecar)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(paths.socket)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(tmpDir)).resolves.toEqual(['run', 'unrelated']);
  });

  it('is idempotent when local vault state files are absent', async () => {
    await expect(removeVaultLocalState(vaultFilePaths(tmpDir))).resolves.toBeUndefined();
  });
});

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  throw new Error('expected error');
}
