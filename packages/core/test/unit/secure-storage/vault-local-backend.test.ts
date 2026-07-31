import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecureSqliteRepository } from '../../../src/secure-storage/sqlite.js';
import { LocalVaultBackend } from '../../../src/secure-storage/vault-local-backend.js';
import { vaultFilePaths } from '../../../src/secure-storage/vault-files.js';
import { parseVaultSecretReference } from '../../../src/secure-storage/vault-types.js';

describe('LocalVaultBackend', () => {
  let tmpDir: string;
  let repository: SecureSqliteRepository;
  let backend: LocalVaultBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-local-vault-'));
    repository = new SecureSqliteRepository({ rootDir: tmpDir });
    backend = new LocalVaultBackend({
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      paths: vaultFilePaths(tmpDir),
      repository,
      sidecarPath: join(tmpDir, 'inflow.vault'),
    });
  });

  afterEach(() => {
    repository.close();
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it('creates the vault on first unlock and round-trips encrypted secrets by exact kind', async () => {
    await expect(backend.status()).resolves.toEqual({ daemonRunning: false, lockState: 'not_initialized' });
    await expect(backend.unlock(Buffer.from('123456'))).resolves.toEqual({
      daemonRunning: false,
      lockState: 'unlocked',
    });

    const reference = backend.putSecret({
      expectedKind: 'inflow_api_key',
      payload: Buffer.from('secret-api-key'),
    });

    expect(parseVaultSecretReference(reference.reference)).toEqual(reference);
    expect(backend.exists({ expectedKind: 'inflow_api_key', reference })).toBe(true);
    expect(backend.exists({ expectedKind: 'auth_access_token', reference })).toBe(false);
    expect(backend.getSecret({ expectedKind: 'inflow_api_key', reference })).toMatchObject({
      payload: Buffer.from('secret-api-key'),
      reference,
    });
    expect(() => backend.getSecret({ expectedKind: 'auth_access_token', reference })).toThrow(
      'A referenced vault secret is missing.',
    );
    try {
      backend.getSecret({ expectedKind: 'auth_access_token', reference });
    } catch (cause) {
      expect(cause).toMatchObject({
        secureStorageCode: 'secure_storage_secret_missing',
      });
    }
  });

  it('stores a secret at an exact caller-provided vault reference', async () => {
    await backend.unlock(Buffer.from('123456'));
    const reference = parseVaultSecretReference('vlt_11111111111111111111111111111111');

    expect(
      backend.putSecret({
        expectedKind: 'inflow_api_key',
        payload: Buffer.from('secret-api-key'),
        reference,
      }),
    ).toEqual(reference);
    expect(backend.getSecret({ expectedKind: 'inflow_api_key', reference })).toMatchObject({
      payload: Buffer.from('secret-api-key'),
    });
  });

  it('refuses to overwrite an existing caller-provided vault reference', async () => {
    await backend.unlock(Buffer.from('123456'));
    const reference = parseVaultSecretReference('vlt_11111111111111111111111111111111');
    backend.putSecret({
      expectedKind: 'inflow_api_key',
      payload: Buffer.from('original'),
      reference,
    });

    expect(() =>
      backend.putSecret({
        expectedKind: 'inflow_api_key',
        payload: Buffer.from('replacement'),
        reference,
      }),
    ).toThrow('The vault secret reference already exists.');
    expect(backend.getSecret({ expectedKind: 'inflow_api_key', reference }).payload).toEqual(Buffer.from('original'));
  });

  it('rejects locked reads with the stable storage code', async () => {
    await backend.unlock(Buffer.from('123456'));
    const reference = backend.putSecret({
      expectedKind: 'auth_refresh_token',
      payload: Buffer.from('refresh-token'),
    });
    backend.lock();

    try {
      backend.getSecret({ expectedKind: 'auth_refresh_token', reference });
    } catch (cause) {
      expect(cause).toMatchObject({
        secureStorageCode: 'vault_locked',
      });
      return;
    }
    throw new Error('expected locked vault read to fail');
  });

  it('locks, unlocks with the existing sidecar, and rejects the old passphrase after rotation', async () => {
    await backend.unlock(Buffer.from('123456'));
    const reference = backend.putSecret({
      expectedKind: 'auth_refresh_token',
      payload: Buffer.from('refresh-token'),
    });
    backend.lock();
    expect(() => backend.getSecret({ expectedKind: 'auth_refresh_token', reference })).toThrow(
      'The InFlow vault is locked.',
    );

    await backend.unlock(Buffer.from('123456'));
    expect(backend.getSecret({ expectedKind: 'auth_refresh_token', reference })).toMatchObject({
      payload: Buffer.from('refresh-token'),
    });

    const before = await readFile(join(tmpDir, 'inflow.vault'));
    await backend.changePassphrase(Buffer.from('123456'), Buffer.from('654321'));
    const after = await readFile(join(tmpDir, 'inflow.vault'));

    expect(after).not.toEqual(before);
    backend.lock();
    await expect(backend.unlock(Buffer.from('123456'))).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_corrupt',
    });
    await expect(backend.unlock(Buffer.from('654321'))).resolves.toMatchObject({ lockState: 'unlocked' });
  }, 15_000);

  it('fails closed when encrypted record metadata is changed', async () => {
    await backend.unlock(Buffer.from('123456'));
    const reference = backend.putSecret({
      expectedKind: 'aep_credential',
      payload: Buffer.from('credential'),
    });

    repository.markVaultRecordStatus(reference.reference, 'deleting', '2026-01-01T00:01:00.000Z');
    try {
      backend.getSecret({ expectedKind: 'aep_credential', reference });
    } catch (cause) {
      expect(cause).toMatchObject({
        secureStorageCode: 'secure_storage_secret_missing',
      });
      return;
    }
    throw new Error('expected metadata tamper to fail');
  });

  it('fails closed when ciphertext, tag, or encryption version is changed', async () => {
    await backend.unlock(Buffer.from('123456'));
    const reference = backend.putSecret({
      expectedKind: 'pending_device_code',
      payload: Buffer.from('device-code'),
    });
    const record = repository.getVaultRecord(reference.reference, 'pending_device_code');
    expect(record).toBeDefined();
    if (record === undefined) throw new Error('expected stored vault record');

    repository.deleteVaultRecord(record.reference);
    repository.putVaultRecord({
      ...record,
      ciphertext: Buffer.from('changed'),
    });
    expect(() => backend.getSecret({ expectedKind: 'pending_device_code', reference })).toThrow(
      'Vault record could not be decrypted.',
    );

    repository.deleteVaultRecord(record.reference);
    repository.putVaultRecord({
      ...record,
      tag: Buffer.from('changed-tag-0000'),
    });
    expect(() => backend.getSecret({ expectedKind: 'pending_device_code', reference })).toThrow(
      'Vault record could not be decrypted.',
    );

    repository.deleteVaultRecord(record.reference);
    repository.putVaultRecord({
      ...record,
      encryptionVersion: 2,
    });
    expect(() => backend.getSecret({ expectedKind: 'pending_device_code', reference })).toThrow(
      'Vault record could not be decrypted.',
    );
  });

  it('deletes, expires, touches, and stores policy without exposing payload listing', async () => {
    await backend.unlock(Buffer.from('123456'));
    const active = backend.putSecret({
      expectedKind: 'auth_access_token',
      payload: Buffer.from('access-token'),
    });
    const expired = backend.putSecret({
      expectedKind: 'auth_access_token',
      expiresAt: '2000-01-01T00:00:00.000Z',
      payload: Buffer.from('expired-token'),
    });

    expect(backend.exists({ expectedKind: 'auth_access_token', reference: expired })).toBe(false);
    backend.touch({ expectedKind: 'auth_access_token', reference: active });
    backend.deleteExpired({ now: '2026-01-01T00:00:00.000Z' });
    expect(backend.exists({ expectedKind: 'auth_access_token', reference: expired })).toBe(false);
    backend.deleteSecret({ expectedKind: 'auth_access_token', reference: active });
    expect(backend.exists({ expectedKind: 'auth_access_token', reference: active })).toBe(false);

    expect(backend.getPolicy()).toMatchObject({ idleTimeoutSeconds: 28_800 });
    expect(
      backend.setPolicy({
        idleTimeoutSeconds: null,
        lockOnSleep: false,
      }),
    ).toMatchObject({ idleTimeoutSeconds: null, lockOnSleep: false });
  });

  it('resets the local vault database, sidecar, and runtime artifacts', async () => {
    const paths = vaultFilePaths(tmpDir);
    await backend.unlock(Buffer.from('123456'));
    backend.putSecret({
      expectedKind: 'inflow_api_key',
      payload: Buffer.from('api-key'),
    });
    mkdirSync(paths.runDirectory);
    writeFileSync(paths.writeAheadLog, '');
    writeFileSync(paths.sharedMemory, '');
    writeFileSync(paths.socket, '');

    await backend.reset();

    expect(existsSync(paths.database)).toBe(false);
    expect(existsSync(paths.writeAheadLog)).toBe(false);
    expect(existsSync(paths.sharedMemory)).toBe(false);
    expect(existsSync(paths.sidecar)).toBe(false);
    expect(existsSync(paths.socket)).toBe(false);
    await expect(backend.status()).resolves.toEqual({ daemonRunning: false, lockState: 'not_initialized' });
  });

  it('rejects malformed policy settings and sidecars', async () => {
    repository.initialize();
    repository.upsertSetting('vault-policy', { idleTimeoutSeconds: -1 });
    expect(() => backend.getPolicy()).toThrow('The vault policy is malformed.');

    await writeFile(join(tmpDir, 'inflow.vault'), Buffer.from('bad'));
    await expect(backend.unlock(Buffer.from('123456'))).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_corrupt',
    });
  });

  it('returns a stable unlock salt and rejects a changed salt for wrapping-key authentication', async () => {
    const firstSalt = await backend.unlockSalt();
    expect(firstSalt).toHaveLength(16);
    const wrappingKey = Buffer.alloc(32, 7);
    await expect(backend.unlockWithWrappingKey(wrappingKey, firstSalt)).resolves.toMatchObject({
      lockState: 'unlocked',
    });
    backend.lock();

    expect(await backend.unlockSalt()).toEqual(firstSalt);
    const changedSalt = Buffer.from(firstSalt);
    changedSalt[0] = (changedSalt[0] ?? 0) ^ 1;
    await expect(backend.unlockWithWrappingKey(wrappingKey, changedSalt)).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_corrupt',
      message: 'Vault unlock salt changed.',
    });
  });

  it('rotates wrapping keys without changing stored secret material', async () => {
    const originalSalt = await backend.unlockSalt();
    const originalWrappingKey = Buffer.alloc(32, 7);
    await backend.unlockWithWrappingKey(originalWrappingKey, originalSalt);
    const reference = backend.putSecret({
      expectedKind: 'auth_refresh_token',
      payload: Buffer.from('refresh-token'),
    });
    const nextSalt = Buffer.alloc(originalSalt.byteLength, 9);
    const nextWrappingKey = Buffer.alloc(32, 8);

    await backend.changeWrappingKey(originalWrappingKey, nextWrappingKey, nextSalt);
    backend.lock();

    await expect(backend.unlockWithWrappingKey(originalWrappingKey, originalSalt)).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_corrupt',
    });
    await expect(backend.unlockWithWrappingKey(nextWrappingKey, nextSalt)).resolves.toMatchObject({
      lockState: 'unlocked',
    });
    expect(backend.getSecret({ expectedKind: 'auth_refresh_token', reference }).payload).toEqual(
      Buffer.from('refresh-token'),
    );
  });

  it('rejects non-object, array, and incorrectly typed policy settings', () => {
    repository.initialize();
    for (const policy of [
      null,
      [],
      { idleTimeoutSeconds: 1.5, lockOnSleep: true },
      { idleTimeoutSeconds: 1, lockOnSleep: 'yes' },
    ]) {
      repository.upsertSetting('vault-policy', policy);
      expect(() => backend.getPolicy()).toThrow('The vault policy is malformed.');
    }
  });
});
