import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { __testing, createVaultCli } from '../../../../src/commands/vault/index.js';
import { SecureStorageError, type VaultPolicy, type VaultStatus } from '@inflowpayai/inflow-core';

type ErrorShape = { code: string; message: string };
type VaultTestClient = {
  changePassphrase: ReturnType<typeof vi.fn>;
  getPolicy: ReturnType<typeof vi.fn>;
  lock: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  setPolicy: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  unlock: ReturnType<typeof vi.fn>;
};
type VaultTestDeps = {
  client: VaultTestClient;
  ensureDaemon: ReturnType<typeof vi.fn>;
  readPassphrase: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
};

function context(options: Record<string, unknown> = {}, agent = true) {
  return {
    agent,
    error(error: ErrorShape): never {
      throw Object.assign(new Error(error.message), error);
    },
    formatExplicit: agent,
    options,
  };
}

function deps(overrides: Partial<VaultTestDeps> = {}): VaultTestDeps {
  const client = {
    changePassphrase: vi.fn(() => Promise.resolve()),
    getPolicy: vi.fn(() =>
      Promise.resolve({
        idleTimeoutSeconds: 28_800,
        lockOnDaemonExit: true,
        lockOnExplicitLogout: true,
        lockOnSleep: true,
      } satisfies VaultPolicy),
    ),
    lock: vi.fn(() => Promise.resolve()),
    reset: vi.fn(() => Promise.resolve()),
    setPolicy: vi.fn((policy: VaultPolicy) => Promise.resolve(policy)),
    status: vi.fn(() =>
      Promise.resolve({
        daemonRunning: true,
        lockState: 'locked',
      } satisfies VaultStatus),
    ),
    unlock: vi.fn(() =>
      Promise.resolve({
        daemonRunning: true,
        lockState: 'unlocked',
      } satisfies VaultStatus),
    ),
  };
  return {
    client,
    ensureDaemon: vi.fn(() => Promise.resolve(client)),
    readPassphrase: vi.fn(() => Promise.resolve(Buffer.from('123456'))),
    write: vi.fn(),
    ...overrides,
  };
}

