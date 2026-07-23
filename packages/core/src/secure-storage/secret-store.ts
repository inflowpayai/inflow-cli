import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { SecureStorageError } from './errors.js';

export interface SecretReference {
  purpose: string;
  reference: string;
}

export interface SecureSecretStore {
  create(reference: SecretReference, value: Uint8Array): Promise<void>;
  delete(reference: SecretReference): Promise<void>;
  read(reference: SecretReference): Promise<Uint8Array>;
}

export interface SyncSecureSecretStore {
  create(reference: SecretReference, value: Uint8Array): void;
  delete(reference: SecretReference): void;
  read(reference: SecretReference): Uint8Array;
}

export interface SyncSecretReferenceManifest {
  add(reference: SecretReference): void;
  read(): SecretReference[];
  remove(reference: SecretReference): void;
}

export function createOpaqueSecretReference(purpose: string): SecretReference {
  return { purpose, reference: randomUUID() };
}

export class SecretReferenceManifest {
  private readonly reference: SecretReference;

  constructor(
    private readonly store: SecureSecretStore,
    purpose = 'manifest',
  ) {
    this.reference = { purpose, reference: 'fixed-secret-references' };
  }

  async add(reference: SecretReference): Promise<void> {
    const manifest = await this.read();
    if (!manifest.some((candidate) => sameReference(candidate, reference))) {
      manifest.push(reference);
      await this.write(manifest);
    }
  }

  async remove(reference: SecretReference): Promise<void> {
    await this.write((await this.read()).filter((candidate) => !sameReference(candidate, reference)));
  }

  async read(): Promise<SecretReference[]> {
    try {
      const parsed = JSON.parse(Buffer.from(await this.store.read(this.reference)).toString('utf8')) as unknown;
      if (!Array.isArray(parsed)) {
        throw new SecureStorageError('secure_storage_corrupt', 'The secret reference manifest is malformed.');
      }
      return parsed.map(parseManifestEntry);
    } catch (cause) {
      if (cause instanceof SecureStorageError && cause.secureStorageCode === 'secure_storage_secret_missing') return [];
      if (cause instanceof SecureStorageError) throw cause;
      throw new SecureStorageError('secure_storage_corrupt', 'The secret reference manifest is malformed.', {
        cause,
      });
    }
  }

  private async write(references: SecretReference[]): Promise<void> {
    const payload = Buffer.from(JSON.stringify(references), 'utf8');
    try {
      await this.store.delete(this.reference);
    } catch (cause) {
      if (!(cause instanceof SecureStorageError) || cause.secureStorageCode !== 'secure_storage_secret_missing') {
        throw cause;
      }
    }
    await this.store.create(this.reference, payload);
  }
}

export class SyncSecretReferenceManifestStore implements SyncSecretReferenceManifest {
  private readonly reference: SecretReference;

  constructor(
    private readonly store: SyncSecureSecretStore,
    purpose = 'manifest',
  ) {
    this.reference = { purpose, reference: 'fixed-secret-references' };
  }

  add(reference: SecretReference): void {
    const manifest = this.read();
    if (!manifest.some((candidate) => sameReference(candidate, reference))) {
      manifest.push(reference);
      this.write(manifest);
    }
  }

  remove(reference: SecretReference): void {
    this.write(this.read().filter((candidate) => !sameReference(candidate, reference)));
  }

  read(): SecretReference[] {
    try {
      const parsed = JSON.parse(Buffer.from(this.store.read(this.reference)).toString('utf8')) as unknown;
      if (!Array.isArray(parsed)) {
        throw new SecureStorageError('secure_storage_corrupt', 'The secret reference manifest is malformed.');
      }
      return parsed.map(parseManifestEntry);
    } catch (cause) {
      if (cause instanceof SecureStorageError && cause.secureStorageCode === 'secure_storage_secret_missing') return [];
      if (cause instanceof SecureStorageError) throw cause;
      throw new SecureStorageError('secure_storage_corrupt', 'The secret reference manifest is malformed.', {
        cause,
      });
    }
  }

  private write(references: SecretReference[]): void {
    const payload = Buffer.from(JSON.stringify(references), 'utf8');
    try {
      this.store.delete(this.reference);
    } catch (cause) {
      if (!(cause instanceof SecureStorageError) || cause.secureStorageCode !== 'secure_storage_secret_missing') {
        throw cause;
      }
    }
    this.store.create(this.reference, payload);
  }
}

export class MemorySecretStore implements SecureSecretStore {
  private readonly values = new Map<string, Uint8Array>();

  create(reference: SecretReference, value: Uint8Array): Promise<void> {
    this.values.set(accountFor(reference), Uint8Array.from(value));
    return Promise.resolve();
  }

  read(reference: SecretReference): Promise<Uint8Array> {
    const value = this.values.get(accountFor(reference));
    if (value === undefined) {
      return Promise.reject(
        new SecureStorageError('secure_storage_secret_missing', 'A referenced secret is missing from secret store.'),
      );
    }
    return Promise.resolve(Uint8Array.from(value));
  }

  delete(reference: SecretReference): Promise<void> {
    if (!this.values.delete(accountFor(reference))) {
      return Promise.reject(
        new SecureStorageError('secure_storage_secret_missing', 'A referenced secret could not be deleted.'),
      );
    }
    return Promise.resolve();
  }
}

export class SyncMemorySecretStore implements SyncSecureSecretStore {
  private readonly values = new Map<string, Uint8Array>();

  create(reference: SecretReference, value: Uint8Array): void {
    this.values.set(accountFor(reference), Uint8Array.from(value));
  }

  read(reference: SecretReference): Uint8Array {
    const value = this.values.get(accountFor(reference));
    if (value === undefined) {
      throw new SecureStorageError(
        'secure_storage_secret_missing',
        'A referenced secret is missing from secret store.',
      );
    }
    return Uint8Array.from(value);
  }

  delete(reference: SecretReference): void {
    if (!this.values.delete(accountFor(reference))) {
      throw new SecureStorageError('secure_storage_secret_missing', 'A referenced secret could not be deleted.');
    }
  }
}

function accountFor(reference: SecretReference): string {
  if (reference.reference.length === 0 || reference.purpose.length === 0) {
    throw new SecureStorageError(
      'secure_storage_invalid_path',
      'Secret references require a purpose and opaque reference.',
    );
  }
  return `${reference.purpose}:${reference.reference}`;
}

function parseManifestEntry(value: unknown): SecretReference {
  if (typeof value !== 'object' || value === null) {
    throw new SecureStorageError('secure_storage_corrupt', 'The secret reference manifest contains a malformed entry.');
  }
  const candidate = value as Partial<SecretReference>;
  if (typeof candidate.purpose !== 'string' || typeof candidate.reference !== 'string') {
    throw new SecureStorageError('secure_storage_corrupt', 'The secret reference manifest contains a malformed entry.');
  }
  return { purpose: candidate.purpose, reference: candidate.reference };
}

function sameReference(left: SecretReference, right: SecretReference): boolean {
  return left.purpose === right.purpose && left.reference === right.reference;
}
