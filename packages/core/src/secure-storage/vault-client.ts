import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { SecureStorageError, type SecureStorageErrorCode } from './errors.js';
import type { VaultPolicy, VaultStatus } from './vault-backend.js';
import { createLinuxVaultBrokerPeerVerifier } from './vault-broker-auth.js';
import { linuxVaultServiceUserId, usesLinuxVaultService, vaultFilePaths } from './vault-files.js';
import {
  createVaultSocketPeerVerifier,
  shouldRequireVaultPeerVerification,
  type VaultSocketPeerVerifier,
} from './vault-peer-verifier.js';
import { sendVaultIpcRequest } from './vault-socket.js';
import { assertUnlockFactor, equalBytes, VAULT_SALT_BYTES } from './vault-crypto.js';
import { deriveVaultWrappingKey } from './vault-protected-key.js';
import { sendWindowsVaultIpcRequest } from './vault-windows-transport.js';

export interface LocalVaultClientOptions {
  rootDirectory?: string;
}

export interface LocalVaultDaemonInfo {
  buildId: string | null;
  cliVersion: string | null;
  executablePath: string;
  pid: number;
}

export class LocalVaultClient {
  private readonly rootDirectory: string | undefined;
  private readonly socketPath: string;

  constructor(options: LocalVaultClientOptions = {}) {
    this.rootDirectory = options.rootDirectory;
    this.socketPath = vaultFilePaths(options.rootDirectory).socket;
  }

  async changePassphrase(currentUnlockFactor: Uint8Array, nextUnlockFactor: Uint8Array): Promise<void> {
    assertUnlockFactor(currentUnlockFactor);
    assertUnlockFactor(nextUnlockFactor);
    if (equalBytes(currentUnlockFactor, nextUnlockFactor)) {
      throw new SecureStorageError(
        'secure_storage_invalid_path',
        'The new vault PIN or passphrase must differ from the current one.',
      );
    }
    const currentSalt = parseSalt(await this.request('vault.unlockSalt'));
    const nextSalt = randomBytes(VAULT_SALT_BYTES);
    const currentWrappingKey = deriveVaultWrappingKey(currentUnlockFactor, currentSalt);
    const nextWrappingKey = deriveVaultWrappingKey(nextUnlockFactor, nextSalt);
    try {
      await this.request('vault.changePassphrase', {
        currentWrappingKey,
        nextSalt,
        nextWrappingKey,
      });
      await this.lock();
      let oldFactorRejected = false;
      try {
        await this.unlock(currentUnlockFactor);
      } catch (cause) {
        if (cause instanceof SecureStorageError && cause.secureStorageCode === 'secure_storage_corrupt') {
          oldFactorRejected = true;
        } else {
          throw cause;
        }
      }
      if (!oldFactorRejected) {
        await this.lock();
        throw new SecureStorageError(
          'secure_storage_corrupt',
          'The previous vault PIN or passphrase remained valid after rotation.',
        );
      }
      if ((await this.status()).lockState !== 'locked') {
        throw new SecureStorageError('secure_storage_corrupt', 'The vault did not remain locked during rotation.');
      }
      if ((await this.unlock(nextUnlockFactor)).lockState !== 'unlocked') {
        throw new SecureStorageError('secure_storage_corrupt', 'The new vault PIN or passphrase was not activated.');
      }
    } finally {
      currentSalt.fill(0);
      nextSalt.fill(0);
      currentWrappingKey.fill(0);
      nextWrappingKey.fill(0);
    }
  }

  async getPolicy(): Promise<VaultPolicy> {
    return parsePolicy(await this.request('vault.getPolicy'));
  }

  async info(): Promise<LocalVaultDaemonInfo> {
    return parseInfo(await this.request('daemon.info'));
  }

  async lock(): Promise<void> {
    await this.request('vault.lock');
  }

  async reset(): Promise<void> {
    await this.request('vault.reset');
  }

  async shutdown(): Promise<void> {
    await this.request('daemon.shutdown');
  }

  async setPolicy(policy: VaultPolicy): Promise<VaultPolicy> {
    return parsePolicy(await this.request('vault.setPolicy', { policy }));
  }

  async status(): Promise<VaultStatus> {
    return parseStatus(await this.request('vault.status'));
  }

