import { Buffer } from 'node:buffer';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SecureStorageError } from './errors.js';
import type { SecureSqliteRepository, StoredVaultRecord } from './sqlite.js';
import {
  changeVaultUnlockFactor,
  createVaultMaterial,
  decryptVaultRecordPayload,
  deriveVaultKeys,
  encryptVaultRecordPayload,
  unwrapVaultMaterial,
} from './vault-crypto.js';
import { removeVaultLocalState, vaultFilePaths, type VaultFilePaths } from './vault-files.js';
import {
  DEFAULT_VAULT_POLICY,
  type DeleteExpiredVaultSecretsInput,
  type DeleteVaultSecretInput,
  type GetVaultSecretInput,
  type PutVaultSecretInput,
  type TouchVaultSecretInput,
  type VaultBackend,
  type VaultPolicy,
  type VaultSecretPayload,
  type VaultStatus,
} from './vault-backend.js';
import { createVaultSecretReference, parseVaultSecretReference, type VaultSecretKind } from './vault-types.js';

export interface LocalVaultBackendOptions {
  paths?: VaultFilePaths;
  repository: SecureSqliteRepository;
  sidecarPath?: string;
  now?: () => Date;
}

const POLICY_SETTING_NAME = 'vault-policy';
const RECORD_ENCRYPTION_VERSION = 1;
const SIDECAR_FILE_MODE = 0o600;

export class LocalVaultBackend implements VaultBackend {
  private masterKey: Buffer | undefined;
  private readonly now: () => Date;
  private readonly paths: VaultFilePaths;
  private readonly repository: SecureSqliteRepository;
  private readonly sidecarPath: string;

  constructor(options: LocalVaultBackendOptions) {
    this.paths = options.paths ?? vaultFilePaths();
    this.repository = options.repository;
    this.sidecarPath = options.sidecarPath ?? this.paths.sidecar;
    this.now = options.now ?? (() => new Date());
  }

  async changePassphrase(currentUnlockFactor: Uint8Array, nextUnlockFactor: Uint8Array): Promise<void> {
    const header = await readFile(this.sidecarPath);
    const nextHeader = await changeVaultUnlockFactor(header, currentUnlockFactor, nextUnlockFactor);
    await writeFile(this.sidecarPath, nextHeader, { flag: 'w', mode: SIDECAR_FILE_MODE });
    await chmod(this.sidecarPath, SIDECAR_FILE_MODE);
    this.masterKey = await unwrapVaultMaterial(nextHeader, nextUnlockFactor);
  }

  deleteExpired(input: DeleteExpiredVaultSecretsInput): void {
    this.repository.deleteExpiredVaultRecords(input.now);
  }

  deleteSecret(input: DeleteVaultSecretInput): void {
    const reference = parseVaultSecretReference(input.reference.reference);
    this.requireActiveRecord(reference.reference, input.expectedKind);
    this.repository.markVaultRecordStatus(reference.reference, 'deleting', this.nowIso());
    this.repository.deleteVaultRecord(reference.reference);
  }

  exists(input: GetVaultSecretInput): boolean {
    const reference = parseVaultSecretReference(input.reference.reference);
    return this.repository.getVaultRecord(reference.reference, input.expectedKind) !== undefined;
  }

  getPolicy(): VaultPolicy {
    const setting = this.repository.getSetting(POLICY_SETTING_NAME);
    if (setting === undefined) return DEFAULT_VAULT_POLICY;
    return parseVaultPolicy(setting.payload);
  }

  getSecret(input: GetVaultSecretInput): VaultSecretPayload {
    const keys = this.unlockedKeys();
    const reference = parseVaultSecretReference(input.reference.reference);
    const record = this.requireActiveRecord(reference.reference, input.expectedKind);
    return {
      payload: decryptVaultRecordPayload(keys.recordKey, recordContext(record), {
        ciphertext: Buffer.from(record.ciphertext),
        nonce: Buffer.from(record.nonce),
        tag: Buffer.from(record.tag),
      }),
      reference,
    };
  }

  lock(): void {
    this.masterKey?.fill(0);
    this.masterKey = undefined;
  }