describe('vault command runners', () => {
  it('reports vault status in agent shape', async () => {
    const harness = deps();

    await expect(__testing.runVaultStatus(context(), harness)).resolves.toEqual({
      daemon_running: true,
      lock_state: 'locked',
    });
  });

  it('renders status in human mode', async () => {
    const harness = deps();

    await expect(__testing.runVaultStatus(context({}, false), harness)).resolves.toEqual({
      daemon_running: true,
      lock_state: 'locked',
    });

    expect(harness.write).toHaveBeenCalledWith('Vault status: locked\nDaemon running: yes\n');
  });

  it('unlocks and initializes with the first-run prompt', async () => {
    const harness = deps();
    harness.client.status.mockResolvedValueOnce({ daemonRunning: true, lockState: 'not_initialized' });

    await expect(__testing.runVaultUnlock(context(), harness)).resolves.toEqual({
      daemon_running: true,
      lock_state: 'unlocked',
    });

    expect(harness.readPassphrase).toHaveBeenCalledWith(
      'Create an InFlow vault PIN or passphrase: ',
      expect.anything(),
    );
    expect(harness.client.unlock).toHaveBeenCalledWith(Buffer.from([0, 0, 0, 0, 0, 0]));
  });

  it('unlocks an existing vault with the returning prompt and human message', async () => {
    const harness = deps();

    await expect(__testing.runVaultUnlock(context({}, false), harness)).resolves.toEqual({
      daemon_running: true,
      lock_state: 'unlocked',
    });

    expect(harness.readPassphrase).toHaveBeenCalledWith(
      'Enter the InFlow vault PIN or passphrase: ',
      expect.anything(),
    );
    expect(harness.write).toHaveBeenCalledWith('Vault unlocked.\n');
  });

  it('rejects short unlock passphrases before calling the daemon', async () => {
    const harness = deps({
      readPassphrase: vi.fn(() => Promise.resolve(Buffer.from('123'))),
    });

    await expect(__testing.runVaultUnlock(context(), harness)).rejects.toMatchObject({
      code: 'VAULT_PASSPHRASE_TOO_SHORT',
    });
    expect(harness.client.unlock).not.toHaveBeenCalled();
  });

  it('updates only supplied policy fields', async () => {
    const harness = deps();

    await expect(
      __testing.runVaultPolicySet(
        context({
          idleTimeoutSeconds: 0,
          lockOnSleep: false,
        }),
        harness,
      ),
    ).resolves.toEqual({
      idle_timeout_seconds: null,
      lock_on_daemon_exit: true,
      lock_on_explicit_logout: true,
      lock_on_sleep: false,
    });

    expect(harness.client.setPolicy).toHaveBeenCalledWith({
      idleTimeoutSeconds: null,
      lockOnDaemonExit: true,
      lockOnExplicitLogout: true,
      lockOnSleep: false,
    });
  });

  it('renders and updates vault policy in human mode', async () => {
    const harness = deps();

    await expect(__testing.runVaultPolicy(context({}, false), harness)).resolves.toEqual({
      idle_timeout_seconds: 28_800,
      lock_on_daemon_exit: true,
      lock_on_explicit_logout: true,
      lock_on_sleep: true,
    });
    await expect(__testing.runVaultPolicySet(context({ idleTimeoutSeconds: 60 }, false), harness)).resolves.toEqual({
      idle_timeout_seconds: 60,
      lock_on_daemon_exit: true,
      lock_on_explicit_logout: true,
      lock_on_sleep: true,
    });

    expect(harness.write).toHaveBeenCalledWith(
      'Idle timeout: 28800s\nLock on daemon exit: yes\nLock on logout: yes\nLock on sleep: yes\n',
    );
    expect(harness.write).toHaveBeenCalledWith(
      'Idle timeout: 60s\nLock on daemon exit: yes\nLock on logout: yes\nLock on sleep: yes\n',
    );
  });

  it('locks and resets the vault in human mode', async () => {
    const harness = deps();

    await expect(__testing.runVaultLock(context({}, false), harness)).resolves.toEqual({ locked: true });
    await expect(__testing.runVaultReset(context({ force: true }, false), harness)).resolves.toEqual({ reset: true });

    expect(harness.client.lock).toHaveBeenCalledOnce();
    expect(harness.client.reset).toHaveBeenCalledOnce();
    expect(harness.write).toHaveBeenCalledWith('Vault locked.\n');
    expect(harness.write).toHaveBeenCalledWith('Vault reset complete.\n');
  });

  it('requires force before resetting the vault', async () => {
    const harness = deps();

    await expect(__testing.runVaultReset(context({ force: false }), harness)).rejects.toMatchObject({
      code: 'VAULT_RESET_REQUIRES_FORCE',
    });
    expect(harness.client.reset).not.toHaveBeenCalled();
  });

  it('changes passphrase after confirming the human prompt', async () => {
    const harness = deps({
      readPassphrase: vi
        .fn()
        .mockResolvedValueOnce(Buffer.from('current1'))
        .mockResolvedValueOnce(Buffer.from('next123'))
        .mockResolvedValueOnce(Buffer.from('next123')),
    });

    await expect(__testing.runVaultChangePassphrase(context({}, false), harness)).resolves.toEqual({ changed: true });
    expect(harness.client.changePassphrase).toHaveBeenCalledWith(
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
      Buffer.from([0, 0, 0, 0, 0, 0, 0]),
    );
  });

  it('rejects mismatched human passphrase confirmation', async () => {
    const harness = deps({
      readPassphrase: vi
        .fn()
        .mockResolvedValueOnce(Buffer.from('current1'))
        .mockResolvedValueOnce(Buffer.from('next123'))
        .mockResolvedValueOnce(Buffer.from('different')),
    });

    await expect(__testing.runVaultChangePassphrase(context({}, false), harness)).rejects.toMatchObject({
      code: 'VAULT_PASSPHRASE_MISMATCH',
    });
    expect(harness.client.changePassphrase).not.toHaveBeenCalled();
  });

  it('maps secure storage errors through the command context', async () => {
    const harness = deps();
    harness.client.status.mockRejectedValue(
      new SecureStorageError('secure_storage_secret_missing', 'The InFlow vault is locked.'),
    );

    await expect(__testing.runVaultStatus(context(), harness)).rejects.toMatchObject({
      code: 'secure_storage_secret_missing',
    });
  });

  it('registers the visible vault command surface', () => {
    expect(createVaultCli()).toBeDefined();
  });
});
