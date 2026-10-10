import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthTokens } from '../../../src/types/index.js';
import { MemoryStorage, Storage } from '../../../src/utils/storage.js';
import { AepStorage } from '../../../src/aep/storage.js';
import { SecureStorageError } from '../../../src/secure-storage/errors.js';
import { SyncMemorySecretStore, type SecretReference } from '../../../src/secure-storage/secret-store.js';
import { SecureSqliteRepository } from '../../../src/secure-storage/sqlite.js';

const sampleAuth: AuthTokens = {
  access_token: 'a',
  refresh_token: 'r',
  token_type: 'Bearer',
  expires_in: 3600,
};

class CountingSecretStore extends SyncMemorySecretStore {
  readonly deleted: SecretReference[] = [];
  readonly readReferences: SecretReference[] = [];

  override delete(reference: SecretReference): void {
    super.delete(reference);
    this.deleted.push(reference);
  }

  override read(reference: SecretReference): Uint8Array {
    this.readReferences.push(reference);
    return super.read(reference);
  }
}

class FaultInjectingSecretStore extends CountingSecretStore {
  failDeletes = false;
  failRefreshTokenCreates = false;

  override create(reference: SecretReference, value: Uint8Array): void {
    if (this.failRefreshTokenCreates && reference.purpose === 'auth-refresh-token') {
      throw new SecureStorageError('secure_storage_io_error', 'simulated refresh-token write failure');
    }
    super.create(reference, value);
  }

  override delete(reference: SecretReference): void {
    if (this.failDeletes) throw new SecureStorageError('secure_storage_io_error', 'simulated delete failure');
    super.delete(reference);
  }
}