  putSecret(input: PutVaultSecretInput): { reference: string } {
    const keys = this.unlockedKeys();
    const reference =
      input.reference === undefined
        ? createVaultSecretReference()
        : parseVaultSecretReference(input.reference.reference);
    if (this.repository.hasVaultRecord(reference.reference)) {
      throw new SecureStorageError('secure_storage_secret_conflict', 'The vault secret reference already exists.');
    }
    const status = 'active';
    const context = {
      encryptionVersion: RECORD_ENCRYPTION_VERSION,
      kind: input.expectedKind,
      reference: reference.reference,
      status,
    } as const;
    const encrypted = encryptVaultRecordPayload(keys.recordKey, context, input.payload);
    const record: StoredVaultRecord = {
      ciphertext: encrypted.ciphertext,
      encryptionVersion: RECORD_ENCRYPTION_VERSION,
      kind: input.expectedKind,
      nonce: encrypted.nonce,
      reference: reference.reference,
      status,
      tag: encrypted.tag,
      updatedAt: this.nowIso(),
    };
    if (input.expiresAt !== undefined) record.expiresAt = input.expiresAt;
    this.repository.putVaultRecord(record);
    return reference;
  }

  async reset(): Promise<void> {
    this.lock();
    await removeVaultLocalState(this.paths);
  }

  setPolicy(policy: VaultPolicy): VaultPolicy {
    const parsed = parseVaultPolicy(policy);
    this.repository.upsertSetting(POLICY_SETTING_NAME, parsed);
    return parsed;
  }

  async status(): Promise<VaultStatus> {
    return {
      daemonRunning: false,
      lockState: this.masterKey === undefined ? ((await this.hasSidecar()) ? 'locked' : 'not_initialized') : 'unlocked',
    };
  }

  touch(input: TouchVaultSecretInput): void {
    const reference = parseVaultSecretReference(input.reference.reference);
    this.requireActiveRecord(reference.reference, input.expectedKind);
    this.repository.touchVaultRecord(reference.reference, this.nowIso());
  }

  async unlock(unlockFactor: Uint8Array): Promise<VaultStatus> {
    this.repository.initialize();
    let header: Buffer;
    try {
      header = await readFile(this.sidecarPath);
      this.masterKey = await unwrapVaultMaterial(header, unlockFactor);
    } catch (cause) {
      if (!isMissingFileError(cause)) throw cause;
      const material = await createVaultMaterial(unlockFactor);
      await mkdir(path.dirname(this.sidecarPath), { mode: 0o700, recursive: true });
      await writeFile(this.sidecarPath, material.header, { flag: 'wx', mode: SIDECAR_FILE_MODE });
      await chmod(this.sidecarPath, SIDECAR_FILE_MODE);
      this.masterKey = material.masterKey;
    }
    return this.status();
  }

  private async hasSidecar(): Promise<boolean> {
    try {
      await readFile(this.sidecarPath);
      return true;
    } catch (cause) {
      if (isMissingFileError(cause)) return false;
      throw cause;
    }
  }

  private requireActiveRecord(reference: string, expectedKind: VaultSecretKind): StoredVaultRecord {
    const record = this.repository.getVaultRecordByReference(reference);
    if (
      record === undefined ||
      record.kind !== expectedKind ||
      record.status !== 'active' ||
      (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= this.now().getTime())
    ) {
      throw new SecureStorageError('secure_storage_secret_missing', 'A referenced vault secret is missing.');
    }
    return record;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private unlockedKeys(): ReturnType<typeof deriveVaultKeys> {
    if (this.masterKey === undefined) {
      throw new SecureStorageError('vault_locked', 'The InFlow vault is locked.');
    }
    return deriveVaultKeys(this.masterKey);
  }
}

function recordContext(record: StoredVaultRecord) {
  return {
    encryptionVersion: record.encryptionVersion,
    kind: record.kind,
    reference: record.reference,
    status: record.status,
  };
}

function parseVaultPolicy(value: unknown): VaultPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SecureStorageError('secure_storage_corrupt', 'The vault policy is malformed.');
  }
  const candidate = value as Record<string, unknown>;
  const idleTimeoutSeconds = candidate['idleTimeoutSeconds'];
  const lockOnSleep = candidate['lockOnSleep'];
  if (!(idleTimeoutSeconds === null || isNonNegativeInteger(idleTimeoutSeconds)) || typeof lockOnSleep !== 'boolean') {
    throw new SecureStorageError('secure_storage_corrupt', 'The vault policy is malformed.');
  }
  return { idleTimeoutSeconds, lockOnSleep };
}

function isMissingFileError(cause: unknown): boolean {
  return (
    typeof cause === 'object' && cause !== null && 'code' in cause && (cause as { code?: unknown }).code === 'ENOENT'
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
