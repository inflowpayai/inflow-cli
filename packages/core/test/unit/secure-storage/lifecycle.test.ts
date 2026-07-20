import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeychainReferenceManifest, MemorySecretStore } from '../../../src/secure-storage/keychain.js';
import { SecureSecretLifecycleCoordinator } from '../../../src/secure-storage/lifecycle.js';
import { SecureSqliteRepository } from '../../../src/secure-storage/sqlite.js';

describe('SecureSecretLifecycleCoordinator', () => {
  let tmpDir: string;
  let repository: SecureSqliteRepository;
  let store: MemorySecretStore;
  let manifest: KeychainReferenceManifest;
  let coordinator: SecureSecretLifecycleCoordinator;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-secret-lifecycle-'));
    repository = new SecureSqliteRepository({ rootDir: tmpDir });
    repository.initialize();
    store = new MemorySecretStore();
    manifest = new KeychainReferenceManifest(store);
    coordinator = new SecureSecretLifecycleCoordinator(repository, store, manifest);
  });

  afterEach(() => {
    repository.close();
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it('creates a Keychain item, manifest reference, and active lifecycle row in one serialized operation', async () => {
    const principal = repository.upsertPrincipal('https://platform.example.test', 'user-1');
    const reference = { purpose: 'api-key', reference: 'opaque-reference' };

    await coordinator.create(reference, Buffer.from('secret'), principal.id, { owner: 'auth' });

    expect(Buffer.from(await store.read(reference)).toString('utf8')).toBe('secret');
    expect(await manifest.read()).toEqual([reference]);
    expect(repository.listSecretLifecycle('active')).toEqual([reference]);
  });

  it('deletes the Keychain item, manifest reference, and lifecycle row', async () => {
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
});
