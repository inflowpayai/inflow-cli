import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SecretReferenceManifest,
  MemorySecretStore,
  SyncSecretReferenceManifestStore,
  SyncMemorySecretStore,
} from '../../../src/secure-storage/secret-store.js';
import {
  SecureSecretLifecycleCoordinator,
  SyncSecureSecretLifecycleCoordinator,
} from '../../../src/secure-storage/lifecycle.js';
import { SecureSqliteRepository } from '../../../src/secure-storage/sqlite.js';

class FailingAddManifest extends SecretReferenceManifest {
  override add(): Promise<void> {
    return Promise.reject(new Error('manifest add failed'));
  }
}

function rejectWithUnknown(reason: unknown): Promise<never> {
  const reject: (value?: unknown) => Promise<never> = Promise.reject.bind(Promise);
  return reject(reason);
}

class NonErrorFailingAddManifest extends SecretReferenceManifest {
  override add(): Promise<void> {
    return rejectWithUnknown('manifest add failed');
  }
}

class FailingRemoveManifest extends SecretReferenceManifest {
  override remove(): Promise<void> {
    return Promise.reject(new Error('manifest remove failed'));
  }
}

class FailingSyncAddManifest extends SyncSecretReferenceManifestStore {
  override add(): void {
    throw new Error('manifest add failed');
  }
}

class FailingSyncRemoveManifest extends SyncSecretReferenceManifestStore {
  override remove(): void {
    throw new Error('manifest remove failed');
  }
}

