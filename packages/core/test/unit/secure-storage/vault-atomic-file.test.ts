import { constants } from 'node:fs';
import { access, link, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeVaultHeader, type VaultHeaderWriteDependencies } from '../../../src/secure-storage/vault-atomic-file.js';

describe('writeVaultHeader', () => {
  let temporaryDirectory: string;
  let sidecarPath: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'inflow-vault-header-'));
    sidecarPath = join(temporaryDirectory, 'inflow.vault');
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { force: true, recursive: true });
  });

  it('durably creates a private header without replacing an existing vault', async () => {
    const published = vi.fn();
    await writeVaultHeader(sidecarPath, Buffer.from('first'), { onPublished: published, replace: false });

    expect(await readFile(sidecarPath, 'utf8')).toBe('first');
    expect((await stat(sidecarPath)).mode & 0o777).toBe(0o600);
    expect(published).toHaveBeenCalledOnce();

    await expect(
      writeVaultHeader(sidecarPath, Buffer.from('second'), { onPublished: vi.fn(), replace: false }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(sidecarPath, 'utf8')).toBe('first');
  });

  it('atomically replaces an existing header', async () => {
    await writeFile(sidecarPath, 'first', { mode: 0o600 });
    const published = vi.fn();

    await writeVaultHeader(sidecarPath, Buffer.from('second'), { onPublished: published, replace: true });

    expect(await readFile(sidecarPath, 'utf8')).toBe('second');
    expect(published).toHaveBeenCalledOnce();
  });

  it('preserves the existing header when publication fails and removes the temporary file', async () => {
    await writeFile(sidecarPath, 'first', { mode: 0o600 });
    const temporaryPath = join(temporaryDirectory, 'inflow.vault.tmp');
    const published = vi.fn();
    const fileDependencies = failureDependencies(temporaryPath);

    await expect(
      writeVaultHeader(sidecarPath, Buffer.from('second'), { onPublished: published, replace: true }, fileDependencies),
    ).rejects.toThrow('publication failed');

    expect(await readFile(sidecarPath, 'utf8')).toBe('first');
    expect(published).not.toHaveBeenCalled();
    await expect(access(temporaryPath, constants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the existing header when synchronizing the temporary file fails', async () => {
    await writeFile(sidecarPath, 'first', { mode: 0o600 });
    const temporaryPath = join(temporaryDirectory, 'inflow.vault.tmp');
    const published = vi.fn();
    const fileDependencies = actualDependencies(temporaryPath, {
      open: async (filePath, flags, mode) => {
        const file = await open(filePath, flags, mode);
        return {
          chmod: file.chmod.bind(file),
          close: file.close.bind(file),
          sync: () => Promise.reject(new Error('synchronization failed')),
          writeFile: file.writeFile.bind(file),
        };
      },
    });

    await expect(
      writeVaultHeader(sidecarPath, Buffer.from('second'), { onPublished: published, replace: true }, fileDependencies),
    ).rejects.toThrow('synchronization failed');

    expect(await readFile(sidecarPath, 'utf8')).toBe('first');
    expect(published).not.toHaveBeenCalled();
    await expect(access(temporaryPath, constants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the published header when post-publication state alignment fails', async () => {
    const failure = new Error('state alignment failed');

    await expect(
      writeVaultHeader(sidecarPath, Buffer.from('first'), {
        onPublished: () => {
          throw failure;
        },
        replace: false,
      }),
    ).rejects.toBe(failure);

    expect(await readFile(sidecarPath, 'utf8')).toBe('first');
  });

  it('publishes on Windows without opening the directory as a file', async () => {
    const temporaryPath = join(temporaryDirectory, 'inflow.vault.tmp');
    const openedPaths: string[] = [];
    const fileDependencies = actualDependencies(temporaryPath, {
      open: async (filePath, flags, mode) => {
        openedPaths.push(filePath);
        return open(filePath, flags, mode);
      },
      platform: 'win32',
    });

    await writeVaultHeader(
      sidecarPath,
      Buffer.from('first'),
      { onPublished: vi.fn(), replace: false },
      fileDependencies,
    );

    expect(openedPaths).toEqual([temporaryPath]);
    expect(await readFile(sidecarPath, 'utf8')).toBe('first');
  });

  it('keeps the published header when temporary-file cleanup reports a failure', async () => {
    const temporaryPath = join(temporaryDirectory, 'inflow.vault.tmp');
    let removeCalls = 0;
    const fileDependencies = actualDependencies(temporaryPath, {
      rm: async (filePath, options) => {
        removeCalls += 1;
        if (removeCalls === 1) throw new Error('cleanup failed');
        await rm(filePath, options);
      },
    });

    await expect(
      writeVaultHeader(sidecarPath, Buffer.from('first'), { onPublished: vi.fn(), replace: false }, fileDependencies),
    ).rejects.toThrow('cleanup failed');

    expect(await readFile(sidecarPath, 'utf8')).toBe('first');
    await expect(access(temporaryPath, constants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the published header when directory synchronization fails', async () => {
    const temporaryPath = join(temporaryDirectory, 'inflow.vault.tmp');
    const published = vi.fn();
    const fileDependencies = actualDependencies(temporaryPath, {
      open: async (filePath, flags, mode) => {
        const file = await open(filePath, flags, mode);
        if (filePath !== temporaryDirectory) return file;
        return {
          chmod: file.chmod.bind(file),
          close: file.close.bind(file),
          sync: () => Promise.reject(new Error('directory synchronization failed')),
          writeFile: file.writeFile.bind(file),
        };
      },
    });

    await expect(
      writeVaultHeader(sidecarPath, Buffer.from('first'), { onPublished: published, replace: false }, fileDependencies),
    ).rejects.toThrow('directory synchronization failed');

    expect(published).toHaveBeenCalledOnce();
    expect(await readFile(sidecarPath, 'utf8')).toBe('first');
  });
});

function failureDependencies(temporaryPath: string): VaultHeaderWriteDependencies {
  return {
    link: () => Promise.reject(new Error('unexpected link')),
    open,
    platform: process.platform,
    rename: () => Promise.reject(new Error('publication failed')),
    rm,
    temporaryPath: () => temporaryPath,
  };
}

function actualDependencies(
  temporaryPath: string,
  overrides: Partial<VaultHeaderWriteDependencies>,
): VaultHeaderWriteDependencies {
  return {
    link,
    open,
    platform: process.platform,
    rename,
    rm,
    temporaryPath: () => temporaryPath,
    ...overrides,
  };
}
