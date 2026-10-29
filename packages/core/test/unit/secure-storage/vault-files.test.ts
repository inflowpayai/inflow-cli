import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultVaultRoot,
  linuxVaultServiceUserId,
  removeVaultLocalState,
  usesLinuxVaultService,
  usesWindowsVaultService,
  usesDevelopmentVault,
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
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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

  it('preserves the Linux data directory for development builds', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.stubGlobal('__INFLOW_DEVELOPMENT_VAULT__', true);
    process.env['XDG_DATA_HOME'] = tmpDir;
    expect(usesDevelopmentVault()).toBe(true);
    expect(defaultVaultRoot()).toBe(join(tmpDir, 'inflow'));
    expect(vaultFilePaths().socket).toBe(join(tmpDir, 'inflow', 'run', 'vault.sock'));
  });

  it.each([undefined, false, 'true'])('fails closed for development marker %s', (marker) => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.stubGlobal('__INFLOW_DEVELOPMENT_VAULT__', marker);
    vi.stubEnv('__INFLOW_DEVELOPMENT_VAULT__', 'true');
    expect(usesDevelopmentVault()).toBe(false);
  });

  it('does not change macOS paths for a development build', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const expected = defaultVaultRoot();
    vi.stubGlobal('__INFLOW_DEVELOPMENT_VAULT__', true);
    expect(usesDevelopmentVault()).toBe(true);
    expect(defaultVaultRoot()).toBe(expected);
  });

  it('preserves the Windows data directory while using a per-user development pipe', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(usesWindowsVaultService()).toBe(true);
    expect(vaultFilePaths().socket).toBe('\\\\.\\pipe\\InFlowVault');
    const root = defaultVaultRoot();
    vi.stubGlobal('__INFLOW_DEVELOPMENT_VAULT__', true);
    expect(usesWindowsVaultService()).toBe(false);
    expect(defaultVaultRoot()).toBe(root);
    expect(defaultVaultRoot()).toMatch(/\.inflow$/);
    const socket = vaultFilePaths(tmpDir).socket;
    expect(socket).toMatch(/^\\\\\.\\pipe\\InFlowDevelopment-[a-f0-9]{64}$/);
    expect(vaultFilePaths(tmpDir).socket).toBe(socket);
    expect(vaultFilePaths(join(tmpDir, 'another')).socket).not.toBe(socket);
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

  it.each([0o720, 0o702])('rejects a real socket in a writable parent directory (%s)', async (mode) => {
    const parent = join(tmpDir, 'unsafe');
    mkdirSync(parent, { mode: 0o700 });
    const socketPath = join(parent, 'vault.sock');
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
    chmodSync(parent, mode);
    expect(captureError(() => linuxVaultServiceUserId(socketPath))).toMatchObject({
      secureStorageCode: 'secure_storage_peer_verification_failed',
    });
    chmodSync(parent, 0o700);
    expect(linuxVaultServiceUserId(socketPath)).toBe(lstatSync(socketPath).uid);
  });

  it('rejects both socket and parent-directory symlinks', async () => {
    const parent = join(tmpDir, 'real');
    mkdirSync(parent, { mode: 0o700 });
    const socketPath = join(parent, 'vault.sock');
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
    const socketLink = join(parent, 'link.sock');
    const parentLink = join(tmpDir, 'linked');
    symlinkSync(socketPath, socketLink);
    symlinkSync(parent, parentLink);
    for (const candidate of [socketLink, join(parentLink, 'vault.sock')]) {
      expect(captureError(() => linuxVaultServiceUserId(candidate))).toMatchObject({
        secureStorageCode: 'secure_storage_peer_verification_failed',
      });
    }
    expect(linuxVaultServiceUserId(socketPath)).toBe(lstatSync(socketPath).uid);
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
