import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { __testing, createVaultCli } from '../../../../src/commands/vault/index.js';
import { SecureStorageError, type VaultPolicy, type VaultStatus } from '@inflowpayai/inflow-core';

type ErrorShape = { code: string; message: string };
type VaultTestClient = {
  changePassphrase: ReturnType<typeof vi.fn>;
  getPolicy: ReturnType<typeof vi.fn>;
  lock: ReturnType<typeof vi.fn>;
  setPolicy: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  unlock: ReturnType<typeof vi.fn>;
};
type VaultTestDeps = {
  client: VaultTestClient;
  ensureDaemon: ReturnType<typeof vi.fn>;
  readPassphrase: ReturnType<typeof vi.fn>;
  readVaultStatus: ReturnType<typeof vi.fn>;
  resetVault: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
};
type ResetVaultTestDeps = {
  client: {
    info: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
  };
  executablePath: string;
  now: ReturnType<typeof vi.fn>;
  removeLocalState: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
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
        lockOnSleep: true,
      } satisfies VaultPolicy),
    ),
    lock: vi.fn(() => Promise.resolve()),
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
    readVaultStatus: vi.fn(() => client.status()),
    resetVault: vi.fn(() => Promise.resolve()),
    write: vi.fn(),
    ...overrides,
  };
}

