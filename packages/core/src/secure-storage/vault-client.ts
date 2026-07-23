import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { SecureStorageError, type SecureStorageErrorCode } from './errors.js';
import type { VaultPolicy, VaultStatus } from './vault-backend.js';
import { vaultFilePaths } from './vault-files.js';
import { sendVaultIpcRequest } from './vault-socket.js';

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
  private readonly socketPath: string;

  constructor(options: LocalVaultClientOptions = {}) {
    this.socketPath = vaultFilePaths(options.rootDirectory).socket;
  }

  async changePassphrase(currentUnlockFactor: Uint8Array, nextUnlockFactor: Uint8Array): Promise<void> {
    await this.request('vault.changePassphrase', {
      currentUnlockFactor: Buffer.from(currentUnlockFactor).toString('base64'),
      nextUnlockFactor: Buffer.from(nextUnlockFactor).toString('base64'),
    });
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
    return parseStatus(
      await this.request('vault.unlock', {
        unlockFactor: Buffer.from(unlockFactor).toString('base64'),
      }),
    );
  }

  private async request(
    method: Parameters<typeof sendVaultIpcRequest>[1]['method'],
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = await sendVaultIpcRequest(this.socketPath, {
      id: `req_${randomUUID().replaceAll('-', '')}`,
      method,
      params,
      version: 1,
    });
    if (!response.ok) {
      throw new SecureStorageError(codeFromResponse(response.error.code), response.error.message);
    }
    return response.result;
  }
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