describe('SecureSecretLifecycleCoordinator', () => {
  let tmpDir: string;
  let repository: SecureSqliteRepository;
  let store: MemorySecretStore;
  let manifest: SecretReferenceManifest;
  let coordinator: SecureSecretLifecycleCoordinator;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-secret-lifecycle-'));
    repository = new SecureSqliteRepository({ rootDir: tmpDir });
    repository.initialize();
    store = new MemorySecretStore();
    manifest = new SecretReferenceManifest(store);
    coordinator = new SecureSecretLifecycleCoordinator(repository, store, manifest);
  });

  afterEach(() => {
    repository.close();
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it('creates a secret item, manifest reference, and active lifecycle row in one serialized operation', async () => {
    const principal = repository.upsertPrincipal('https://platform.example.test', 'user-1');
    const reference = { purpose: 'api-key', reference: 'opaque-reference' };

    await coordinator.create(reference, Buffer.from('secret'), principal.id, { owner: 'auth' });

    expect(Buffer.from(await store.read(reference)).toString('utf8')).toBe('secret');
    expect(await manifest.read()).toEqual([reference]);
    expect(repository.listSecretLifecycle('active')).toEqual([reference]);
  });

  it('deletes the secret item, manifest reference, and lifecycle row', async () => {
    const reference = { purpose: 'api-key', reference: 'opaque-reference' };
    await coordinator.create(reference, Buffer.from('secret'), null);

    await coordinator.delete(reference);

    await expect(store.read(reference)).rejects.toMatchObject({ secureStorageCode: 'secure_storage_secret_missing' });
    expect(await manifest.read()).toEqual([]);
    expect(repository.listSecretLifecycle('deleting')).toEqual([]);
  });

  it('resumes interrupted pending and deleting lifecycle work', async () => {
    const pending = { purpose: 'api-key', reference: 'pending-reference' };
    const deleting = { purpose: 'refresh-token', reference: 'deleting-reference' };
    await store.create(pending, Buffer.from('pending'));
    await store.create(deleting, Buffer.from('deleting'));
    await manifest.add(pending);
    await manifest.add(deleting);
    repository.beginSecretLifecycle(pending, null);
    repository.beginSecretLifecycle(deleting, null);
    repository.markSecretDeleting(deleting);

    await coordinator.recoverInterruptedWork();

    await expect(store.read(pending)).rejects.toMatchObject({ secureStorageCode: 'secure_storage_secret_missing' });
    await expect(store.read(deleting)).rejects.toMatchObject({ secureStorageCode: 'secure_storage_secret_missing' });
    expect(await manifest.read()).toEqual([]);
    expect(repository.listSecretLifecycle('pending')).toEqual([]);
    expect(repository.listSecretLifecycle('deleting')).toEqual([]);
  });

  it('cleans lifecycle records when interrupted secrets are already absent', async () => {
    const pending = { purpose: 'api-key', reference: 'missing-pending' };
    const deleting = { purpose: 'refresh-token', reference: 'missing-deleting' };
    repository.beginSecretLifecycle(pending, null);
    repository.beginSecretLifecycle(deleting, null);
    repository.markSecretDeleting(deleting);

    await coordinator.recoverInterruptedWork();

    expect(repository.listSecretLifecycle('pending')).toEqual([]);
    expect(repository.listSecretLifecycle('deleting')).toEqual([]);
  });

  it('keeps a failed create recoverable after the secret item is written', async () => {
    const reference = { purpose: 'api-key', reference: 'create-failure' };
    const failing = new SecureSecretLifecycleCoordinator(repository, store, new FailingAddManifest(store));

    await expect(failing.create(reference, Buffer.from('secret'), null)).rejects.toThrow('manifest add failed');
    expect(repository.listSecretLifecycle('pending')).toEqual([reference]);
    expect(Buffer.from(await store.read(reference)).toString('utf8')).toBe('secret');

    await coordinator.recoverInterruptedWork();

    await expect(store.read(reference)).rejects.toMatchObject({ secureStorageCode: 'secure_storage_secret_missing' });
    expect(repository.listSecretLifecycle('pending')).toEqual([]);
  });

  it('normalizes non-Error lifecycle failures without losing recovery state', async () => {
    const reference = { purpose: 'api-key', reference: 'non-error-create-failure' };
    const failing = new SecureSecretLifecycleCoordinator(repository, store, new NonErrorFailingAddManifest(store));

    await expect(failing.create(reference, Buffer.from('secret'), null)).rejects.toThrow(
      'Secure secret lifecycle operation failed.',
    );
    expect(repository.listSecretLifecycle('pending')).toEqual([reference]);
  });

  it('keeps a failed delete recoverable after the secret item is deleted', async () => {
    const reference = { purpose: 'api-key', reference: 'delete-failure' };
    await coordinator.create(reference, Buffer.from('secret'), null);
    const failing = new SecureSecretLifecycleCoordinator(repository, store, new FailingRemoveManifest(store));

    await expect(failing.delete(reference)).rejects.toThrow('manifest remove failed');
    expect(repository.listSecretLifecycle('deleting')).toEqual([reference]);
    await expect(store.read(reference)).rejects.toMatchObject({ secureStorageCode: 'secure_storage_secret_missing' });

    await coordinator.recoverInterruptedWork();

    expect(repository.listSecretLifecycle('deleting')).toEqual([]);
    expect(await manifest.read()).toEqual([]);
  });

  it('supports synchronous create, delete, and interrupted-work recovery', () => {
    const syncStore = new SyncMemorySecretStore();
    const syncManifest = new SyncSecretReferenceManifestStore(syncStore);
    const syncCoordinator = new SyncSecureSecretLifecycleCoordinator(repository, syncStore, syncManifest);
    const active = { purpose: 'api-key', reference: 'sync-active' };

    syncCoordinator.create(active, Buffer.from('secret'), null, { owner: 'auth' });
    expect(Buffer.from(syncStore.read(active)).toString('utf8')).toBe('secret');
    expect(syncManifest.read()).toEqual([active]);
    expect(repository.listSecretLifecycle('active')).toEqual([active]);

    syncCoordinator.delete(active);
    expect(() => syncStore.read(active)).toThrow('A referenced secret is missing from secret store.');
    expect(repository.listSecretLifecycle('active')).toEqual([]);

    const pending = { purpose: 'api-key', reference: 'sync-pending' };
    const deleting = { purpose: 'refresh-token', reference: 'sync-deleting' };
    syncStore.create(pending, Buffer.from('pending'));
    syncManifest.add(pending);
    repository.beginSecretLifecycle(pending, null);
    repository.beginSecretLifecycle(deleting, null);
    repository.markSecretDeleting(deleting);

    syncCoordinator.recoverInterruptedWork();

    expect(() => syncStore.read(pending)).toThrow('A referenced secret is missing from secret store.');
    expect(repository.listSecretLifecycle('pending')).toEqual([]);
    expect(repository.listSecretLifecycle('deleting')).toEqual([]);
  });

  it('keeps synchronous create and delete failures recoverable after touching secret store', () => {
    const syncStore = new SyncMemorySecretStore();
    const syncManifest = new SyncSecretReferenceManifestStore(syncStore);
    const syncCoordinator = new SyncSecureSecretLifecycleCoordinator(repository, syncStore, syncManifest);
    const createFailure = { purpose: 'api-key', reference: 'sync-create-failure' };
    const failingCreate = new SyncSecureSecretLifecycleCoordinator(
      repository,
      syncStore,
      new FailingSyncAddManifest(syncStore),
    );

    expect(() => failingCreate.create(createFailure, Buffer.from('secret'), null)).toThrow('manifest add failed');
    expect(repository.listSecretLifecycle('pending')).toEqual([createFailure]);
    expect(Buffer.from(syncStore.read(createFailure)).toString('utf8')).toBe('secret');
    syncCoordinator.recoverInterruptedWork();
    expect(() => syncStore.read(createFailure)).toThrow('A referenced secret is missing from secret store.');

    const deleteFailure = { purpose: 'api-key', reference: 'sync-delete-failure' };
    syncCoordinator.create(deleteFailure, Buffer.from('secret'), null);
    const failingDelete = new SyncSecureSecretLifecycleCoordinator(
      repository,
      syncStore,
      new FailingSyncRemoveManifest(syncStore),
    );

    expect(() => failingDelete.delete(deleteFailure)).toThrow('manifest remove failed');
    expect(repository.listSecretLifecycle('deleting')).toEqual([deleteFailure]);
    expect(() => syncStore.read(deleteFailure)).toThrow('A referenced secret is missing from secret store.');
    syncCoordinator.recoverInterruptedWork();
    expect(repository.listSecretLifecycle('deleting')).toEqual([]);
  });

  it('rejects malformed asynchronous and synchronous reference manifests', async () => {
    const manifestReference = { purpose: 'manifest', reference: 'fixed-secret-references' };
    await store.create(manifestReference, Buffer.from('{"not":"an array"}'));
    await expect(manifest.read()).rejects.toMatchObject({ secureStorageCode: 'secure_storage_corrupt' });

    await store.delete(manifestReference);
    await store.create(manifestReference, Buffer.from('[null]'));
    await expect(manifest.read()).rejects.toMatchObject({ secureStorageCode: 'secure_storage_corrupt' });

    const syncStore = new SyncMemorySecretStore();
    const syncManifest = new SyncSecretReferenceManifestStore(syncStore);
    syncStore.create(manifestReference, Buffer.from('not json'));
    expect(() => syncManifest.read()).toThrow('manifest is malformed');

    syncStore.delete(manifestReference);
    syncStore.create(manifestReference, Buffer.from('[{"purpose":1,"reference":"value"}]'));
    expect(() => syncManifest.read()).toThrow('malformed entry');
  });

  it('accepts a missing manifest and rejects empty secret references', async () => {
    await expect(manifest.read()).resolves.toEqual([]);
    expect(() =>
      new SyncMemorySecretStore().create({ purpose: '', reference: 'value' }, Buffer.from('secret')),
    ).toThrow('Secret references require a purpose and opaque reference.');
    expect(() => store.create({ purpose: 'value', reference: '' }, Buffer.from('secret'))).toThrow(
      'Secret references require a purpose and opaque reference.',
    );
  });
});
