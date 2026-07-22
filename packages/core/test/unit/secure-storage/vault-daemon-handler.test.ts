import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { SecureStorageError } from '../../../src/secure-storage/errors.js';
import type {
  VaultBackend,
  VaultPolicy,
  VaultSecretPayload,
  VaultStatus,
} from '../../../src/secure-storage/vault-backend.js';
import { handleVaultIpcRequest } from '../../../src/secure-storage/vault-daemon-handler.js';
import type { VaultIpcRequest } from '../../../src/secure-storage/vault-ipc.js';
import type { VaultSecretReference } from '../../../src/secure-storage/vault-types.js';

class FakeVaultBackend implements VaultBackend {
  policy: VaultPolicy = {
    idleTimeoutSeconds: 28_800,
    lockOnDaemonExit: true,
    lockOnExplicitLogout: true,
    lockOnSleep: true,
  };
  secret: VaultSecretPayload = {
    payload: Buffer.from('secret'),
    reference: { reference: 'vlt_11111111111111111111111111111111' },
  };
  unlocked = false;

  async changePassphrase(_currentUnlockFactor: Uint8Array, _nextUnlockFactor: Uint8Array): Promise<void> {}

  deleteExpired(_input: { now: string }): void {}

  deleteSecret(_input: { expectedKind: 'inflow_api_key'; reference: VaultSecretReference }): void {}

  exists(_input: { expectedKind: 'inflow_api_key'; reference: VaultSecretReference }): boolean {
    return true;
  }

  getPolicy(): VaultPolicy {
    return this.policy;
  }

  getSecret(_input: { expectedKind: 'inflow_api_key'; reference: VaultSecretReference }): VaultSecretPayload {
    return this.secret;
  }

  lock(): void {
    this.unlocked = false;
  }

  putSecret(_input: { expectedKind: 'inflow_api_key'; payload: Uint8Array }): VaultSecretReference {
    return this.secret.reference;
  }

  reset(): void {
    this.unlocked = false;
  }

  setPolicy(policy: VaultPolicy): VaultPolicy {
    this.policy = policy;
    return policy;
  }

  status(): VaultStatus {
    return { daemonRunning: true, lockState: this.unlocked ? 'unlocked' : 'locked' };
  }

  touch(_input: { expectedKind: 'inflow_api_key'; reference: VaultSecretReference }): void {}

  unlock(_unlockFactor: Uint8Array): VaultStatus {
    this.unlocked = true;
    return this.status();
  }
}

function request(method: VaultIpcRequest['method'], params: Record<string, unknown> = {}): VaultIpcRequest {
  return { id: 'req_1', method, params, version: 1 };
}

