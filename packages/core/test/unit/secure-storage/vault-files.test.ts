import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultVaultRoot, removeVaultLocalState, vaultFilePaths } from '../../../src/secure-storage/vault-files.js';

describe('vault file cleanup', () => {
  let tmpDir: string;
  const originalPlatform = process.platform;
  const originalXdgDataHome = process.env['XDG_DATA_HOME'];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-files-'));
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
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
