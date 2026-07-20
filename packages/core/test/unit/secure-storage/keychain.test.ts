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
  type SecretReference,
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

class BinaryAsyncEntry {
  deletePassword(): Promise<boolean> {
    return Promise.resolve(true);
  }

  getPassword(): Promise<Uint8Array> {
    return Promise.resolve(Uint8Array.from([1, 2, 3]));
  }

  setPassword(): Promise<void> {
    return Promise.resolve();
  }
}

class FailingAsyncEntry {
  deletePassword(): Promise<boolean> {
    return Promise.reject(new Error('delete failed'));
  }

  getPassword(): Promise<undefined> {
    return Promise.reject(new Error('read failed'));
  }

  setPassword(): Promise<void> {
    return Promise.reject(new Error('write failed'));
  }
}

class FailingEntry {
  deleteCredential(): boolean {
    throw new Error('delete failed');
  }

  getSecret(): null {
    throw new Error('read failed');
  }

  setSecret(): void {
    throw new Error('write failed');
  }
}

class FailingAsyncManifestDeleteStore extends MemorySecretStore {
  override delete(_reference: SecretReference): Promise<void> {
    return Promise.reject(new Error('manifest delete failed'));
  }
}

class FailingSyncManifestDeleteStore extends SyncMemorySecretStore {
  override delete(_reference: SecretReference): void {
    throw new Error('manifest delete failed');
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

  it('accepts binary Keychain values without base64 decoding', async () => {
    const store = new KeychainSecretStore({
      loadKeyring: () => ({ AsyncEntry: BinaryAsyncEntry, Entry: FakeEntry }),
    });

    await expect(store.read({ purpose: 'api-key', reference: 'binary' })).resolves.toEqual(Uint8Array.from([1, 2, 3]));
  });

  it('maps backend write, read, and delete failures to stable storage errors', async () => {
    const store = new KeychainSecretStore({
      loadKeyring: () => ({ AsyncEntry: FailingAsyncEntry, Entry: FakeEntry }),
    });
    const reference = { purpose: 'api-key', reference: 'failing' };

    await expect(store.create(reference, Buffer.from('secret'))).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_io_error',
    });
    await expect(store.read(reference)).rejects.toMatchObject({ secureStorageCode: 'secure_storage_io_error' });
    await expect(store.delete(reference)).rejects.toMatchObject({ secureStorageCode: 'secure_storage_io_error' });
  });

  it('reports deletion of a missing Keychain reference distinctly', async () => {
    FakeAsyncEntry.values.clear();
    const store = new KeychainSecretStore({ loadKeyring: () => ({ AsyncEntry: FakeAsyncEntry, Entry: FakeEntry }) });

    await expect(store.delete({ purpose: 'api-key', reference: 'missing' })).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_secret_missing',
    });
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

  it('maps synchronous backend failures and missing deletion to stable errors', () => {
    const failing = new SyncKeychainSecretStore({
      loadKeyring: () => ({ AsyncEntry: FakeAsyncEntry, Entry: FailingEntry }),
    });
    const reference = { purpose: 'api-key', reference: 'failing' };

    expect(() => failing.create(reference, Buffer.from('secret'))).toThrow('Failed to write a secret to Keychain.');
    expect(() => failing.read(reference)).toThrow('Failed to read a secret from Keychain.');
    expect(() => failing.delete(reference)).toThrow('Failed to delete a secret from Keychain.');

    FakeAsyncEntry.values.clear();
    const missing = new SyncKeychainSecretStore({
      loadKeyring: () => ({ AsyncEntry: FakeAsyncEntry, Entry: FakeEntry }),
    });
    expect(() => missing.delete({ purpose: 'api-key', reference: 'missing' })).toThrow(
      'A referenced secret could not be deleted.',
    );
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

  it('rejects malformed JSON, non-array payloads, and malformed entries', async () => {
    const store = new MemorySecretStore();
    const reference = { purpose: 'manifest', reference: 'fixed-keychain-references' };
    const manifest = new KeychainReferenceManifest(store);

    await store.create(reference, Buffer.from('{', 'utf8'));
    await expect(manifest.read()).rejects.toMatchObject({ secureStorageCode: 'secure_storage_corrupt' });
    await store.delete(reference);
    await store.create(reference, Buffer.from('{}', 'utf8'));
    await expect(manifest.read()).rejects.toMatchObject({ secureStorageCode: 'secure_storage_corrupt' });
    await store.delete(reference);
    await store.create(reference, Buffer.from('[null]', 'utf8'));
    await expect(manifest.read()).rejects.toMatchObject({ secureStorageCode: 'secure_storage_corrupt' });
    await store.delete(reference);
    await store.create(reference, Buffer.from('[{"purpose":1,"reference":"one"}]', 'utf8'));
    await expect(manifest.read()).rejects.toMatchObject({ secureStorageCode: 'secure_storage_corrupt' });
  });

  it('does not hide unexpected manifest deletion failures', async () => {
    const manifest = new KeychainReferenceManifest(new FailingAsyncManifestDeleteStore());

    await expect(manifest.add({ purpose: 'api-key', reference: 'one' })).rejects.toThrow('manifest delete failed');
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

  it('rejects corrupt synchronous manifests and propagates unexpected deletion failures', () => {
    const store = new SyncMemorySecretStore();
    const reference = { purpose: 'manifest', reference: 'fixed-keychain-references' };
    const manifest = new SyncKeychainReferenceManifest(store);

    store.create(reference, Buffer.from('{', 'utf8'));
    expect(() => manifest.read()).toThrow('The Keychain reference manifest is malformed.');
    store.delete(reference);
    store.create(reference, Buffer.from('[{}]', 'utf8'));
    expect(() => manifest.read()).toThrow('The Keychain reference manifest contains a malformed entry.');

    const failing = new SyncKeychainReferenceManifest(new FailingSyncManifestDeleteStore());
    expect(() => failing.add({ purpose: 'api-key', reference: 'one' })).toThrow('manifest delete failed');
  });

  it('reports missing values and deletions from both memory stores', async () => {
    const reference = { purpose: 'api-key', reference: 'missing' };
    const asyncStore = new MemorySecretStore();
    const syncStore = new SyncMemorySecretStore();

    await expect(asyncStore.read(reference)).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_secret_missing',
    });
    await expect(asyncStore.delete(reference)).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_secret_missing',
    });
    expect(() => syncStore.read(reference)).toThrow('A referenced secret is missing from Keychain.');
    expect(() => syncStore.delete(reference)).toThrow('A referenced secret could not be deleted.');
  });
});
