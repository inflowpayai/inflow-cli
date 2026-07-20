import type { KeychainReferenceManifest, SecretReference, SecureSecretStore } from './keychain.js';
import type { SyncKeychainReferenceManifest, SyncSecureSecretStore } from './keychain.js';
import type { SecureSqliteRepository } from './sqlite.js';

export class SecureSecretLifecycleCoordinator {
  constructor(
    private readonly repository: SecureSqliteRepository,
    private readonly store: SecureSecretStore,
    private readonly manifest: KeychainReferenceManifest,
  ) {}

  async create(
    reference: SecretReference,
    value: Uint8Array,
    principalId: number | null,
    payload: unknown = {},
  ): Promise<void> {
    await this.repository.writeTransaction(async () => {
      this.repository.beginSecretLifecycle(reference, principalId, payload);
      await this.store.create(reference, value);
      await this.manifest.add(reference);
      this.repository.markSecretActive(reference);
    });
  }

  async delete(reference: SecretReference): Promise<void> {
    await this.repository.writeTransaction(async () => {
      this.repository.markSecretDeleting(reference);
      await this.store.delete(reference);
      await this.manifest.remove(reference);
      this.repository.deleteSecretLifecycle(reference);
    });
  }

  async recoverInterruptedWork(): Promise<void> {
    await this.repository.writeTransaction(async () => {
      for (const reference of this.repository.listSecretLifecycle('pending')) {
        await this.deleteIfPresent(reference);
        await this.manifest.remove(reference);
        this.repository.deleteSecretLifecycle(reference);
      }
      for (const reference of this.repository.listSecretLifecycle('deleting')) {
        await this.deleteIfPresent(reference);
        await this.manifest.remove(reference);
        this.repository.deleteSecretLifecycle(reference);
      }
    });
  }

  private async deleteIfPresent(reference: SecretReference): Promise<void> {
    try {
      await this.store.delete(reference);
    } catch {
      return;
    }
  }
}

export class SyncSecureSecretLifecycleCoordinator {
  constructor(
    private readonly repository: SecureSqliteRepository,
    private readonly store: SyncSecureSecretStore,
    private readonly manifest: SyncKeychainReferenceManifest,
  ) {}

  create(reference: SecretReference, value: Uint8Array, principalId: number | null, payload: unknown = {}): void {
    this.repository.writeTransactionSync(() => {
      this.repository.beginSecretLifecycle(reference, principalId, payload);
      this.store.create(reference, value);
      this.manifest.add(reference);
      this.repository.markSecretActive(reference);
    });
  }

  delete(reference: SecretReference): void {
    this.repository.writeTransactionSync(() => {
      this.repository.markSecretDeleting(reference);
      this.store.delete(reference);
      this.manifest.remove(reference);
      this.repository.deleteSecretLifecycle(reference);
    });
  }

  recoverInterruptedWork(): void {
    this.repository.writeTransactionSync(() => {
      for (const reference of this.repository.listSecretLifecycle('pending')) {
        this.deleteIfPresent(reference);
        this.manifest.remove(reference);
        this.repository.deleteSecretLifecycle(reference);
      }
      for (const reference of this.repository.listSecretLifecycle('deleting')) {
        this.deleteIfPresent(reference);
        this.manifest.remove(reference);
        this.repository.deleteSecretLifecycle(reference);
      }
    });
  }

  private deleteIfPresent(reference: SecretReference): void {
    try {
      this.store.delete(reference);
    } catch {
      return;
    }
  }
}
