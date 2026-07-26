import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';
import { SecureStorageError } from './errors.js';
import { runtimeRequire } from './runtime-require.js';

declare const __VAULT_PEER_NATIVE_SHA256__: string | undefined;

export interface VaultSocketPeer {
  path: string;
  pid: number;
  principal?: string;
  uid: number;
}

export type VaultSocketPeerVerifier = (socket: Socket) => Promise<VaultSocketPeer> | VaultSocketPeer;

interface NativeVaultPeerModule {
  peerCredentials(fd: number): Pick<VaultSocketPeer, 'pid' | 'uid'>;
  peerInfo(fd: number): VaultSocketPeer;
}

interface VaultPeerVerifierOptions {
  expectedExecutablePath?: string;
  expectedNativeModuleSha256?: string;
  expectedTeamId?: string;
  expectedUserId?: number;
  nativeModulePath?: string;
  requireSameUser?: boolean;
  requireSignature?: boolean;
}

export interface VaultPeerVerificationConfig {
  expectedExecutablePath: string;
  expectedNativeModuleSha256?: string;
  expectedTeamId: string;
  expectedUserId?: number;
  nativeModulePath: string;
  requireSameUser: boolean;
  requireSignature: boolean;
}

interface VaultPeerVerifierDependencies {
  currentUserId(): number | undefined;
  loadNativeModule(path: string): NativeVaultPeerModule;
  realpath(path: string): string;
  verifyNativeModule(
    path: string,
    options: { expectedSha256?: string; expectedTeamId: string; requireSignature: boolean },
  ): void;
  verifySignature(path: string, teamId: string): void;
}

const DEFAULT_TEAM_ID = 'B96U57DTR2';

export function shouldRequireVaultPeerVerification(): boolean {
  if (process.platform === 'linux') return true;
  return process.platform === 'darwin' && realExecutablePath().includes('/InFlow.app/Contents/MacOS/');
}

export function createVaultSocketPeerVerifier(
  options: VaultPeerVerifierOptions = {},
  dependencies: VaultPeerVerifierDependencies = defaultPeerVerifierDependencies,
): VaultSocketPeerVerifier {
  const config = createVaultPeerVerificationConfig(options, dependencies);
  verifyVaultPeerVerificationConfig(config, dependencies);
  const native = dependencies.loadNativeModule(config.nativeModulePath);

  return (socket) => {
    const peer = native.peerInfo(socketFileDescriptor(socket));
    if (config.expectedUserId !== undefined) {
      if (peer.uid !== config.expectedUserId) {
        throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
      }
    } else if (config.requireSameUser) {
      const currentUserId = dependencies.currentUserId();
      if (currentUserId === undefined || peer.uid !== currentUserId) {
        throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
      }
    }
    if (dependencies.realpath(peer.path) !== config.expectedExecutablePath) {
      throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
    }
    if (config.requireSignature) dependencies.verifySignature(peer.path, config.expectedTeamId);
    return peer;
  };
}

export function verifyTransferredVaultSocketPeer(socket: Socket, attestedPeer: VaultSocketPeer): VaultSocketPeer {
  const config = createVaultPeerVerificationConfig();
  verifyVaultPeerVerificationConfig(config);
  if (defaultPeerVerifierDependencies.realpath(attestedPeer.path) !== config.expectedExecutablePath) {
    throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
  }
  const credentials = defaultPeerVerifierDependencies
    .loadNativeModule(config.nativeModulePath)
    .peerCredentials(socketFileDescriptor(socket));
  if (credentials.pid !== attestedPeer.pid || credentials.uid !== attestedPeer.uid) {
    throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
  }
  return attestedPeer;
}

export function verifyVaultPeerVerificationConfig(
  config: VaultPeerVerificationConfig,
  dependencies: VaultPeerVerifierDependencies = defaultPeerVerifierDependencies,
): void {
  dependencies.verifyNativeModule(config.nativeModulePath, {
    ...(config.expectedNativeModuleSha256 === undefined ? {} : { expectedSha256: config.expectedNativeModuleSha256 }),
    expectedTeamId: config.expectedTeamId,
    requireSignature: config.requireSignature,
  });
}

