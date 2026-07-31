import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { SecureStorageError } from './errors.js';
import { deriveVaultWrappingKey } from './vault-protected-key.js';
import {
  vaultRecordStatusCode,
  vaultSecretKindCode,
  type VaultRecordStatus,
  type VaultSecretKind,
} from './vault-types.js';

export interface VaultHeader {
  material: Buffer;
  nonce: Buffer;
  salt: Buffer;
  tag: Buffer;
}

export interface EncryptedVaultRecordPayload {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
}

export interface VaultRecordEncryptionContext {
  encryptionVersion: number;
  kind: VaultSecretKind;
  reference: string;
  status: VaultRecordStatus;
}

export interface WrappedVaultMaterial {
  header: Buffer;
  masterKey: Buffer;
}

export const VAULT_MASTER_KEY_BYTES = 32;
export const VAULT_SIDECAR_BYTES = 76;
export const VAULT_SALT_BYTES = 16;
export const VAULT_UNLOCK_FACTOR_MIN_BYTES = 6;

const HEADER_NONCE_BYTES = 12;
const HEADER_TAG_BYTES = 16;
const HEADER_AAD = Buffer.from('inflow-vault-header-v1', 'utf8');

export function assertUnlockFactor(value: Uint8Array): void {
  if (value.byteLength < VAULT_UNLOCK_FACTOR_MIN_BYTES) {
    throw new SecureStorageError('secure_storage_invalid_path', 'PIN or passphrase must be at least 6 characters.');
  }
}

export function createVaultMaterial(unlockFactor: Uint8Array): WrappedVaultMaterial {
  assertUnlockFactor(unlockFactor);
  const salt = randomBytes(VAULT_SALT_BYTES);
  const wrappingKey = deriveWrappingKey(unlockFactor, salt);
  try {
    return createVaultMaterialWithWrappingKey(wrappingKey, salt);
  } finally {
    wrappingKey.fill(0);
  }
}

export function unwrapVaultMaterial(headerBytes: Uint8Array, unlockFactor: Uint8Array): Buffer {
  assertUnlockFactor(unlockFactor);
  const header = decodeVaultHeader(headerBytes);
  const wrappingKey = deriveWrappingKey(unlockFactor, header.salt);
  try {
    return unwrapVaultMaterialWithWrappingKey(headerBytes, wrappingKey);
  } finally {
    wrappingKey.fill(0);
  }
}

export function changeVaultUnlockFactor(
  headerBytes: Uint8Array,
  currentUnlockFactor: Uint8Array,
  nextUnlockFactor: Uint8Array,
): Buffer {
  if (equalBytes(currentUnlockFactor, nextUnlockFactor)) {
    throw new SecureStorageError(
      'secure_storage_invalid_path',
      'The new vault PIN or passphrase must differ from the current one.',
    );
  }
  const masterKey = unwrapVaultMaterial(headerBytes, currentUnlockFactor);
  let wrappingKey: Buffer | undefined;
  try {
    assertUnlockFactor(nextUnlockFactor);
    const salt = randomBytes(VAULT_SALT_BYTES);
    wrappingKey = deriveWrappingKey(nextUnlockFactor, salt);
    return encodeVaultHeader(encryptMaterial(masterKey, wrappingKey, salt));
  } finally {
    masterKey.fill(0);
    wrappingKey?.fill(0);
  }
}

export function createVaultMaterialWithWrappingKey(wrappingKey: Uint8Array, salt: Uint8Array): WrappedVaultMaterial {
  assertWrappingMaterial(wrappingKey, salt);
  const masterKey = randomBytes(VAULT_MASTER_KEY_BYTES);
  try {
    return {
      header: encodeVaultHeader(encryptMaterial(masterKey, wrappingKey, salt)),
      masterKey,
    };
  } catch (cause) {
    masterKey.fill(0);
    throw cause;
  }
}