describe('Storage (file-backed)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-core-storage-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function secureStorage(): Storage {
    return new Storage({ cwd: tmpDir, secretStore: new SyncMemorySecretStore() });
  }

  it('invalidates other storage readers and clears metadata without retrieving or deleting secrets', () => {
    const secrets = new FaultInjectingSecretStore();
    const first = new Storage({ cwd: tmpDir, secretStore: secrets });
    const second = new Storage({ cwd: tmpDir, secretStore: secrets });
    expect(second.getResetGeneration()).toBeUndefined();
    first.setApiKey('synthetic-key');
    first.setAuth(sampleAuth);
    first.setConnection({ environment: 'sandbox' });
    secrets.failDeletes = true;
    first.invalidateSessions();
    const invalidation = second.getResetGeneration();
    expect(invalidation).toEqual(expect.any(String));
    first.resetLocalState();
    expect(second.getResetGeneration()).not.toBe(invalidation);
    expect(second.getApiKey()).toBeNull();
    expect(second.getAuth()).toBeNull();
    expect(second.getConnection()).toBeNull();
    expect(secrets.readReferences).toEqual([]);
    expect(secrets.deleted).toEqual([]);
    const repository = new SecureSqliteRepository({ databasePath: join(tmpDir, 'inflow.sqlite3') });
    try {
      expect(repository.listSecretLifecycle('active')).toEqual([]);
      expect(repository.listSecretLifecycle('pending')).toEqual([]);
      expect(repository.listSecretLifecycle('deleting')).toEqual([]);
    } finally {
      repository.close();
    }
  });

  it('reads a replacement database instead of keeping a reset generation from an unlinked handle', () => {
    const first = secureStorage();
    const reader = secureStorage();
    first.invalidateSessions();
    const before = reader.getResetGeneration();
    rmSync(join(tmpDir, 'inflow.sqlite3'));
    rmSync(join(tmpDir, 'inflow.sqlite3-wal'), { force: true });
    rmSync(join(tmpDir, 'inflow.sqlite3-shm'), { force: true });
    const replacement = secureStorage();
    replacement.invalidateSessions();
    expect(reader.getResetGeneration()).not.toBe(before);
  });

  it('rejects malformed reset metadata', () => {
    const storage = secureStorage();
    storage.invalidateSessions();
    const repository = new SecureSqliteRepository({ databasePath: join(tmpDir, 'inflow.sqlite3') });
    try {
      repository.upsertSetting('vault.reset_generation', {});
      expect(() => storage.getResetGeneration()).toThrow('Invalid vault reset metadata');
    } finally {
      repository.close();
    }
  });

  it('reads session metadata without secrets and reads only the selected token', () => {
    const secrets = new CountingSecretStore();
    const storage = new Storage({ cwd: tmpDir, secretStore: secrets });
    expect(storage.getAuthSession()).toBeNull();
    const id = storage.setAuth(sampleAuth);
    expect(storage.getAuthSession()?.id).toBe(id);
    expect(secrets.readReferences).toEqual([]);
    expect(storage.getAuthToken(id, 'access')).toBe('a');
    expect(storage.getAuthToken(id, 'refresh')).toBe('r');
    expect(secrets.readReferences.map((reference) => reference.purpose)).toEqual([
      'auth-access-token',
      'auth-refresh-token',
    ]);
    storage.clearAuth();
    expect(() => storage.getAuthToken(id, 'access')).toThrow('session changed');
    expect(() => storage.setAuth(sampleAuth, id)).toThrow('session changed');
    expect(storage.getAuthSession()).toBeNull();
  });

  it('conditionally replaces a session and rejects stale writes from another storage instance', () => {
    const secrets = new CountingSecretStore();
    const first = new Storage({ cwd: tmpDir, secretStore: secrets });
    const second = new Storage({ cwd: tmpDir, secretStore: secrets });
    const id = first.setAuth(sampleAuth);
    const next = second.setAuth({ ...sampleAuth, access_token: 'next' }, id);
    expect(next).not.toBe(id);
    expect(() => first.setAuth({ ...sampleAuth, access_token: 'stale' }, id)).toThrow('session changed');
    expect(first.getAuthToken(next, 'access')).toBe('next');
    expect(() => first.getAuthToken(id, 'access')).toThrow('session changed');
  });

  it('rejects a session changed during secret retrieval', () => {
    const secrets = new CountingSecretStore();
    const storage = new Storage({ cwd: tmpDir, secretStore: secrets });
    const id = storage.setAuth(sampleAuth);
    const original = secrets.read.bind(secrets);
    vi.spyOn(secrets, 'read').mockImplementation((reference) => {
      const bytes = original(reference);
      storage.clearAuth();
      return bytes;
    });
    expect(() => storage.getAuthToken(id, 'access')).toThrow('session changed');
  });

  it('rejects logout during refresh secret creation before committing metadata', () => {
    const secrets = new CountingSecretStore();
    const first = new Storage({ cwd: tmpDir, secretStore: secrets });
    const second = new Storage({ cwd: tmpDir, secretStore: secrets });
    const id = first.setAuth(sampleAuth);
    second.getAuthSession();
    const create = secrets.create.bind(secrets);
    vi.spyOn(secrets, 'create').mockImplementation((reference, value) => {
      create(reference, value);
      if (reference.purpose === 'auth-refresh-token') second.clearAuth();
    });
    expect(() => first.setAuth({ ...sampleAuth, access_token: 'stale' }, id)).toThrow('session changed');
    expect(first.getAuthSession()).toBeNull();
    expect(secrets.deleted).toHaveLength(4);
  });

  it('writes the SQLite database with 0o600 permissions', () => {
    const s = secureStorage();
    s.setAuth(sampleAuth);
    const path = s.getPath();
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('round-trips auth via setAuth/getAuth with computed expires_at', () => {
    const s = secureStorage();
    const before = Date.now();
    s.setAuth(sampleAuth);
    const got = s.getAuth();
    expect(got).not.toBeNull();
    expect(got?.access_token).toBe('a');
    expect(got?.expires_at).toBeGreaterThanOrEqual(before + 3500 * 1000);
  });

  it('isAuthenticated reflects setAuth/clearAuth', () => {
    const s = secureStorage();
    expect(s.isAuthenticated()).toBe(false);
    s.setAuth(sampleAuth);
    expect(s.isAuthenticated()).toBe(true);
    s.clearAuth();
    expect(s.isAuthenticated()).toBe(false);
  });

  it('isAuthenticated checks stored auth metadata without reading secrets', () => {
    const secretStore = new CountingSecretStore();
    const s = new Storage({ cwd: tmpDir, secretStore });
    s.setAuth(sampleAuth);
    secretStore.readReferences.length = 0;

    expect(s.isAuthenticated()).toBe(true);
    expect(secretStore.readReferences).toEqual([]);
  });

  it('pendingDeviceAuth evicts at read time when expired', () => {
    const s = secureStorage();
    s.setPendingDeviceAuth({
      device_code: 'd',
      interval: 5,
      expires_at: Date.now() - 1000,
      verification_url: 'https://x/',
      phrase: 'P-1',
    });
    expect(s.getPendingDeviceAuth()).toBeNull();
  });

  it('pendingDeviceAuth returns value when unexpired', () => {
    const s = secureStorage();
    const value = {
      device_code: 'd',
      interval: 5,
      expires_at: Date.now() + 60_000,
      verification_url: 'https://x/',
      phrase: 'P-1',
    };
    s.setPendingDeviceAuth(value);
    expect(s.getPendingDeviceAuth()).toEqual(value);
    s.clearPendingDeviceAuth();
    expect(s.getPendingDeviceAuth()).toBeNull();
  });

  it('clearAll wipes auth, apiKey, pendingDeviceAuth, and connection', () => {
    const s = secureStorage();
    s.setAuth(sampleAuth);
    s.setApiKey('inflow_test_abc');
    s.setPendingDeviceAuth({
      device_code: 'd',
      interval: 5,
      expires_at: Date.now() + 60_000,
      verification_url: 'https://x/',
      phrase: 'P',
    });
    s.setConnection({ environment: 'sandbox', apiBaseUrl: 'https://dev/' });
    s.clearAll();
    expect(s.isAuthenticated()).toBe(false);
    expect(s.getAuth()).toBeNull();
    expect(s.getApiKey()).toBeNull();
    expect(s.getPendingDeviceAuth()).toBeNull();
    expect(s.getConnection()).toBeNull();
  });

  it('apiKey round-trips via setApiKey/getApiKey/clearApiKey', () => {
    const s = secureStorage();
    expect(s.getApiKey()).toBeNull();
    s.setApiKey('inflow_live_abc');
    expect(s.getApiKey()).toBe('inflow_live_abc');
    s.clearApiKey();
    expect(s.getApiKey()).toBeNull();
  });

  it.each([false, true])('clears the returned secret bytes after conversion (failure: %s)', (failConversion) => {
    const secrets = new SyncMemorySecretStore();
    const storage = new Storage({ cwd: tmpDir, secretStore: secrets });
    const key = 'synthetic-memory-key';
    storage.setApiKey(key);
    const backing = Buffer.concat([Buffer.from('left'), Buffer.from(key), Buffer.from('right')]);
    const bytes = backing.subarray(4, 4 + key.length);
    if (failConversion) {
      Object.defineProperty(bytes, 'buffer', {
        get() {
          throw new Error('conversion failed');
        },
      });
    }
    const read = vi.spyOn(secrets, 'read').mockReturnValueOnce(bytes);
    if (failConversion) expect(() => storage.getApiKey()).toThrow('conversion failed');
    else expect(storage.getApiKey()).toBe(key);
    expect([...bytes]).toEqual(Array<number>(key.length).fill(0));
    expect(backing.subarray(0, 4).toString()).toBe('left');
    expect(backing.subarray(4 + key.length).toString()).toBe('right');
    read.mockRestore();
    expect(storage.getApiKey()).toBe(key);
  });

  it.each([
    {
      expectedDeletes: 2,
      label: 'authentication',
      write: (storage: Storage) => storage.setAuth(sampleAuth),
    },
    {
      expectedDeletes: 1,
      label: 'API key',
      write: (storage: Storage) => storage.setApiKey('inflow_live_rollback'),
    },
    {
      expectedDeletes: 1,
      label: 'pending device authentication',
      write: (storage: Storage) =>
        storage.setPendingDeviceAuth({
          device_code: 'device-code',
          expires_at: Date.now() + 60_000,
          interval: 5,
          phrase: 'P-1',
          verification_url: 'https://example.test/verify',
        }),
    },
  ])('deletes newly created $label secrets when metadata persistence fails', ({ expectedDeletes, write }) => {
    const secretStore = new CountingSecretStore();
    const storage = new Storage({ cwd: tmpDir, secretStore });
    vi.spyOn(SecureSqliteRepository.prototype, 'upsertSetting').mockImplementation(() => {
      throw new Error('metadata write failed');
    });

    expect(() => write(storage)).toThrow('metadata write failed');
    expect(secretStore.deleted).toHaveLength(expectedDeletes);
  });

  it('keeps the previous auth session when replacement token creation fails partway through', () => {
    const secretStore = new FaultInjectingSecretStore();
    const storage = new Storage({ cwd: tmpDir, secretStore });
    storage.setAuth(sampleAuth);
    secretStore.failRefreshTokenCreates = true;

    expect(() =>
      storage.setAuth({
        access_token: 'replacement-access',
        expires_in: 7200,
        refresh_token: 'replacement-refresh',
        token_type: 'Bearer',
      }),
    ).toThrow('simulated refresh-token write failure');

    expect(storage.getAuth()).toMatchObject({ access_token: 'a', refresh_token: 'r' });
  });

  it('keeps existing secrets usable when replacement metadata cannot be committed', () => {
    const secretStore = new CountingSecretStore();
    const storage = new Storage({ cwd: tmpDir, secretStore });
    const pending = {
      device_code: 'old-device-code',
      expires_at: Date.now() + 60_000,
      interval: 5,
      phrase: 'OLD-1',
      verification_url: 'https://example.test/verify',
    };
    storage.setAuth(sampleAuth);
    storage.setApiKey('old-api-key');
    storage.setPendingDeviceAuth(pending);
    vi.spyOn(SecureSqliteRepository.prototype, 'upsertSetting').mockImplementation(() => {
      throw new Error('metadata write failed');
    });

    expect(() =>
      storage.setAuth({
        access_token: 'new-access',
        expires_in: 7200,
        refresh_token: 'new-refresh',
        token_type: 'Bearer',
      }),
    ).toThrow('metadata write failed');
    expect(() => storage.setApiKey('new-api-key')).toThrow('metadata write failed');
    expect(() => storage.setPendingDeviceAuth({ ...pending, device_code: 'new-device-code' })).toThrow(
      'metadata write failed',
    );

    expect(storage.getAuth()).toMatchObject({ access_token: 'a', refresh_token: 'r' });
    expect(storage.getApiKey()).toBe('old-api-key');
    expect(storage.getPendingDeviceAuth()).toEqual(pending);
  });

  it('commits replacement metadata even when obsolete-secret cleanup must be deferred', () => {
    const secretStore = new FaultInjectingSecretStore();
    const storage = new Storage({ cwd: tmpDir, secretStore });
    storage.setApiKey('old-api-key');
    secretStore.failDeletes = true;

    expect(() => storage.setApiKey('new-api-key')).not.toThrow();
    expect(storage.getApiKey()).toBe('new-api-key');
  });

  it('isAuthenticated is true with just an apiKey set (no device tokens)', () => {
    const s = secureStorage();
    expect(s.isAuthenticated()).toBe(false);
    s.setApiKey('inflow_live_abc');
    expect(s.isAuthenticated()).toBe(true);
    s.clearApiKey();
    expect(s.isAuthenticated()).toBe(false);
  });

  it('setApiKey rejects empty strings (defensive against accidental clears)', () => {
    const s = secureStorage();
    expect(() => s.setApiKey('')).toThrow();
  });

  it('connection round-trips via setConnection/getConnection/clearConnection', () => {
    const s = secureStorage();
    expect(s.getConnection()).toBeNull();
    s.setConnection({
      environment: 'sandbox',
      apiBaseUrl: 'https://dev.inflowpay.ai',
      authBaseUrl: 'https://auth-dev.inflowpay.ai',
    });
    expect(s.getConnection()).toEqual({
      environment: 'sandbox',
      apiBaseUrl: 'https://dev.inflowpay.ai',
      authBaseUrl: 'https://auth-dev.inflowpay.ai',
    });
    s.clearConnection();
    expect(s.getConnection()).toBeNull();
  });

  it('connection persists across new Storage instances pointing at the same file', () => {
    const secretStore = new SyncMemorySecretStore();
    const a = new Storage({ cwd: tmpDir, secretStore });
    a.setConnection({ environment: 'sandbox', apiBaseUrl: 'https://dev/' });
    const b = new Storage({ cwd: tmpDir, secretStore });
    expect(b.getConnection()).toEqual({
      environment: 'sandbox',
      apiBaseUrl: 'https://dev/',
    });
  });

  it('apiKey persists across new Storage instances pointing at the same file', () => {
    const secretStore = new SyncMemorySecretStore();
    const a = new Storage({ cwd: tmpDir, secretStore });
    a.setApiKey('inflow_live_persisted');
    const b = new Storage({ cwd: tmpDir, secretStore });
    expect(b.getApiKey()).toBe('inflow_live_persisted');
  });

  it('keeps auth and API key secret values out of the SQLite database bytes', () => {
    const s = secureStorage();
    s.setAuth({
      access_token: 'access-token-secret-value',
      expires_in: 3600,
      refresh_token: 'refresh-token-secret-value',
      scope: 'read',
      token_type: 'Bearer',
    });
    s.setApiKey('api-key-secret-value');

    const databaseBytes = readFileSync(s.getPath(), 'utf8');
    expect(databaseBytes).not.toContain('access-token-secret-value');
    expect(databaseBytes).not.toContain('refresh-token-secret-value');
    expect(databaseBytes).not.toContain('api-key-secret-value');
    expect(s.getAuth()).toMatchObject({
      access_token: 'access-token-secret-value',
      refresh_token: 'refresh-token-secret-value',
    });
    expect(s.getApiKey()).toBe('api-key-secret-value');
  });

  it('configPath override controls the SQLite location', () => {
    const explicit = join(tmpDir, 'creds.sqlite3');
    const s = new Storage({ configPath: explicit, secretStore: new SyncMemorySecretStore() });
    s.setAuth(sampleAuth);
    expect(s.getPath()).toBe(explicit);
  });

  it('configPath with the legacy JSON extension uses a sibling SQLite database', () => {
    const legacy = join(tmpDir, 'creds.json');
    const s = new Storage({ configPath: legacy, secretStore: new SyncMemorySecretStore() });
    s.setAuth(sampleAuth);
    expect(s.getPath()).toBe(join(tmpDir, 'creds.sqlite3'));
  });

  it('deletes an explicitly supplied legacy JSON config during initialization', () => {
    const legacy = join(tmpDir, 'creds.json');
    writeFileSync(legacy, '{"auth":{"access_token":"legacy-secret"}}');
    const s = new Storage({ configPath: legacy, secretStore: new SyncMemorySecretStore() });
    expect(existsSync(legacy)).toBe(true);
    s.getAuth();
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(tmpDir, 'creds.sqlite3'))).toBe(true);
  });

  it('deletes the cwd legacy config during initialization', () => {
    const legacy = join(tmpDir, 'config.json');
    writeFileSync(legacy, '{"apiKey":"legacy-secret"}');
    const s = secureStorage();
    s.getConnection();
    expect(existsSync(legacy)).toBe(false);
  });

  it('does not delete a legacy path directory', () => {
    const legacy = join(tmpDir, 'directory.json');
    mkdirSync(legacy);
    const s = new Storage({ configPath: legacy, secretStore: new SyncMemorySecretStore() });
    s.getAuth();
    expect(existsSync(legacy)).toBe(true);
  });

  it('configPath without an extension is honored exactly', () => {
    const explicit = join(tmpDir, 'creds');
    const s = new Storage({ configPath: explicit, secretStore: new SyncMemorySecretStore() });
    s.setAuth(sampleAuth);
    expect(s.getPath()).toBe(explicit);
  });

  it('deleteConfig clears secure records, deletes legacy config, and leaves the database in place for reuse', async () => {
    const s = secureStorage();
    s.setAuth(sampleAuth);
    s.setApiKey('inflow_live_delete');
    const legacy = join(tmpDir, 'config.json');
    writeFileSync(legacy, '{"apiKey":"legacy-secret"}');
    const path = s.getPath();
    await s.deleteConfig();
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(s.getAuth()).toBeNull();
    expect(s.getApiKey()).toBeNull();
    await expect(s.deleteConfig()).resolves.toBeUndefined();
  });

  it('stores AEP credential payloads as vault secrets and reconstructs state', () => {
    const s = secureStorage();
    s.setAepState({
      credentials: {
        'did:web:service.example': {
          credential_1: {
            credential: { credential_id: 'credential_1', value: 'aep-secret-value' },
            credentialId: 'credential_1',
            expiresAt: '2999-01-01T00:00:00.000Z',
            grantType: 'api-key',
            issuedAt: '2026-01-01T00:00:00.000Z',
            serviceDid: 'did:web:service.example',
            serviceUrl: 'https://service.example',
          },
        },
      },
      identities: {
        'did:web:service.example': {
          agentDid: 'did:web:platform.example:agents:one',
          identityKind: 'platform-hosted',
          serviceDid: 'did:web:service.example',
          signingAlgorithms: ['ES256'],
        },
      },
      owner: { platformOrigin: 'https://platform.example', userId: 'user-1' },
      version: 1,
    });

    expect(readFileSync(s.getPath(), 'utf8')).not.toContain('aep-secret-value');
    expect(s.getAepState()?.credentials['did:web:service.example']?.['credential_1']).toMatchObject({
      credential: { credential_id: 'credential_1', value: 'aep-secret-value' },
      serviceUrl: 'https://service.example',
    });

    s.clearAepState();
    expect(s.getAepState()).toBeNull();
  });

  it('deletes expired AEP credential secrets during normal credential-store interactions', () => {
    const secretStore = new CountingSecretStore();
    const s = new Storage({ cwd: tmpDir, secretStore });
    s.setAepState({
      credentials: {
        'did:web:service.example': {
          active: {
            credential: { credential_id: 'active', value: 'active-secret-value' },
            credentialId: 'active',
            expiresAt: '2999-01-01T00:00:00.000Z',
            grantType: 'api-key',
            issuedAt: '2026-01-01T00:00:00.000Z',
            serviceDid: 'did:web:service.example',
          },
          expired: {
            credential: { credential_id: 'expired', value: 'expired-secret-value' },
            credentialId: 'expired',
            expiresAt: '2000-01-01T00:00:00.000Z',
            grantType: 'api-key',
            issuedAt: '2026-01-01T00:00:00.000Z',
            serviceDid: 'did:web:service.example',
          },
        },
      },
      identities: {},
      owner: { platformOrigin: 'https://platform.example', userId: 'user-1' },
      version: 1,
    });

    const aep = new AepStorage(s, { platformOrigin: 'https://platform.example', userId: 'user-1' });
    expect(aep.credentials().listCredentials('did:web:service.example')).toHaveLength(1);

    expect(s.getAepState()?.credentials['did:web:service.example']?.['expired']).toBeUndefined();
    expect(readFileSync(s.getPath(), 'utf8')).not.toContain('expired-secret-value');
    expect(secretStore.deleted.length).toBeGreaterThanOrEqual(2);
  });

  it('finds AEP identities and deletes matching credentials without reading credential payloads', () => {
    const secretStore = new CountingSecretStore();
    const s = new Storage({ cwd: tmpDir, secretStore });
    const owner = { platformOrigin: 'https://platform.example', userId: 'user-1' };
    s.setAepState({
      credentials: {
        'did:web:service.example': {
          keep: {
            credential: { credential_id: 'keep', value: 'keep-secret-value' },
            credentialId: 'keep',
            expiresAt: '2999-01-01T00:00:00.000Z',
            grantType: 'oauth-bearer',
            issuedAt: '2026-01-01T00:00:00.000Z',
            serviceDid: 'did:web:service.example',
          },
          remove: {
            credential: { credential_id: 'remove', value: 'remove-secret-value' },
            credentialId: 'remove',
            expiresAt: '2999-01-01T00:00:00.000Z',
            grantType: 'api-key',
            issuedAt: '2026-01-01T00:00:00.000Z',
            serviceDid: 'did:web:service.example',
          },
        },
      },
      identities: {
        'did:web:service.example': {
          agentDid: 'did:web:platform.example:agents:one',
          identityKind: 'platform-hosted',
          serviceDid: 'did:web:service.example',
          signingAlgorithms: ['ES256'],
        },
      },
      owner,
      version: 1,
    });
    secretStore.readReferences.length = 0;

    expect(s.findAepIdentity(owner, 'did:web:service.example')).toMatchObject({
      agentDid: 'did:web:platform.example:agents:one',
    });
    s.deleteAepCredentials(owner, 'did:web:service.example', { grantType: 'api-key' });

    expect(secretStore.readReferences.filter((reference) => reference.purpose === 'aep-credential')).toEqual([]);
    expect(secretStore.deleted.filter((reference) => reference.purpose === 'aep-credential')).toHaveLength(1);
    const state = s.getAepState();
    expect(state?.credentials['did:web:service.example']?.['remove']).toBeUndefined();
    expect(state?.credentials['did:web:service.example']?.['keep']).toMatchObject({
      credential: { credential_id: 'keep', value: 'keep-secret-value' },
    });

    s.deleteAepCredentials(owner, 'did:web:service.example', { allGrantTypes: true });
    expect(s.getAepState()?.credentials['did:web:service.example']).toBeUndefined();
  });

  it('deletes newly created AEP secrets when metadata persistence fails', () => {
    const secretStore = new CountingSecretStore();
    const storage = new Storage({ cwd: tmpDir, secretStore });
    vi.spyOn(SecureSqliteRepository.prototype, 'upsertSetting').mockImplementation(() => {
      throw new Error('metadata write failed');
    });

    expect(() =>
      storage.setAepState({
        credentials: {
          'did:web:service.example': {
            'credential-1': {
              credential: { credential_id: 'credential-1', value: 'secret-value' },
              credentialId: 'credential-1',
              grantType: 'api-key',
              issuedAt: '2026-01-01T00:00:00.000Z',
              serviceDid: 'did:web:service.example',
            },
          },
        },
        identities: {},
        owner: { platformOrigin: 'https://platform.example', userId: 'user-1' },
        version: 1,
      }),
    ).toThrow('metadata write failed');
    expect(secretStore.deleted).toHaveLength(1);
  });

  it('keeps existing AEP credentials usable when replacement metadata cannot be committed', () => {
    const secretStore = new CountingSecretStore();
    const storage = new Storage({ cwd: tmpDir, secretStore });
    const owner = { platformOrigin: 'https://platform.example', userId: 'user-1' };
    storage.setAepState({
      credentials: {
        'did:web:service.example': {
          old: {
            credential: { credential_id: 'old', value: 'old-secret-value' },
            credentialId: 'old',
            grantType: 'api-key',
            issuedAt: '2026-01-01T00:00:00.000Z',
            serviceDid: 'did:web:service.example',
          },
        },
      },
      identities: {},
      owner,
      version: 1,
    });
    vi.spyOn(SecureSqliteRepository.prototype, 'upsertSetting').mockImplementation(() => {
      throw new Error('metadata write failed');
    });

    expect(() =>
      storage.setAepState({
        credentials: {
          'did:web:service.example': {
            replacement: {
              credential: { credential_id: 'replacement', value: 'new-secret-value' },
              credentialId: 'replacement',
              grantType: 'api-key',
              issuedAt: '2026-01-01T00:00:00.000Z',
              serviceDid: 'did:web:service.example',
            },
          },
        },
        identities: {},
        owner,
        version: 1,
      }),
    ).toThrow('metadata write failed');

    expect(storage.getAepState()?.credentials['did:web:service.example']?.['old']).toMatchObject({
      credential: { credential_id: 'old', value: 'old-secret-value' },
    });
  });

  it('clears secure AEP state when direct operations use a different owner', () => {
    const owner = { platformOrigin: 'https://platform.example', userId: 'user-1' };
    const otherOwner = { ...owner, userId: 'user-2' };
    const first = secureStorage();
    first.setAepState({
      credentials: {},
      identities: {
        'did:web:service.example': {
          agentDid: 'did:web:platform.example:agents:one',
          identityKind: 'platform-hosted',
          serviceDid: 'did:web:service.example',
          signingAlgorithms: ['ES256'],
        },
      },
      owner,
      version: 1,
    });
    expect(first.findAepIdentity(otherOwner, 'did:web:service.example')).toBeUndefined();
    expect(first.getAepState()).toBeNull();

    const second = secureStorage();
    second.setAepState({ credentials: {}, identities: {}, owner, version: 1 });
    second.deleteAepCredentials(otherOwner, 'did:web:service.example', { allGrantTypes: true });
    expect(second.getAepState()).toBeNull();
  });
});

