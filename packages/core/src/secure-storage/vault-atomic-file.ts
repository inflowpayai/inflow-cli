import { randomBytes } from 'node:crypto';
import { link, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const SIDECAR_FILE_MODE = 0o600;

interface WritableFile {
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
  sync(): Promise<void>;
  writeFile(data: Uint8Array): Promise<void>;
}

export interface VaultHeaderWriteDependencies {
  link(existingPath: string, newPath: string): Promise<void>;
  open(filePath: string, flags: string, mode?: number): Promise<WritableFile>;
  platform: NodeJS.Platform;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(filePath: string, options: { force: boolean }): Promise<void>;
  temporaryPath(sidecarPath: string): string;
}

interface WriteVaultHeaderOptions {
  onPublished: () => void;
  replace: boolean;
}

const dependencies: VaultHeaderWriteDependencies = {
  link,
  open,
  platform: process.platform,
  rename,
  rm,
  temporaryPath: (sidecarPath) => `${sidecarPath}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`,
};

export async function writeVaultHeader(
  sidecarPath: string,
  header: Uint8Array,
  options: WriteVaultHeaderOptions,
  fileDependencies: VaultHeaderWriteDependencies = dependencies,
): Promise<void> {
  const temporaryPath = fileDependencies.temporaryPath(sidecarPath);
  let temporaryFile: WritableFile | undefined;
  try {
    temporaryFile = await fileDependencies.open(temporaryPath, 'wx', SIDECAR_FILE_MODE);
    await temporaryFile.writeFile(header);
    await temporaryFile.chmod(SIDECAR_FILE_MODE);
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    if (options.replace) {
      await fileDependencies.rename(temporaryPath, sidecarPath);
    } else {
      await fileDependencies.link(temporaryPath, sidecarPath);
    }
    let publicationError: unknown;
    try {
      options.onPublished();
    } catch (cause) {
      publicationError = cause;
    }
    let cleanupError: unknown;
    try {
      await fileDependencies.rm(temporaryPath, { force: true });
    } catch (cause) {
      cleanupError = cause;
    }
    let synchronizationError: unknown;
    try {
      await syncDirectory(path.dirname(sidecarPath), fileDependencies);
    } catch (cause) {
      synchronizationError = cause;
    }
    if (publicationError !== undefined) throw errorFrom(publicationError);
    if (cleanupError !== undefined) throw errorFrom(cleanupError);
    if (synchronizationError !== undefined) throw errorFrom(synchronizationError);
  } finally {
    await Promise.allSettled([
      temporaryFile?.close() ?? Promise.resolve(),
      fileDependencies.rm(temporaryPath, { force: true }),
    ]);
  }
}

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error('Vault header publication failed.', { cause });
}

async function syncDirectory(directoryPath: string, fileDependencies: VaultHeaderWriteDependencies): Promise<void> {
  if (fileDependencies.platform === 'win32') return;
  const directory = await fileDependencies.open(directoryPath, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
