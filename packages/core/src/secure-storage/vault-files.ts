import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

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

export function vaultFilePaths(rootDirectory = defaultVaultRoot()): VaultFilePaths {
  const database = path.join(rootDirectory, 'inflow.sqlite3');
  const runDirectory = path.join(rootDirectory, 'run');
  return {
    database,
    runDirectory,
    sharedMemory: `${database}-shm`,
    sidecar: path.join(rootDirectory, 'inflow.vault'),
    socket: path.join(runDirectory, 'vault.sock'),
    writeAheadLog: `${database}-wal`,
  };
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
