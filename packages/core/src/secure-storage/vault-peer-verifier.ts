import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';
import { SecureStorageError } from './errors.js';

export interface VaultSocketPeer {
  path: string;
  pid: number;
  uid: number;
}

export type VaultSocketPeerVerifier = (socket: Socket) => Promise<void> | void;

interface NativeVaultPeerModule {
  peerInfo(fd: number): VaultSocketPeer;
}

interface VaultPeerVerifierOptions {
  expectedExecutablePath?: string;
  expectedTeamId?: string;
  nativeModulePath?: string;
  requireSignature?: boolean;
}

interface VaultPeerVerifierDependencies {
  currentUserId(): number | undefined;
  loadNativeModule(path: string): NativeVaultPeerModule;
  realpath(path: string): string;
  verifySignature(path: string, teamId: string): void;
}

const DEFAULT_TEAM_ID = 'B96U57DTR2';

export function shouldRequireVaultPeerVerification(): boolean {
  if (process.env['INFLOW_VAULT_PEER_VERIFICATION'] === 'required') return true;
  if (process.env['INFLOW_VAULT_PEER_VERIFICATION'] === 'disabled') return false;
  return process.platform === 'darwin' && realExecutablePath().includes('/InFlow.app/Contents/MacOS/');
}

export function createVaultSocketPeerVerifier(
  options: VaultPeerVerifierOptions = {},
  dependencies: VaultPeerVerifierDependencies = defaultPeerVerifierDependencies,
): VaultSocketPeerVerifier {
  if (process.platform !== 'darwin') {
    throw new SecureStorageError('secure_storage_unavailable', 'Vault peer verification is unavailable.');
  }
  const native = dependencies.loadNativeModule(options.nativeModulePath ?? defaultNativeModulePath());
  const expectedPath = dependencies.realpath(options.expectedExecutablePath ?? process.execPath);
  const expectedTeamId = options.expectedTeamId ?? process.env['INFLOW_CODESIGN_TEAM_ID'] ?? DEFAULT_TEAM_ID;
  const requireSignature = options.requireSignature ?? expectedPath.includes('/InFlow.app/Contents/MacOS/');

  return (socket) => {
    const peer = native.peerInfo(socketFileDescriptor(socket));
    const currentUserId = dependencies.currentUserId();
    if (currentUserId === undefined || peer.uid !== currentUserId) {
      throw new SecureStorageError('secure_storage_unavailable', 'Vault peer verification failed.');
    }
    if (dependencies.realpath(peer.path) !== expectedPath) {
      throw new SecureStorageError('secure_storage_unavailable', 'Vault peer verification failed.');
    }
    if (requireSignature) dependencies.verifySignature(peer.path, expectedTeamId);
  };
}

export function socketFileDescriptor(socket: Socket): number {
  const candidate = socket as Socket & { _handle?: { fd?: unknown } };
  const fd = candidate._handle?.fd;
  if (typeof fd !== 'number' || !Number.isSafeInteger(fd) || fd < 0) {
    throw new SecureStorageError('secure_storage_unavailable', 'Vault peer verification failed.');
  }
  return fd;
}

function defaultNativeModulePath(): string {
  const executablePath = realExecutablePath();
  if (executablePath.includes('/InFlow.app/Contents/MacOS/')) {
    return resolve(dirname(executablePath), '../Resources/app/native/vault_peer_darwin.node');
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../native/build/vault_peer_darwin.node');
}

function realExecutablePath(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

const defaultPeerVerifierDependencies: VaultPeerVerifierDependencies = {
  currentUserId() {
    return typeof process.getuid === 'function' ? process.getuid() : undefined;
  },
  loadNativeModule(path) {
    const require = createRequire(import.meta.url);
    return require(path) as NativeVaultPeerModule;
  },
  realpath(path) {
    return realpathSync(path);
  },
  verifySignature(path, teamId) {
    const requirement = `anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
    try {
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', `--test-requirement==${requirement}`, path], {
        stdio: 'ignore',
      });
    } catch {
      throw new SecureStorageError('secure_storage_unavailable', 'Vault peer verification failed.');
    }
  },
};
