import { randomUUID } from 'node:crypto';
import { SecureStorageError } from './errors.js';

export type VaultSecretKind =
  'auth_access_token' | 'auth_refresh_token' | 'inflow_api_key' | 'pending_device_code' | 'aep_credential';

export type VaultRecordStatus = 'active' | 'pending' | 'deleting';

export interface VaultSecretReference {
  reference: string;
}

const VAULT_REFERENCE_PREFIX = 'vlt_';

const SECRET_KIND_CODES = {
  auth_access_token: 1,
  auth_refresh_token: 2,
  inflow_api_key: 3,
  pending_device_code: 4,
  aep_credential: 5,
} as const satisfies Record<VaultSecretKind, number>;

const SECRET_KIND_NAMES = new Map<number, VaultSecretKind>(
  Object.entries(SECRET_KIND_CODES).map(([name, code]) => [code, name as VaultSecretKind]),
);

const RECORD_STATUS_CODES = {
  active: 1,
  pending: 2,
  deleting: 3,
} as const satisfies Record<VaultRecordStatus, number>;

const RECORD_STATUS_NAMES = new Map<number, VaultRecordStatus>(
  Object.entries(RECORD_STATUS_CODES).map(([name, code]) => [code, name as VaultRecordStatus]),
);

export function createVaultSecretReference(): VaultSecretReference {
  return { reference: `${VAULT_REFERENCE_PREFIX}${randomUUID().replaceAll('-', '')}` };
}

export function parseVaultSecretReference(reference: string): VaultSecretReference {
  if (!reference.startsWith(VAULT_REFERENCE_PREFIX) || reference.length !== VAULT_REFERENCE_PREFIX.length + 32) {
    throw new SecureStorageError('secure_storage_invalid_path', 'Vault secret reference is malformed.');
  }
  const suffix = reference.slice(VAULT_REFERENCE_PREFIX.length);
  if (!/^[0-9a-f]{32}$/.test(suffix)) {
    throw new SecureStorageError('secure_storage_invalid_path', 'Vault secret reference is malformed.');
  }
  return { reference };
}

export function vaultSecretKindCode(kind: VaultSecretKind): number {
  return SECRET_KIND_CODES[kind];
}

export function vaultSecretKindName(code: number): VaultSecretKind {
  const kind = SECRET_KIND_NAMES.get(code);
  if (kind === undefined) {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault secret kind is unknown.');
  }
  return kind;
}

export function isVaultSecretKind(value: unknown): value is VaultSecretKind {
  return typeof value === 'string' && value in SECRET_KIND_CODES;
}

export function vaultRecordStatusCode(status: VaultRecordStatus): number {
  return RECORD_STATUS_CODES[status];
}

export function vaultRecordStatusName(code: number): VaultRecordStatus {
  const status = RECORD_STATUS_NAMES.get(code);
  if (status === undefined) {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault record status is unknown.');
  }
  return status;
}