export function createVaultPeerVerificationConfig(
  options: VaultPeerVerifierOptions = {},
  dependencies: VaultPeerVerifierDependencies = defaultPeerVerifierDependencies,
): VaultPeerVerificationConfig {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new SecureStorageError('secure_storage_unavailable', 'Vault peer verification is unavailable.');
  }
  const nativeModulePath = options.nativeModulePath ?? defaultNativeModulePath();
  const expectedPath = dependencies.realpath(options.expectedExecutablePath ?? process.execPath);
  const expectedTeamId = options.expectedTeamId ?? DEFAULT_TEAM_ID;
  const requireSignature =
    options.requireSignature ?? (process.platform === 'darwin' && expectedPath.includes('/InFlow.app/Contents/MacOS/'));
  const expectedNativeModuleSha256 = options.expectedNativeModuleSha256 ?? embeddedNativeModuleSha256();
  if (
    options.expectedUserId !== undefined &&
    (!Number.isSafeInteger(options.expectedUserId) || options.expectedUserId < 0)
  ) {
    throw new SecureStorageError('secure_storage_unavailable', 'Vault peer verification configuration is invalid.');
  }
  if (
    options.nativeModulePath === undefined &&
    expectedNativeModuleSha256 === undefined &&
    isPackagedVaultExecutable()
  ) {
    throw new SecureStorageError('secure_storage_unavailable', 'Vault native module integrity is unavailable.');
  }
  return {
    expectedExecutablePath: expectedPath,
    ...(expectedNativeModuleSha256 === undefined ? {} : { expectedNativeModuleSha256 }),
    expectedTeamId,
    ...(options.expectedUserId === undefined ? {} : { expectedUserId: options.expectedUserId }),
    nativeModulePath,
    requireSameUser: options.requireSameUser ?? true,
    requireSignature,
  };
}

export function verifyVaultNativeModule(
  path: string,
  options: {
    expectedSha256?: string;
    expectedTeamId: string;
    requireSignature: boolean;
  },
): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o022) !== 0)) {
      throw new Error('unsafe native module');
    }
    if (path !== resolve(path)) throw new Error('non-canonical native module');
    if (options.expectedSha256 !== undefined) {
      const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
      if (actual !== options.expectedSha256) throw new Error('native module digest mismatch');
    }
    if (options.requireSignature) defaultPeerVerifierDependencies.verifySignature(path, options.expectedTeamId);
  } catch {
    throw new SecureStorageError('secure_storage_unavailable', 'Vault native module verification failed.');
  }
}

export function socketFileDescriptor(socket: Socket): number {
  const candidate = socket as Socket & { _handle?: { fd?: unknown } };
  const fd = candidate._handle?.fd;
  if (typeof fd !== 'number' || !Number.isSafeInteger(fd) || fd < 0) {
    throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
  }
  return fd;
}

function defaultNativeModulePath(): string {
  const executablePath = realExecutablePath();
  if (executablePath.includes('/InFlow.app/Contents/MacOS/')) {
    return resolve(dirname(executablePath), '../Resources/app/native/vault_peer_darwin.node');
  }
  if (process.platform === 'linux' && executablePath.includes('/bin/inflow')) {
    return resolve(dirname(executablePath), '../lib/inflow/native/vault_peer_linux.node');
  }
  const platformName = process.platform === 'linux' ? 'linux' : 'darwin';
  return resolve(dirname(fileURLToPath(import.meta.url)), `../../native/build/vault_peer_${platformName}.node`);
}

function realExecutablePath(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

function embeddedNativeModuleSha256(): string | undefined {
  return typeof __VAULT_PEER_NATIVE_SHA256__ === 'string' ? __VAULT_PEER_NATIVE_SHA256__ : undefined;
}

function isPackagedVaultExecutable(): boolean {
  const executable = realExecutablePath();
  return executable.endsWith('/bin/inflow') || executable.includes('/InFlow.app/Contents/MacOS/');
}

const defaultPeerVerifierDependencies: VaultPeerVerifierDependencies = {
  currentUserId() {
    return typeof process.getuid === 'function' ? process.getuid() : undefined;
  },
  loadNativeModule(path) {
    return runtimeRequire()(path) as NativeVaultPeerModule;
  },
  realpath(path) {
    return realpathSync(path);
  },
  verifyNativeModule(path, options) {
    verifyVaultNativeModule(path, options);
  },
  verifySignature(path, teamId) {
    const requirement = `anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
    try {
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', `--test-requirement==${requirement}`, path], {
        stdio: 'ignore',
      });
    } catch {
      throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
    }
  },
};