function resetDeps(overrides: Partial<ResetVaultTestDeps> = {}): ResetVaultTestDeps {
  const executablePath = '/Applications/InFlow.app/Contents/MacOS/inflow';
  const client = {
    info: vi.fn(() =>
      Promise.resolve({
        buildId: 'build-1',
        cliVersion: '0.9.0',
        executablePath,
        pid: 123,
      }),
    ),
    reset: vi.fn(() => Promise.resolve()),
    shutdown: vi.fn(() => Promise.resolve()),
    status: vi.fn(() =>
      Promise.resolve({
        daemonRunning: true,
        lockState: 'unlocked',
      } satisfies VaultStatus),
    ),
  };
  return {
    client,
    executablePath,
    now: vi.fn(() => 0),
    removeLocalState: vi.fn(() => Promise.resolve()),
    sleep: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe('vault command runners', () => {
  it('reports vault status in agent shape', async () => {
    const harness = deps();

    await expect(__testing.runVaultStatus(context(), harness)).resolves.toEqual({
      lock_state: 'locked',
    });
    expect(harness.ensureDaemon).not.toHaveBeenCalled();
  });

  it('renders status in human mode', async () => {
    const harness = deps();

    await expect(__testing.runVaultStatus(context({}, false), harness)).resolves.toEqual({
      lock_state: 'locked',
    });

    expect(harness.ensureDaemon).not.toHaveBeenCalled();
    expect(harness.write).toHaveBeenCalledWith('Vault status: locked\n');
  });

  it('reads local status without starting a daemon', async (testContext) => {
    await expect(
      __testing.readVaultStatusWithoutStarting({ rootDirectory: testContext.task.name }),
    ).resolves.toMatchObject({
      daemonRunning: false,
      lockState: 'not_initialized',
    });
  });

  it('treats an overlong socket path as an unavailable daemon for status reads', async () => {
    const rootDirectory = join(tmpdir(), `inflow-${'x'.repeat(120)}`);

    await expect(__testing.readVaultStatusWithoutStarting({ rootDirectory })).resolves.toMatchObject({
      daemonRunning: false,
      lockState: 'not_initialized',
    });
  });

  it('reports locked from local sidecar state when no daemon is reachable', async (testContext) => {
    const rootDirectory = join(tmpdir(), testContext.task.id.replaceAll(/[^a-z0-9_-]/giu, '_'));
    await mkdir(rootDirectory, { recursive: true });
    await writeFile(join(rootDirectory, 'inflow.vault'), Buffer.from('vault sidecar'));

    await expect(__testing.readVaultStatusWithoutStarting({ rootDirectory })).resolves.toMatchObject({
      daemonRunning: false,
      lockState: 'locked',
    });
  });

  it('reports unlocked status for agent unlock when the vault is already unlocked', async () => {
    const harness = deps();
    harness.client.status.mockResolvedValueOnce({ daemonRunning: true, lockState: 'unlocked' });

    await expect(__testing.runVaultUnlock(context(), harness)).resolves.toEqual({
      lock_state: 'unlocked',
    });
    expect(harness.ensureDaemon).not.toHaveBeenCalled();
    expect(harness.readPassphrase).not.toHaveBeenCalled();
    expect(harness.client.unlock).not.toHaveBeenCalled();
  });

  it('rejects agent unlock without reading a passphrase when the vault is locked', async () => {
    const harness = deps();

    await expect(__testing.runVaultUnlock(context(), harness)).rejects.toMatchObject({
      code: 'VAULT_UNLOCK_REQUIRES_HUMAN',
    });
    expect(harness.ensureDaemon).not.toHaveBeenCalled();
    expect(harness.readVaultStatus).toHaveBeenCalled();
    expect(harness.readPassphrase).not.toHaveBeenCalled();
    expect(harness.client.unlock).not.toHaveBeenCalled();
  });

  it('unlocks and initializes with the first-run prompt', async () => {
    const harness = deps({
      readVaultStatus: vi.fn(() => Promise.resolve({ daemonRunning: true, lockState: 'unlocked' })),
    });
    harness.client.status.mockResolvedValueOnce({ daemonRunning: true, lockState: 'not_initialized' });

    await expect(__testing.runVaultUnlock(context({}, false), harness)).resolves.toEqual({
      lock_state: 'unlocked',
    });

    expect(harness.readPassphrase).toHaveBeenCalledWith(
      'Create an InFlow vault PIN or passphrase: ',
      expect.anything(),
    );
    expect(harness.client.unlock).toHaveBeenCalledWith(Buffer.from([0, 0, 0, 0, 0, 0]));
  });

  it('unlocks an existing vault with the returning prompt and human message', async () => {
    const harness = deps({
      readVaultStatus: vi.fn(() => Promise.resolve({ daemonRunning: true, lockState: 'unlocked' })),
    });

    await expect(__testing.runVaultUnlock(context({}, false), harness)).resolves.toEqual({
      lock_state: 'unlocked',
    });

    expect(harness.readPassphrase).toHaveBeenCalledWith(
      'Enter the InFlow vault PIN or passphrase: ',
      expect.anything(),
    );
    expect(harness.write).toHaveBeenCalledWith('Vault unlocked.\n');
  });

  it('does not prompt when a human unlocks an already-unlocked vault', async () => {
    const harness = deps();
    harness.client.status.mockResolvedValueOnce({ daemonRunning: true, lockState: 'unlocked' });

    await expect(__testing.runVaultUnlock(context({}, false), harness)).resolves.toEqual({
      lock_state: 'unlocked',
    });

    expect(harness.readPassphrase).not.toHaveBeenCalled();
    expect(harness.client.unlock).not.toHaveBeenCalled();
    expect(harness.write).toHaveBeenCalledWith('Vault already unlocked.\n');
  });

  it('reports an authentication failure for a rejected passphrase', async () => {
    const harness = deps();
    harness.client.unlock.mockRejectedValue(
      new SecureStorageError('secure_storage_corrupt', 'Vault material could not be unwrapped.'),
    );

    await expect(__testing.runVaultUnlock(context({}, false), harness)).rejects.toMatchObject({
      code: 'VAULT_UNLOCK_FAILED',
      message: 'The vault could not be unlocked. Check the PIN or passphrase and try again.',
    });

    expect(harness.write).not.toHaveBeenCalled();
  });

  it('does not print success when an independent status check remains locked', async () => {
    const harness = deps();

    await expect(__testing.runVaultUnlock(context({}, false), harness)).rejects.toMatchObject({
      code: 'VAULT_UNLOCK_FAILED',
      message: 'The vault could not be unlocked. Check the PIN or passphrase and try again.',
    });

    expect(harness.write).not.toHaveBeenCalled();
  });

  it('rejects short unlock passphrases before calling the daemon', async () => {
    const harness = deps({
      readPassphrase: vi.fn(() => Promise.resolve(Buffer.from('123'))),
    });

    await expect(__testing.runVaultUnlock(context({}, false), harness)).rejects.toMatchObject({
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
      lock_on_sleep: false,
    });

    expect(harness.client.setPolicy).toHaveBeenCalledWith({
      idleTimeoutSeconds: null,
      lockOnSleep: false,
    });
  });

  it('preserves policy fields when no recognized options are supplied', async () => {
    const harness = deps();

    await expect(__testing.runVaultPolicySet(context({ ignored: true }), harness)).resolves.toEqual({
      idle_timeout_seconds: 28_800,
      lock_on_sleep: true,
    });
    expect(__testing.parsePolicySetOptions({ idleTimeoutSeconds: '60', lockOnSleep: 'yes' })).toEqual({
      idleTimeoutSeconds: undefined,
      lockOnSleep: undefined,
    });
    expect(harness.client.setPolicy).toHaveBeenCalledWith({
      idleTimeoutSeconds: 28_800,
      lockOnSleep: true,
    });
  });

  it('renders a disabled policy', () => {
    expect(__testing.renderPolicy({ idle_timeout_seconds: null, lock_on_sleep: false })).toBe(
      'Idle timeout: disabled\nLock on sleep: no\n',
    );
  });

  it('renders and updates vault policy in human mode', async () => {
    const harness = deps();

    await expect(__testing.runVaultPolicy(context({}, false), harness)).resolves.toEqual({
      idle_timeout_seconds: 28_800,
      lock_on_sleep: true,
    });
    await expect(__testing.runVaultPolicySet(context({ idleTimeoutSeconds: 60 }, false), harness)).resolves.toEqual({
      idle_timeout_seconds: 60,
      lock_on_sleep: true,
    });

    expect(harness.write).toHaveBeenCalledWith('Idle timeout: 28800s\nLock on sleep: yes\n');
    expect(harness.write).toHaveBeenCalledWith('Idle timeout: 60s\nLock on sleep: yes\n');
  });

  it('locks and resets the vault in human mode', async () => {
    const harness = deps();

    await expect(__testing.runVaultLock(context({}, false), harness)).resolves.toEqual({ locked: true });
    await expect(__testing.runVaultReset(context({ force: true }, false), harness)).resolves.toEqual({ reset: true });

    expect(harness.client.lock).toHaveBeenCalledOnce();
    expect(harness.resetVault).toHaveBeenCalledOnce();
    expect(harness.ensureDaemon).toHaveBeenCalledOnce();
    expect(harness.write).toHaveBeenCalledWith('Vault locked.\n');
    expect(harness.write).toHaveBeenCalledWith('Vault reset complete.\n');
  });

  it('matches version and build after daemon authentication', () => {
    expect(
      __testing.isCompatibleDaemon(
        {
          buildId: 'build-1',
          cliVersion: '0.9.0',
          executablePath: '/Applications/InFlow.app/Contents/MacOS/inflow',
          pid: 123,
        },
        { buildId: 'build-1', cliVersion: '0.9.0' },
      ),
    ).toBe(true);
    expect(
      __testing.isCompatibleDaemon(
        {
          buildId: 'build-2',
          cliVersion: '0.9.0',
          executablePath: '/Applications/InFlow.app/Contents/MacOS/inflow',
          pid: 123,
        },
        { buildId: 'build-1', cliVersion: '0.9.0' },
      ),
    ).toBe(false);
    expect(
      __testing.isCompatibleDaemon(
        {
          buildId: 'build-1',
          cliVersion: '0.9.1',
          executablePath: '/Applications/InFlow.app/Contents/MacOS/inflow',
          pid: 123,
        },
        { buildId: 'build-1', cliVersion: '0.9.0' },
      ),
    ).toBe(false);
    expect(
      __testing.isCompatibleDaemon(
        {
          buildId: 'build-1',
          cliVersion: '0.9.0',
          executablePath: '/tmp/inflow',
          pid: 123,
        },
        { buildId: 'build-1', cliVersion: '0.9.0' },
      ),
    ).toBe(true);
  });

  it('resets through a compatible daemon without deleting underneath it', async () => {
    const harness = resetDeps();

    await expect(
      __testing.resetLocalVaultWithDeps({ buildId: 'build-1', cliVersion: '0.9.0' }, harness),
    ).resolves.toBeUndefined();

    expect(harness.client.reset).toHaveBeenCalledOnce();
    expect(harness.client.shutdown).not.toHaveBeenCalled();
    expect(harness.removeLocalState).not.toHaveBeenCalled();
  });

  it('removes local vault files directly when no daemon is reachable', async () => {
    const harness = resetDeps();
    harness.client.status.mockRejectedValueOnce(
      new SecureStorageError('secure_storage_unavailable', 'The InFlow vault daemon is unavailable.'),
    );

    await expect(
      __testing.resetLocalVaultWithDeps({ rootDirectory: '/tmp/inflow-vault-test' }, harness),
    ).resolves.toBeUndefined();

    expect(harness.client.reset).not.toHaveBeenCalled();
    expect(harness.client.shutdown).not.toHaveBeenCalled();
    expect(harness.removeLocalState).toHaveBeenCalledWith(
      expect.objectContaining({
        database: '/tmp/inflow-vault-test/inflow.sqlite3',
      }),
    );
  });

  it('treats a missing daemon socket as direct cleanup', async () => {
    const harness = resetDeps();
    harness.client.status.mockRejectedValueOnce(
      Object.assign(new Error('connect ENOENT vault.sock'), { code: 'ENOENT' }),
    );

    await expect(
      __testing.resetLocalVaultWithDeps({ rootDirectory: '/tmp/inflow-vault-test' }, harness),
    ).resolves.toBeUndefined();

    expect(harness.client.reset).not.toHaveBeenCalled();
    expect(harness.client.shutdown).not.toHaveBeenCalled();
    expect(harness.removeLocalState).toHaveBeenCalledOnce();
  });

  it('stops a stale daemon before removing local vault files', async () => {
    const harness = resetDeps();
    harness.client.info.mockResolvedValueOnce({
      buildId: 'build-2',
      cliVersion: '0.9.0',
      executablePath: harness.executablePath,
      pid: 123,
    });
    harness.client.status
      .mockResolvedValueOnce({ daemonRunning: true, lockState: 'unlocked' })
      .mockRejectedValueOnce(
        new SecureStorageError('secure_storage_unavailable', 'The InFlow vault daemon is unavailable.'),
      );

    await expect(
      __testing.resetLocalVaultWithDeps({ buildId: 'build-1', cliVersion: '0.9.0' }, harness),
    ).resolves.toBeUndefined();

    expect(harness.client.reset).not.toHaveBeenCalled();
    expect(harness.client.shutdown).toHaveBeenCalledOnce();
    expect(harness.removeLocalState).toHaveBeenCalledOnce();
  });

  it('does not remove local vault files when a reachable daemon cannot shut down', async () => {
    const harness = resetDeps();
    harness.client.info.mockResolvedValueOnce({
      buildId: 'build-2',
      cliVersion: '0.9.0',
      executablePath: harness.executablePath,
      pid: 123,
    });
    harness.client.shutdown.mockRejectedValueOnce(
      new SecureStorageError('secure_storage_corrupt', 'The InFlow vault daemon returned invalid data.'),
    );

    await expect(
      __testing.resetLocalVaultWithDeps({ buildId: 'build-1', cliVersion: '0.9.0' }, harness),
    ).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_corrupt',
    });

    expect(harness.removeLocalState).not.toHaveBeenCalled();
  });

  it('does not remove local state when daemon discovery fails unexpectedly', async () => {
    const harness = resetDeps();
    harness.client.status.mockRejectedValueOnce(new Error('status failed'));

    await expect(__testing.resetLocalVaultWithDeps({}, harness)).rejects.toThrow('status failed');
    expect(harness.removeLocalState).not.toHaveBeenCalled();
  });

  it('continues cleanup when a stale daemon disappears during shutdown', async () => {
    const harness = resetDeps();
    harness.client.info.mockResolvedValueOnce({
      buildId: 'other',
      cliVersion: '0.9.0',
      executablePath: harness.executablePath,
      pid: 123,
    });
    harness.client.shutdown.mockRejectedValueOnce(
      new SecureStorageError('secure_storage_unavailable', 'The daemon stopped.'),
    );

    await expect(__testing.resetLocalVaultWithDeps({ buildId: 'build-1' }, harness)).resolves.toBeUndefined();
    expect(harness.removeLocalState).toHaveBeenCalledOnce();
  });

  it('fails closed when a stale daemon remains reachable past the deadline', async () => {
    const harness = resetDeps({
      now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(2_000),
    });
    harness.client.info.mockResolvedValueOnce({
      buildId: 'other',
      cliVersion: '0.9.0',
      executablePath: harness.executablePath,
      pid: 123,
    });

    await expect(__testing.resetLocalVaultWithDeps({ buildId: 'build-1' }, harness)).rejects.toMatchObject({
      secureStorageCode: 'vault_daemon_busy',
    });
    expect(harness.sleep).toHaveBeenCalledWith(25);
    expect(harness.removeLocalState).not.toHaveBeenCalled();
  });

  it('propagates unexpected status failures while waiting for shutdown', async () => {
    const harness = resetDeps();
    harness.client.status.mockRejectedValueOnce(new Error('status failed'));

    await expect(__testing.shutdownReachableDaemon(harness)).rejects.toThrow('status failed');
  });

  it('does not prompt when ensuring an unlocked vault', async () => {
    const harness = deps();
    harness.client.status.mockResolvedValueOnce({ daemonRunning: true, lockState: 'unlocked' });

    await expect(
      __testing.ensureLocalVaultUnlockedWithDeps('human', {
        ensureDaemon: harness.ensureDaemon,
        readPassphrase: harness.readPassphrase,
      }),
    ).resolves.toBeUndefined();

    expect(harness.readPassphrase).not.toHaveBeenCalled();
    expect(harness.client.unlock).not.toHaveBeenCalled();
  });

  it('tells agents to ask a human when the vault is unavailable for secrets', async () => {
    const harness = deps();
    harness.client.status.mockResolvedValueOnce({ daemonRunning: true, lockState: 'not_initialized' });

    await expect(
      __testing.ensureLocalVaultUnlockedWithDeps('agent', {
        ensureDaemon: harness.ensureDaemon,
        readPassphrase: harness.readPassphrase,
      }),
    ).rejects.toMatchObject({
      secureStorageCode: 'vault_not_initialized',
      message: 'The InFlow vault is not initialized. A human must run `inflow vault unlock` first.',
    });

    harness.client.status.mockResolvedValueOnce({ daemonRunning: true, lockState: 'locked' });
    await expect(
      __testing.ensureLocalVaultUnlockedWithDeps('agent', {
        ensureDaemon: harness.ensureDaemon,
        readPassphrase: harness.readPassphrase,
      }),
    ).rejects.toMatchObject({
      secureStorageCode: 'vault_locked',
      message: 'The InFlow vault is locked. A human must run `inflow vault unlock` first.',
    });
  });

  it('prompts humans and unlocks before secret-backed commands continue', async () => {
    const harness = deps();
    harness.client.status.mockResolvedValueOnce({ daemonRunning: true, lockState: 'locked' });

    await expect(
      __testing.ensureLocalVaultUnlockedWithDeps('human', {
        ensureDaemon: harness.ensureDaemon,
        readPassphrase: harness.readPassphrase,
      }),
    ).resolves.toBeUndefined();

    expect(harness.readPassphrase).toHaveBeenCalledWith(
      'Enter the InFlow vault PIN or passphrase: ',
      expect.anything(),
    );
    expect(harness.client.unlock).toHaveBeenCalledWith(Buffer.from([0, 0, 0, 0, 0, 0]));
  });

  it('requires force before resetting the vault', async () => {
    const harness = deps();

    await expect(__testing.runVaultReset(context({ force: false }), harness)).rejects.toMatchObject({
      code: 'VAULT_RESET_REQUIRES_FORCE',
    });
    expect(harness.resetVault).not.toHaveBeenCalled();
  });

  it('rejects agent passphrase changes without reading passphrases', async () => {
    const harness = deps();

    await expect(__testing.runVaultChangePassphrase(context(), harness)).rejects.toMatchObject({
      code: 'VAULT_CHANGE_PASSPHRASE_REQUIRES_HUMAN',
    });
    expect(harness.ensureDaemon).not.toHaveBeenCalled();
    expect(harness.readPassphrase).not.toHaveBeenCalled();
    expect(harness.client.changePassphrase).not.toHaveBeenCalled();
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

  it('rejects a short replacement passphrase and clears it', async () => {
    const current = Buffer.from('current1');
    const next = Buffer.from('123');
    const harness = deps({
      readPassphrase: vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(next),
    });

    await expect(__testing.runVaultChangePassphrase(context({}, false), harness)).rejects.toMatchObject({
      code: 'VAULT_PASSPHRASE_TOO_SHORT',
    });
    expect(current).toEqual(Buffer.alloc(8));
    expect(next).toEqual(Buffer.alloc(3));
    expect(harness.client.changePassphrase).not.toHaveBeenCalled();
  });

  it('clears passphrases when changing the daemon credential fails', async () => {
    const current = Buffer.from('current1');
    const next = Buffer.from('next123');
    const harness = deps({
      readPassphrase: vi
        .fn()
        .mockResolvedValueOnce(current)
        .mockResolvedValueOnce(next)
        .mockResolvedValueOnce(Buffer.from('next123')),
    });
    harness.client.changePassphrase.mockRejectedValueOnce(
      new SecureStorageError('secure_storage_unavailable', 'change failed'),
    );

    await expect(__testing.runVaultChangePassphrase(context({}, false), harness)).rejects.toMatchObject({
      code: 'secure_storage_unavailable',
    });
    expect(current).toEqual(Buffer.alloc(8));
    expect(next).toEqual(Buffer.alloc(7));
  });

  it('maps secure storage errors through the command context', async () => {
    const harness = deps();
    harness.readVaultStatus.mockRejectedValue(
      new SecureStorageError('secure_storage_secret_missing', 'The InFlow vault is locked.'),
    );

    await expect(__testing.runVaultStatus(context(), harness)).rejects.toMatchObject({
      code: 'secure_storage_secret_missing',
    });
  });

  it('propagates non-storage errors and maps non-corruption unlock errors', async () => {
    const c = context();
    await expect(__testing.mapSecureStorageError(c, () => Promise.reject(new Error('unexpected')))).rejects.toThrow(
      'unexpected',
    );
    await expect(
      __testing.mapVaultUnlockError(c, () =>
        Promise.reject(new SecureStorageError('secure_storage_unavailable', 'unavailable')),
      ),
    ).rejects.toMatchObject({ code: 'secure_storage_unavailable' });
    await expect(__testing.mapVaultUnlockError(c, () => Promise.reject(new Error('unexpected')))).rejects.toThrow(
      'unexpected',
    );
  });

  it('classifies only daemon transport failures as unavailable', () => {
    expect(__testing.isVaultDaemonUnavailable({ code: 'ECONNREFUSED' })).toBe(true);
    expect(__testing.isVaultDaemonUnavailable({ code: 'EINVAL' })).toBe(true);
    expect(__testing.isVaultDaemonUnavailable({ code: 'EACCES' })).toBe(false);
    expect(__testing.isVaultDaemonUnavailable(new Error('other'))).toBe(false);
    expect(__testing.isVaultDaemonUnavailable(new SecureStorageError('secure_storage_corrupt', 'corrupt'))).toBe(false);
  });

  it('registers the visible vault command surface', () => {
    expect(createVaultCli()).toBeDefined();
  });

  it('dispatches vault status through the registered command', async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'inflow-vault-command-'));
    const output: string[] = [];
    try {
      await createVaultCli({ rootDirectory }).serve(['status', '--format', 'json'], {
        exit: vi.fn(),
        stdout(chunk) {
          output.push(chunk);
        },
      });
      expect(output.join('')).toContain('not_initialized');
    } finally {
      rmSync(rootDirectory, { force: true, recursive: true });
    }
  });

  it('propagates unexpected sidecar access failures during status discovery', async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'inflow-vault-sidecar-'));
    const sidecar = join(rootDirectory, 'inflow.vault');
    try {
      await symlink(sidecar, sidecar);
      await expect(__testing.readVaultStatusWithoutStarting({ rootDirectory })).rejects.toMatchObject({
        code: 'ELOOP',
      });
    } finally {
      rmSync(rootDirectory, { force: true, recursive: true });
    }
  });
});
