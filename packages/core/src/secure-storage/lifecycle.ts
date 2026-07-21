import type { KeychainReferenceManifest, SecretReference, SecureSecretStore } from './keychain.js';
import type { SyncKeychainReferenceManifest, SyncSecureSecretStore } from './keychain.js';
import type { SecureSqliteRepository } from './sqlite.js';

function errorFromCause(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  return new Error('Secure secret lifecycle operation failed.', { cause });
}

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
    let failure: Error | undefined;
    await this.repository.writeTransaction(async () => {
      this.repository.beginSecretLifecycle(reference, principalId, payload);
      try {
        await this.store.create(reference, value);
        await this.manifest.add(reference);
        this.repository.markSecretActive(reference);
      } catch (cause) {
        failure = errorFromCause(cause);
      }
    });
    if (failure !== undefined) throw failure;
  }

  async delete(reference: SecretReference): Promise<void> {
    let failure: Error | undefined;
    await this.repository.writeTransaction(async () => {
      this.repository.markSecretDeleting(reference);
      try {
        await this.store.delete(reference);
        await this.manifest.remove(reference);
        this.repository.deleteSecretLifecycle(reference);
      } catch (cause) {
        failure = errorFromCause(cause);
      }
    });
    if (failure !== undefined) throw failure;
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
    let failure: Error | undefined;
    this.repository.writeTransactionSync(() => {
      this.repository.beginSecretLifecycle(reference, principalId, payload);
      try {
        this.store.create(reference, value);
        this.manifest.add(reference);
        this.repository.markSecretActive(reference);
      } catch (cause) {
        failure = errorFromCause(cause);
      }
    });
    if (failure !== undefined) throw failure;
  }

  delete(reference: SecretReference): void {
    let failure: Error | undefined;
    this.repository.writeTransactionSync(() => {
      this.repository.markSecretDeleting(reference);
      try {
        this.store.delete(reference);
        this.manifest.remove(reference);
        this.repository.deleteSecretLifecycle(reference);
      } catch (cause) {
        failure = errorFromCause(cause);
      }
    });
    if (failure !== undefined) throw failure;
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
