import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  KeychainReferenceManifest,
  KeychainSecretStore,
  MemorySecretStore,
  SyncKeychainReferenceManifest,
  SyncKeychainSecretStore,
  SyncMemorySecretStore,
  createOpaqueSecretReference,
} from '../../../src/secure-storage/keychain.js';
import { SecureStorageError } from '../../../src/secure-storage/errors.js';

class FakeAsyncEntry {
  static readonly values = new Map<string, string>();
  static readonly accounts: string[] = [];

  constructor(
    private readonly service: string,
    private readonly account: string,
  ) {
    FakeAsyncEntry.accounts.push(`${service}/${account}`);
  }

  deletePassword(): Promise<boolean> {
    return Promise.resolve(FakeAsyncEntry.values.delete(`${this.service}/${this.account}`));
  }

  getPassword(): Promise<string | undefined> {
    return Promise.resolve(FakeAsyncEntry.values.get(`${this.service}/${this.account}`));
  }

  setPassword(password: string | Buffer | Uint8Array): Promise<void> {
    FakeAsyncEntry.values.set(`${this.service}/${this.account}`, Buffer.from(password).toString('utf8'));
    return Promise.resolve();
  }
}

class FakeEntry {
  constructor(
    private readonly service: string,
    private readonly account: string,
  ) {}

  deleteCredential(): boolean {
    return FakeAsyncEntry.values.delete(`${this.service}/${this.account}`);
  }

  getSecret(): Uint8Array | null {
    const value = FakeAsyncEntry.values.get(`${this.service}/${this.account}`);
    return value === undefined ? null : Buffer.from(value, 'utf8');
  }

  setSecret(secret: Uint8Array): void {
    FakeAsyncEntry.values.set(`${this.service}/${this.account}`, Buffer.from(secret).toString('utf8'));
  }
}

describe('KeychainSecretStore', () => {
  it('reads and deletes exact opaque references without exposing a search surface', async () => {
    FakeAsyncEntry.values.clear();
    FakeAsyncEntry.accounts.length = 0;
    const store = new KeychainSecretStore({
      loadKeyring: () => ({ AsyncEntry: FakeAsyncEntry, Entry: FakeEntry }),
      serviceName: 'ai.inflowpay.cli.test',
    });
    const reference = { purpose: 'api-key', reference: 'opaque-reference' };

    await store.create(reference, Buffer.from('secret-value', 'utf8'));

    expect(Buffer.from(await store.read(reference)).toString('utf8')).toBe('secret-value');
    expect(Object.keys(store)).not.toContain('find');
    expect(FakeAsyncEntry.accounts).toEqual([
      'ai.inflowpay.cli.test/api-key:opaque-reference',
      'ai.inflowpay.cli.test/api-key:opaque-reference',
    ]);

    await store.delete(reference);
    await expect(store.read(reference)).rejects.toMatchObject({ secureStorageCode: 'secure_storage_secret_missing' });
  });

  it('rejects empty references before touching the backend', async () => {
    const store = new KeychainSecretStore({ loadKeyring: () => ({ AsyncEntry: FakeAsyncEntry, Entry: FakeEntry }) });

    await expect(store.create({ purpose: 'api-key', reference: '' }, Buffer.from('x'))).rejects.toBeInstanceOf(
      SecureStorageError,
    );
  });

  it('creates opaque references with the requested purpose', () => {
    const reference = createOpaqueSecretReference('refresh-token');

    expect(reference.purpose).toBe('refresh-token');
    expect(reference.reference).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('SyncKeychainSecretStore', () => {
  it('uses the exact-reference sync Entry API', () => {
    FakeAsyncEntry.values.clear();
    const store = new SyncKeychainSecretStore({
      loadKeyring: () => ({ AsyncEntry: FakeAsyncEntry, Entry: FakeEntry }),
      serviceName: 'ai.inflowpay.cli.test',
    });
    const reference = { purpose: 'api-key', reference: 'sync-reference' };

    store.create(reference, Buffer.from('sync-secret', 'utf8'));

    expect(Buffer.from(store.read(reference)).toString('utf8')).toBe('sync-secret');
    store.delete(reference);
    expect(() => store.read(reference)).toThrow('A referenced secret is missing from Keychain.');
  });
});

describe('KeychainReferenceManifest', () => {
  it('stores only opaque references in one fixed exact-reference item', async () => {
    const store = new MemorySecretStore();
    const manifest = new KeychainReferenceManifest(store);
    const first = { purpose: 'api-key', reference: 'one' };
    const second = { purpose: 'refresh-token', reference: 'two' };

    await manifest.add(first);
    await manifest.add(first);
    await manifest.add(second);
    expect(await manifest.read()).toEqual([first, second]);

    await manifest.remove(first);
    expect(await manifest.read()).toEqual([second]);
  });
});

describe('SyncKeychainReferenceManifest', () => {
  it('stores only opaque references through the sync store', () => {
    const store = new SyncMemorySecretStore();
    const manifest = new SyncKeychainReferenceManifest(store);
    const reference = { purpose: 'api-key', reference: 'one' };

    manifest.add(reference);
    manifest.add(reference);
    expect(manifest.read()).toEqual([reference]);

    manifest.remove(reference);
    expect(manifest.read()).toEqual([]);
  });
});
