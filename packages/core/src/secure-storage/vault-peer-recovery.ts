import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { SecureStorageError } from './errors.js';
import { usesLinuxVaultService, vaultFilePaths } from './vault-files.js';
import { createSameUserVaultSocketPeerVerifier, type VaultSocketPeer } from './vault-peer-verifier.js';
import { inspectVaultSocketPeer, isReachableVaultSocket } from './vault-socket.js';

const SHUTDOWN_TIMEOUT_MILLISECONDS = 2_000;

export interface LocalVaultPeerRecoveryDependencies {
  currentProcessId: number;
  inspectPeer: (socketPath: string) => Promise<VaultSocketPeer>;
  isVaultDaemonProcess: (peer: VaultSocketPeer) => boolean;
  now: () => number;
  platform: NodeJS.Platform;
  processRunning: (processId: number) => boolean;
  signal: (processId: number, signal: NodeJS.Signals) => void;
  sleep: (milliseconds: number) => Promise<void>;
  socketReachable: (socketPath: string) => Promise<boolean>;
  usesLinuxService: boolean;
}

interface VaultDaemonProcessDependencies {
  platform: NodeJS.Platform;
  readDarwinArguments: (processId: number) => string[];
  readLinuxArguments: (processId: number) => string[];
}

type ExecuteProcessCommand = (file: string, arguments_: string[], options: { encoding: 'utf8' }) => string;
type ProbeProcess = (processId: number, signal: 0) => boolean;

const defaultProcessDependencies: VaultDaemonProcessDependencies = {
  platform: process.platform,
  readDarwinArguments,
  readLinuxArguments: (processId) => readFileSync(`/proc/${processId}/cmdline`).toString('utf8').split('\0'),
};

const defaultDependencies: LocalVaultPeerRecoveryDependencies = {
  currentProcessId: process.pid,
  inspectPeer: (socketPath) => inspectVaultSocketPeer(socketPath, createSameUserVaultSocketPeerVerifier()),
  isVaultDaemonProcess,
  now: Date.now,
  platform: process.platform,
  processRunning,
  signal: (processId, signal) => {
    process.kill(processId, signal);
  },
  sleep: delay,
  socketReachable: isReachableVaultSocket,
  usesLinuxService: usesLinuxVaultService(),
};

function readDarwinArguments(processId: number, execute: ExecuteProcessCommand = execFileSync): string[] {
  return execute('/bin/ps', ['-p', String(processId), '-o', 'command='], { encoding: 'utf8' })
    .trim()
    .split(/\s+/u);
}

function processRunning(
  processId: number,
  probe: ProbeProcess = (targetProcessId, signal) => process.kill(targetProcessId, signal),
): boolean {
  try {
    probe(processId, 0);
    return true;
  } catch (cause) {
    if (hasErrorCode(cause, 'ESRCH')) return false;
    throw cause;
  }
}

export async function shutdownUnverifiedLocalVaultDaemon(rootDirectory?: string): Promise<void> {
  const socketPath = vaultFilePaths(rootDirectory).socket;
  await shutdownUnverifiedLocalVaultDaemonWithDependencies(socketPath, defaultDependencies);
}

async function shutdownUnverifiedLocalVaultDaemonWithDependencies(
  socketPath: string,
  dependencies: LocalVaultPeerRecoveryDependencies,
): Promise<void> {
  const failure = peerVerificationFailure();
  if (
    dependencies.platform === 'win32' ||
    (dependencies.platform === 'linux' && dependencies.usesLinuxService) ||
    (dependencies.platform !== 'darwin' && dependencies.platform !== 'linux')
  ) {
    throw failure;
  }

  try {
    const peer = await dependencies.inspectPeer(socketPath);
    if (peer.pid === dependencies.currentProcessId || !dependencies.isVaultDaemonProcess(peer)) throw failure;
    try {
      dependencies.signal(peer.pid, 'SIGTERM');
    } catch (cause) {
      if (!hasErrorCode(cause, 'ESRCH')) throw cause;
    }
    const deadline = dependencies.now() + SHUTDOWN_TIMEOUT_MILLISECONDS;
    while (dependencies.now() < deadline) {
      if (!dependencies.processRunning(peer.pid) && !(await dependencies.socketReachable(socketPath))) return;
      await dependencies.sleep(25);
    }
  } catch {
    throw failure;
  }
  throw failure;
}

function isVaultDaemonProcess(
  peer: VaultSocketPeer,
  dependencies: VaultDaemonProcessDependencies = defaultProcessDependencies,
): boolean {
  if (basename(peer.path) === 'inflow') return true;
  try {
    if (dependencies.platform === 'linux') return hasVaultDaemonArguments(dependencies.readLinuxArguments(peer.pid));
    if (dependencies.platform === 'darwin') return hasVaultDaemonArguments(dependencies.readDarwinArguments(peer.pid));
  } catch {
    return false;
  }
  return false;
}

function hasVaultDaemonArguments(arguments_: string[]): boolean {
  return arguments_.some(
    (argument, index) =>
      argument === '--daemon=vault' || (argument === '--daemon' && arguments_[index + 1] === 'vault'),
  );
}

function hasErrorCode(value: unknown, code: string): boolean {
  return typeof value === 'object' && value !== null && 'code' in value && value.code === code;
}

function peerVerificationFailure(): SecureStorageError {
  return new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
}

/** @internal */
export const __testing = {
  hasVaultDaemonArguments,
  isVaultDaemonProcess,
  processRunning,
  readDarwinArguments,
  shutdownUnverifiedLocalVaultDaemonWithDependencies,
};
