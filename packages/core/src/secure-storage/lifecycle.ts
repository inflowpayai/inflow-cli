import { SecureStorageError } from './errors.js';
import type {
  SecretReference,
  SecretReferenceManifest,
  SecureSecretStore,
  SyncSecretReferenceManifest,
  SyncSecureSecretStore,
} from './secret-store.js';
import type { SecureSqliteRepository } from './sqlite.js';

function errorFromCause(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  return new Error('Secure secret lifecycle operation failed.', { cause });
}

export class SecureSecretLifecycleCoordinator {
  constructor(
    private readonly repository: SecureSqliteRepository,
    private readonly store: SecureSecretStore,
    private readonly manifest: SecretReferenceManifest,
  ) {}

  async create(
    reference: SecretReference,
    value: Uint8Array,
    principalId: number | null,
    payload: unknown = {},
  ): Promise<void> {
    this.repository.writeTransactionSync(() => {
      this.repository.beginSecretLifecycle(reference, principalId, payload);
    });
    try {
      await this.store.create(reference, value);
      await this.manifest.add(reference);
      this.repository.writeTransactionSync(() => {
        this.repository.markSecretActive(reference);
      });
    } catch (cause) {
      this.repository.releaseSecretLifecycle(reference);
      throw errorFromCause(cause);
    }
  }

  async delete(reference: SecretReference): Promise<void> {
    this.repository.writeTransactionSync(() => {
      this.repository.markSecretDeleting(reference);
    });
    try {
      await this.deleteIfPresent(reference);
      await this.manifest.remove(reference);
      this.repository.writeTransactionSync(() => {
        this.repository.deleteSecretLifecycle(reference);
      });
    } catch (cause) {
      this.repository.releaseSecretLifecycle(reference);
      throw errorFromCause(cause);
    }
  }

  async recoverInterruptedWork(): Promise<void> {
    for (;;) {
      const reference = this.repository.claimInterruptedSecretLifecycle();
      if (reference === undefined) return;
      try {
        await this.deleteIfPresent(reference);
        await this.manifest.remove(reference);
        this.repository.writeTransactionSync(() => {
          this.repository.deleteSecretLifecycle(reference);
        });
      } catch (cause) {
        this.repository.releaseSecretLifecycle(reference);
        throw cause;
      }
    }
  }

  private async deleteIfPresent(reference: SecretReference): Promise<void> {
    try {
      await this.store.delete(reference);
    } catch (cause) {
      if (isMissingSecretError(cause)) return;
      throw cause;
    }
  }
}

export class SyncSecureSecretLifecycleCoordinator {
  constructor(
    private readonly repository: SecureSqliteRepository,
    private readonly store: SyncSecureSecretStore,
    private readonly manifest: SyncSecretReferenceManifest,
  ) {}

  create(reference: SecretReference, value: Uint8Array, principalId: number | null, payload: unknown = {}): void {
    this.repository.writeTransactionSync(() => {
      this.repository.beginSecretLifecycle(reference, principalId, payload);
    });
    try {
      this.store.create(reference, value);
      this.manifest.add(reference);
      this.repository.writeTransactionSync(() => {
        this.repository.markSecretActive(reference);
      });
    } catch (cause) {
      this.repository.releaseSecretLifecycle(reference);
      throw errorFromCause(cause);
    }
  }

  delete(reference: SecretReference): void {
    this.repository.writeTransactionSync(() => {
      this.repository.markSecretDeleting(reference);
    });
    try {
      this.deleteIfPresent(reference);
      this.manifest.remove(reference);
      this.repository.writeTransactionSync(() => {
        this.repository.deleteSecretLifecycle(reference);
      });
    } catch (cause) {
      this.repository.releaseSecretLifecycle(reference);
      throw errorFromCause(cause);
    }
  }

  recoverInterruptedWork(): void {
    for (;;) {
      const reference = this.repository.claimInterruptedSecretLifecycle();
      if (reference === undefined) return;
      try {
        this.deleteIfPresent(reference);
        this.manifest.remove(reference);
        this.repository.writeTransactionSync(() => {
          this.repository.deleteSecretLifecycle(reference);
        });
      } catch (cause) {
        this.repository.releaseSecretLifecycle(reference);
        throw cause;
      }
    }
  }

  private deleteIfPresent(reference: SecretReference): void {
    try {
      this.store.delete(reference);
    } catch (cause) {
      if (isMissingSecretError(cause)) return;
      throw cause;
    }
  }
}

function isMissingSecretError(cause: unknown): boolean {
  return cause instanceof SecureStorageError && cause.secureStorageCode === 'secure_storage_secret_missing';
}
