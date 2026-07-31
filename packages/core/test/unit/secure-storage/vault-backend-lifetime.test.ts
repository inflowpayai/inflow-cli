import { describe, expect, it, vi } from 'vitest';
import type { VaultBackend, VaultPolicy } from '../../../src/secure-storage/vault-backend.js';
import { LifetimeVaultBackend, VaultBackendLifetime } from '../../../src/secure-storage/vault-backend-lifetime.js';
import { parseVaultSecretReference } from '../../../src/secure-storage/vault-types.js';

describe('LifetimeVaultBackend', () => {
  it('forwards every backend operation and refreshes or clears the lifetime as appropriate', async () => {
    const policy: VaultPolicy = { idleTimeoutSeconds: null, lockOnSleep: false };
    const reference = parseVaultSecretReference('vlt_0123456789abcdef0123456789abcdef');
    const payload = { payload: new Uint8Array([7]), reference };
    const status = { daemonRunning: false, lockState: 'unlocked' as const };
    const salt = new Uint8Array(16);
    const backend: VaultBackend = {
      changePassphrase: vi.fn(),
      changeWrappingKey: vi.fn(),
      deleteExpired: vi.fn(),
      deleteSecret: vi.fn(),
      exists: vi.fn(() => true),
      getPolicy: vi.fn(() => policy),
      getSecret: vi.fn(() => payload),
      lock: vi.fn(),
      putSecret: vi.fn(() => reference),
      reset: vi.fn(),
      setPolicy: vi.fn(() => policy),
      status: vi.fn(() => status),
      touch: vi.fn(),
      unlock: vi.fn(() => status),
      unlockSalt: vi.fn(() => salt),
      unlockWithWrappingKey: vi.fn(() => status),
    };
    const lifetime = new VaultBackendLifetime();
    const refresh = vi.spyOn(lifetime, 'refresh');
    const clear = vi.spyOn(lifetime, 'clear');
    const onReset = vi.fn();
    const wrapped = new LifetimeVaultBackend(backend, lifetime, onReset);
    const secretInput = { expectedKind: 'inflow_api_key' as const, reference };

    await wrapped.changePassphrase(new Uint8Array([1]), new Uint8Array([2]));
    await wrapped.changeWrappingKey(new Uint8Array([1]), new Uint8Array([2]), salt);
    await wrapped.deleteExpired({ now: '2026-07-24T00:00:00.000Z' });
    await wrapped.deleteSecret(secretInput);
    await expect(wrapped.exists(secretInput)).resolves.toBe(true);
    await expect(wrapped.getPolicy()).resolves.toBe(policy);
    await expect(wrapped.getSecret(secretInput)).resolves.toBe(payload);
    await expect(wrapped.putSecret({ expectedKind: 'inflow_api_key', payload: new Uint8Array([7]) })).resolves.toBe(
      reference,
    );
    await expect(wrapped.setPolicy(policy)).resolves.toBe(policy);
    await expect(wrapped.status()).resolves.toEqual({ daemonRunning: true, lockState: 'unlocked' });
    await wrapped.touch(secretInput);
    await expect(wrapped.unlock(new Uint8Array([1]))).resolves.toEqual({
      daemonRunning: true,
      lockState: 'unlocked',
    });
    await expect(wrapped.unlockSalt()).resolves.toBe(salt);
    await expect(wrapped.unlockWithWrappingKey(new Uint8Array([1]), salt)).resolves.toEqual({
      daemonRunning: true,
      lockState: 'unlocked',
    });
    const clearsBeforeLock = clear.mock.calls.length;
    await wrapped.lock();
    expect(clear).toHaveBeenCalledTimes(clearsBeforeLock + 1);
    await wrapped.reset();

    expect(refresh).toHaveBeenCalled();
    expect(clear).toHaveBeenCalledTimes(clearsBeforeLock + 2);
    expect(onReset).toHaveBeenCalledOnce();
    expect(onReset.mock.invocationCallOrder[0]).toBeLessThan(
      (backend.reset as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] as number,
    );
  });

  it('does not refresh lifetime state for an uninitialized vault', async () => {
    const backend = uninitializedBackend();
    const lifetime = new VaultBackendLifetime();
    const refresh = vi.spyOn(lifetime, 'refresh');
    const wrapped = new LifetimeVaultBackend(backend, lifetime);

    await expect(wrapped.status()).resolves.toEqual({
      daemonRunning: true,
      lockState: 'not_initialized',
    });

    expect(refresh).not.toHaveBeenCalled();
  });
});

function uninitializedBackend(): VaultBackend {
  const unavailable = (): never => {
    throw new Error('unexpected backend operation');
  };
  return {
    changePassphrase: unavailable,
    changeWrappingKey: unavailable,
    deleteExpired: unavailable,
    deleteSecret: unavailable,
    exists: unavailable,
    getPolicy: unavailable,
    getSecret: unavailable,
    lock: unavailable,
    putSecret: unavailable,
    reset: unavailable,
    setPolicy: unavailable,
    status: () => ({ daemonRunning: false, lockState: 'not_initialized' }),
    touch: unavailable,
    unlock: unavailable,
    unlockSalt: unavailable,
    unlockWithWrappingKey: unavailable,
  };
}