export function unwrapVaultMaterialWithWrappingKey(headerBytes: Uint8Array, wrappingKey: Uint8Array): Buffer {
  if (wrappingKey.byteLength !== VAULT_MASTER_KEY_BYTES) {
    throw new SecureStorageError('secure_storage_invalid_path', 'Vault wrapping key is malformed.');
  }
  const header = decodeVaultHeader(headerBytes);
  try {
    const decipher = createDecipheriv('aes-256-gcm', wrappingKey, header.nonce);
    decipher.setAAD(HEADER_AAD);
    decipher.setAuthTag(header.tag);
    return Buffer.concat([decipher.update(header.material), decipher.final()]);
  } catch (cause) {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault material could not be unwrapped.', { cause });
  }
}

export function changeVaultWrappingKey(
  headerBytes: Uint8Array,
  currentWrappingKey: Uint8Array,
  nextWrappingKey: Uint8Array,
  nextSalt: Uint8Array,
): Buffer {
  assertWrappingMaterial(nextWrappingKey, nextSalt);
  const masterKey = unwrapVaultMaterialWithWrappingKey(headerBytes, currentWrappingKey);
  try {
    return encodeVaultHeader(encryptMaterial(masterKey, nextWrappingKey, nextSalt));
  } finally {
    masterKey.fill(0);
  }
}

export function encodeVaultHeader(header: VaultHeader): Buffer {
  if (
    header.salt.byteLength !== VAULT_SALT_BYTES ||
    header.nonce.byteLength !== HEADER_NONCE_BYTES ||
    header.tag.byteLength !== HEADER_TAG_BYTES ||
    header.material.byteLength !== VAULT_MASTER_KEY_BYTES
  ) {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault header fields have unexpected lengths.');
  }
  return Buffer.concat([header.salt, header.nonce, header.tag, header.material]);
}

export function decodeVaultHeader(headerBytes: Uint8Array): VaultHeader {
  if (headerBytes.byteLength !== VAULT_SIDECAR_BYTES) {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault header has an unexpected length.');
  }
  const bytes = Buffer.from(headerBytes);
  return {
    salt: bytes.subarray(0, VAULT_SALT_BYTES),
    nonce: bytes.subarray(VAULT_SALT_BYTES, VAULT_SALT_BYTES + HEADER_NONCE_BYTES),
    tag: bytes.subarray(
      VAULT_SALT_BYTES + HEADER_NONCE_BYTES,
      VAULT_SALT_BYTES + HEADER_NONCE_BYTES + HEADER_TAG_BYTES,
    ),
    material: bytes.subarray(VAULT_SALT_BYTES + HEADER_NONCE_BYTES + HEADER_TAG_BYTES),
  };
}

function deriveWrappingKey(unlockFactor: Uint8Array, salt: Uint8Array): Buffer {
  return deriveVaultWrappingKey(unlockFactor, salt);
}

function assertWrappingMaterial(wrappingKey: Uint8Array, salt: Uint8Array): void {
  if (wrappingKey.byteLength !== VAULT_MASTER_KEY_BYTES || salt.byteLength !== VAULT_SALT_BYTES) {
    throw new SecureStorageError('secure_storage_invalid_path', 'Vault wrapping material is malformed.');
  }
}

function encryptMaterial(masterKey: Uint8Array, wrappingKey: Uint8Array, salt: Uint8Array): VaultHeader {
  const nonce = randomBytes(HEADER_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce);
  cipher.setAAD(HEADER_AAD);
  const material = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  return {
    material,
    nonce,
    salt: Buffer.from(salt),
    tag: cipher.getAuthTag(),
  };
}

export function vaultRecordAad(context: VaultRecordEncryptionContext): Buffer {
  return Buffer.from(
    JSON.stringify({
      encryption_version: context.encryptionVersion,
      kind: vaultSecretKindCode(context.kind),
      reference: context.reference,
      status: vaultRecordStatusCode(context.status),
    }),
    'utf8',
  );
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