describe('handleVaultIpcRequest', () => {
  it('dispatches generic vault and secret methods without protocol-specific behavior', async () => {
    const backend = new FakeVaultBackend();
    const reference = 'vlt_11111111111111111111111111111111';

    await expect(
      handleVaultIpcRequest(
        backend,
        request('vault.unlock', { unlockFactor: Buffer.from('123456').toString('base64') }),
      ),
    ).resolves.toMatchObject({ ok: true, result: { lockState: 'unlocked' } });
    await expect(handleVaultIpcRequest(backend, request('vault.status'))).resolves.toMatchObject({
      ok: true,
      result: { daemonRunning: true, lockState: 'unlocked' },
    });
    await expect(
      handleVaultIpcRequest(
        backend,
        request('secret.put', {
          expectedKind: 'inflow_api_key',
          payload: Buffer.from('api-key').toString('base64'),
        }),
      ),
    ).resolves.toMatchObject({ ok: true, result: { reference } });
    await expect(
      handleVaultIpcRequest(backend, request('secret.get', { expectedKind: 'inflow_api_key', reference })),
    ).resolves.toMatchObject({
      ok: true,
      result: { payload: Buffer.from('secret').toString('base64'), reference },
    });
    await expect(
      handleVaultIpcRequest(backend, request('secret.exists', { expectedKind: 'inflow_api_key', reference })),
    ).resolves.toMatchObject({ ok: true, result: { exists: true } });
    await expect(
      handleVaultIpcRequest(backend, request('secret.touch', { expectedKind: 'inflow_api_key', reference })),
    ).resolves.toMatchObject({ ok: true, result: {} });
    await expect(
      handleVaultIpcRequest(backend, request('secret.delete', { expectedKind: 'inflow_api_key', reference })),
    ).resolves.toMatchObject({ ok: true, result: {} });
    await expect(
      handleVaultIpcRequest(backend, request('secret.deleteExpired', { now: '2026-01-01T00:00:00.000Z' })),
    ).resolves.toMatchObject({ ok: true, result: {} });
  });

  it('dispatches policy, passphrase, reset, lock, and shutdown operations', async () => {
    const backend = new FakeVaultBackend();
    const policy = {
      idleTimeoutSeconds: null,
      lockOnDaemonExit: true,
      lockOnExplicitLogout: true,
      lockOnSleep: false,
    };

    await expect(handleVaultIpcRequest(backend, request('vault.setPolicy', { policy }))).resolves.toMatchObject({
      ok: true,
      result: policy,
    });
    await expect(handleVaultIpcRequest(backend, request('vault.getPolicy'))).resolves.toMatchObject({
      ok: true,
      result: policy,
    });
    await expect(
      handleVaultIpcRequest(
        backend,
        request('vault.changePassphrase', {
          currentUnlockFactor: Buffer.from('123456').toString('base64'),
          nextUnlockFactor: Buffer.from('654321').toString('base64'),
        }),
      ),
    ).resolves.toMatchObject({ ok: true, result: {} });
    await expect(handleVaultIpcRequest(backend, request('vault.reset'))).resolves.toMatchObject({
      ok: true,
      result: {},
    });
    await expect(handleVaultIpcRequest(backend, request('vault.lock'))).resolves.toMatchObject({
      ok: true,
      result: {},
    });
    await expect(handleVaultIpcRequest(backend, request('daemon.shutdown'))).resolves.toMatchObject({
      ok: true,
      result: {},
    });
  });

  it('rejects malformed parameters and redacts unexpected failures', async () => {
    const backend = new FakeVaultBackend();
    backend.getSecret = () => {
      throw new Error('secret-value leaked');
    };

    await expect(
      handleVaultIpcRequest(backend, request('secret.get', { expectedKind: 'inflow_api_key', reference: 'bad-ref' })),
    ).resolves.toMatchObject({
      error: {
        code: 'secure_storage_invalid_path',
        message: 'Vault secret reference is malformed.',
      },
      ok: false,
    });
    await expect(
      handleVaultIpcRequest(
        backend,
        request('secret.get', {
          expectedKind: 'inflow_api_key',
          reference: 'vlt_11111111111111111111111111111111',
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        code: 'secure_storage_io_error',
        message: 'The InFlow vault operation failed.',
      },
      ok: false,
    });
  });

  it('rejects malformed policy, base64, kind, and optional fields', async () => {
    const backend = new FakeVaultBackend();

    for (const ipcRequest of [
      request('vault.setPolicy', { policy: null }),
      request('vault.setPolicy', {
        policy: {
          idleTimeoutSeconds: -1,
          lockOnDaemonExit: true,
          lockOnExplicitLogout: true,
          lockOnSleep: true,
        },
      }),
      request('secret.put', {
        expectedKind: 'inflow_api_key',
        expiresAt: '',
        payload: Buffer.from('api-key').toString('base64'),
      }),
      request('secret.put', {
        expectedKind: 'unknown',
        payload: Buffer.from('api-key').toString('base64'),
      }),
      request('vault.unlock', { unlockFactor: 'not-base64!' }),
    ]) {
      await expect(handleVaultIpcRequest(backend, ipcRequest)).resolves.toMatchObject({
        error: {
          code: 'secure_storage_invalid_path',
          message: 'Vault IPC request parameters are malformed.',
        },
        ok: false,
      });
    }
  });

  it('returns secure-storage errors without exposing payloads', async () => {
    const backend = new FakeVaultBackend();
    backend.putSecret = () => {
      throw new SecureStorageError('secure_storage_secret_missing', 'The InFlow vault is locked.');
    };

    await expect(
      handleVaultIpcRequest(
        backend,
        request('secret.put', {
          expectedKind: 'inflow_api_key',
          payload: Buffer.from('api-key').toString('base64'),
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        code: 'secure_storage_secret_missing',
        message: 'The InFlow vault is locked.',
      },
      ok: false,
    });
  });
});
