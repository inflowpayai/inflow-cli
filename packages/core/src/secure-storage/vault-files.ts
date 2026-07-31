import { lstatSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { SecureStorageError } from './errors.js';

export interface VaultFilePaths {
  database: string;
  runDirectory: string;
  sharedMemory: string;
  sidecar: string;
  socket: string;
  writeAheadLog: string;
}

export function defaultVaultRoot(): string {
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'InFlow');
  if (process.platform === 'linux') {
    const dataHome = process.env['XDG_DATA_HOME'];
    return path.join(
      dataHome === undefined || dataHome.length === 0 ? path.join(homedir(), '.local', 'share') : dataHome,
      'inflow',
    );
  }
  return path.join(homedir(), '.inflow');
}

export function vaultFilePaths(rootDirectory?: string): VaultFilePaths {
  const root = rootDirectory ?? defaultVaultRoot();
  const database = path.join(root, 'inflow.sqlite3');
  const runDirectory = path.join(root, 'run');
  return {
    database,
    runDirectory,
    sharedMemory: `${database}-shm`,
    sidecar: path.join(root, 'inflow.vault'),
    socket:
      rootDirectory === undefined && usesLinuxVaultService()
        ? '/run/inflow/vault.sock'
        : rootDirectory === undefined && process.platform === 'win32'
          ? '\\\\.\\pipe\\InFlowVault'
          : path.join(runDirectory, 'vault.sock'),
    writeAheadLog: `${database}-wal`,
  };
}

export function usesLinuxVaultService(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return realpathSync(process.execPath) === '/opt/inflow/bin/inflow';
  } catch {
    return process.execPath === '/opt/inflow/bin/inflow';
  }
}

export function linuxVaultServiceUserId(socketPath: string): number {
  try {
    const parent = path.dirname(socketPath);
    const parentStat = lstatSync(parent);
    const socketStat = lstatSync(socketPath);
    if (
      realpathSync(parent) !== parent ||
      !parentStat.isDirectory() ||
      parentStat.uid !== socketStat.uid ||
      (parentStat.mode & 0o022) !== 0 ||
      !socketStat.isSocket() ||
      socketStat.isSymbolicLink()
    ) {
      throw new Error('unsafe vault service socket');
    }
    return socketStat.uid;
  } catch (cause) {
    if (isMissingPath(cause)) {
      throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault service is unavailable.', { cause });
    }
    throw new SecureStorageError(
      'secure_storage_peer_verification_failed',
      'The InFlow vault service socket identity is invalid.',
      { cause },
    );
  }
}

function isMissingPath(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && (cause.code === 'ENOENT' || cause.code === 'ENOTDIR');
}

export async function removeVaultLocalState(paths: VaultFilePaths): Promise<void> {
  await removePath(paths.database);
  await removePath(paths.writeAheadLog);
  await removePath(paths.sharedMemory);
  await removePath(paths.sidecar);
  await removePath(paths.socket);
}

async function removePath(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}