  async unlock(unlockFactor: Uint8Array): Promise<VaultStatus> {
    assertUnlockFactor(unlockFactor);
    const salt = parseSalt(await this.request('vault.unlockSalt'));
    const wrappingKey = deriveVaultWrappingKey(unlockFactor, salt);
    try {
      const reported = parseStatus(
        await this.request('vault.unlock', {
          salt,
          wrappingKey,
        }),
      );
      if (reported.lockState !== 'unlocked' || (await this.status()).lockState !== 'unlocked') {
        throw new SecureStorageError(
          'secure_storage_corrupt',
          'The vault did not remain unlocked after authentication.',
        );
      }
      return reported;
    } finally {
      salt.fill(0);
      wrappingKey.fill(0);
    }
  }

  private async request(
    method: Parameters<typeof sendVaultIpcRequest>[1]['method'],
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const request = {
      id: `req_${randomUUID().replaceAll('-', '')}`,
      method,
      params,
      version: 1 as const,
    };
    const response =
      process.platform === 'win32' && this.rootDirectory === undefined
        ? sendWindowsVaultIpcRequest(this.socketPath, request)
        : await sendVaultIpcRequest(
            this.socketPath,
            request,
            createClientPeerVerifier(this.socketPath, this.rootDirectory),
          );
    if (response.id !== request.id) {
      throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC response is malformed.');
    }
    if (!response.ok) {
      throw new SecureStorageError(codeFromResponse(response.error.code), response.error.message);
    }
    return response.result;
  }
}

function parseSalt(value: Record<string, unknown>): Buffer {
  const salt = value['salt'];
  if (!(salt instanceof Uint8Array) || salt.byteLength !== VAULT_SALT_BYTES) {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC unlock salt response is malformed.');
  }
  const result = Buffer.from(salt);
  salt.fill(0);
  return result;
}

function createClientPeerVerifier(
  socketPath: string,
  rootDirectory: string | undefined,
): VaultSocketPeerVerifier | undefined {
  if (!shouldRequireVaultPeerVerification()) return undefined;
  if (rootDirectory === undefined && usesLinuxVaultService()) {
    return createLinuxVaultBrokerPeerVerifier(linuxVaultServiceUserId(socketPath));
  }
  return createVaultSocketPeerVerifier();
}

function parseInfo(value: Record<string, unknown>): LocalVaultDaemonInfo {
  const cliVersion = value['cliVersion'];
  const buildId = value['buildId'];
  const executablePath = value['executablePath'];
  const pid = value['pid'];
  if (
    !(buildId === null || typeof buildId === 'string') ||
    !(cliVersion === null || typeof cliVersion === 'string') ||
    typeof executablePath !== 'string' ||
    !isNonNegativeInteger(pid)
  ) {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC daemon info response is malformed.');
  }
  return { buildId, cliVersion, executablePath, pid };
}

function parseStatus(value: Record<string, unknown>): VaultStatus {
  const lockState = value['lockState'];
  const daemonRunning = value['daemonRunning'];
  if (
    !(lockState === 'locked' || lockState === 'not_initialized' || lockState === 'unlocked') ||
    typeof daemonRunning !== 'boolean'
  ) {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC status response is malformed.');
  }
  return { daemonRunning, lockState };
}

function parsePolicy(value: Record<string, unknown>): VaultPolicy {
  const idleTimeoutSeconds = value['idleTimeoutSeconds'];
  const lockOnSleep = value['lockOnSleep'];
  if (!(idleTimeoutSeconds === null || isNonNegativeInteger(idleTimeoutSeconds)) || typeof lockOnSleep !== 'boolean') {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC policy response is malformed.');
  }
  return { idleTimeoutSeconds, lockOnSleep };
}

function codeFromResponse(code: string): SecureStorageErrorCode {
  switch (code) {
    case 'secure_storage_corrupt':
    case 'secure_storage_invalid_path':
    case 'secure_storage_io_error':
    case 'secure_storage_peer_verification_failed':
    case 'secure_storage_secret_conflict':
    case 'secure_storage_secret_missing':
    case 'secure_storage_unavailable':
    case 'vault_daemon_busy':
    case 'vault_locked':
    case 'vault_not_initialized':
      return code;
    default:
      return 'secure_storage_io_error';
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