describe('MemoryStorage', () => {
  it('invalidates session identifiers even when replacement tokens are identical', () => {
    const storage = new MemoryStorage();
    const id = storage.setAuth(sampleAuth);
    const copy = storage.getAuth();
    if (copy === null) throw new Error('Expected stored authentication');
    copy.access_token = 'mutated';
    expect(storage.getAuthToken(id, 'access')).toBe('a');
    expect(storage.getAuthToken(id, 'refresh')).toBe('r');
    const replacement = storage.setAuth(sampleAuth);
    expect(replacement).not.toBe(id);
    expect(() => storage.getAuthToken(id, 'access')).toThrow('session changed');
    expect(() => storage.setAuth(sampleAuth, id)).toThrow('session changed');
    storage.clearAuth();
    expect(() => storage.getAuthToken(replacement, 'refresh')).toThrow('session changed');
  });

  it('has same surface and in-process semantics', () => {
    const s = new MemoryStorage();
    expect(s.getPath()).toBe('memory');
    expect(s.isAuthenticated()).toBe(false);
    s.setAuth(sampleAuth);
    expect(s.isAuthenticated()).toBe(true);
    expect(s.getAuth()?.expires_at).toBeGreaterThan(0);
  });

  it('initial auth in constructor', () => {
    const s = new MemoryStorage(sampleAuth);
    expect(s.isAuthenticated()).toBe(true);
  });

  it('pendingDeviceAuth evicts on read when expired', () => {
    const s = new MemoryStorage();
    s.setPendingDeviceAuth({
      device_code: 'd',
      interval: 5,
      expires_at: Date.now() - 1,
      verification_url: 'https://x/',
      phrase: 'P',
    });
    expect(s.getPendingDeviceAuth()).toBeNull();
  });

  it('clearAll wipes auth, apiKey, pendingDeviceAuth, connection; deleteConfig is no-op', async () => {
    const s = new MemoryStorage(sampleAuth);
    s.setApiKey('inflow_live_xyz');
    s.setPendingDeviceAuth({
      device_code: 'd',
      interval: 5,
      expires_at: Date.now() + 60_000,
      verification_url: 'https://x/',
      phrase: 'P',
    });
    s.setConnection({ environment: 'sandbox' });
    s.clearAll();
    expect(s.isAuthenticated()).toBe(false);
    expect(s.getApiKey()).toBeNull();
    expect(s.getPendingDeviceAuth()).toBeNull();
    expect(s.getConnection()).toBeNull();
    await expect(s.deleteConfig()).resolves.toBeUndefined();
  });

  it('apiKey and connection round-trip via the in-memory implementation', () => {
    const s = new MemoryStorage();
    expect(s.getApiKey()).toBeNull();
    expect(s.getConnection()).toBeNull();
    s.setApiKey('inflow_test_xyz');
    s.setConnection({
      environment: 'sandbox',
      apiBaseUrl: 'https://dev/',
      authBaseUrl: 'https://auth-dev/',
    });
    expect(s.getApiKey()).toBe('inflow_test_xyz');
    expect(s.getConnection()).toEqual({
      environment: 'sandbox',
      apiBaseUrl: 'https://dev/',
      authBaseUrl: 'https://auth-dev/',
    });
    expect(s.isAuthenticated()).toBe(true);
    s.clearApiKey();
    s.clearConnection();
    expect(s.getApiKey()).toBeNull();
    expect(s.getConnection()).toBeNull();
  });

  it('MemoryStorage.setApiKey rejects empty strings', () => {
    const s = new MemoryStorage();
    expect(() => s.setApiKey('')).toThrow();
  });

  it('clearPendingDeviceAuth and clearAuth individually', () => {
    const s = new MemoryStorage(sampleAuth);
    s.clearAuth();
    expect(s.isAuthenticated()).toBe(false);
    s.setPendingDeviceAuth({
      device_code: 'd',
      interval: 5,
      expires_at: Date.now() + 60_000,
      verification_url: 'https://x/',
      phrase: 'P',
    });
    s.clearPendingDeviceAuth();
    expect(s.getPendingDeviceAuth()).toBeNull();
  });
});
