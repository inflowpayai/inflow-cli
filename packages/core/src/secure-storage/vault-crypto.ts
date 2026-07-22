import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashRaw } from '@node-rs/argon2';
import { SecureStorageError } from './errors.js';
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

export interface VaultKeys {
  databaseKey: Buffer;
  recordKey: Buffer;
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
export const VAULT_UNLOCK_FACTOR_MIN_BYTES = 6;

const ARGON2_MEMORY_COST_KIB = 64 * 1024;
const ARGON2_OUTPUT_BYTES = 32;
const ARGON2_PARALLELISM = 1;
const ARGON2_TIME_COST = 3;
const ARGON2ID_ALGORITHM = 2;
const ARGON2_VERSION_13 = 1;
const HEADER_SALT_BYTES = 16;
const HEADER_NONCE_BYTES = 12;
const HEADER_TAG_BYTES = 16;
const RECORD_NONCE_BYTES = 12;
const HEADER_AAD = Buffer.from('inflow-vault-header-v1', 'utf8');
const RECORD_KEY_LABEL = Buffer.from('inflow vault record encryption', 'utf8');
const SQLITE_KEY_LABEL = Buffer.from('inflow sqlite database encryption', 'utf8');
const WRAPPING_LABEL = Buffer.from('inflow vault material wrapping', 'utf8');

export function assertUnlockFactor(value: Uint8Array): void {
  if (value.byteLength < VAULT_UNLOCK_FACTOR_MIN_BYTES) {
    throw new SecureStorageError('secure_storage_invalid_path', 'PIN or passphrase must be at least 6 characters.');
  }
}

export async function createVaultMaterial(unlockFactor: Uint8Array): Promise<WrappedVaultMaterial> {
  assertUnlockFactor(unlockFactor);
  const masterKey = randomBytes(VAULT_MASTER_KEY_BYTES);
  const salt = randomBytes(HEADER_SALT_BYTES);
  const wrappingKey = await deriveWrappingKey(unlockFactor, salt);
  const encrypted = encryptMaterial(masterKey, wrappingKey, salt);
  return {
    header: encodeVaultHeader(encrypted),
    masterKey,
  };
}

export async function unwrapVaultMaterial(headerBytes: Uint8Array, unlockFactor: Uint8Array): Promise<Buffer> {
  assertUnlockFactor(unlockFactor);
  const header = decodeVaultHeader(headerBytes);
  const wrappingKey = await deriveWrappingKey(unlockFactor, header.salt);
  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, header.nonce);
  decipher.setAAD(HEADER_AAD);
  decipher.setAuthTag(header.tag);
  try {
    return Buffer.concat([decipher.update(header.material), decipher.final()]);
  } catch (cause) {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault material could not be unwrapped.', { cause });
  }
}

export async function changeVaultUnlockFactor(
  headerBytes: Uint8Array,
  currentUnlockFactor: Uint8Array,
  nextUnlockFactor: Uint8Array,
): Promise<Buffer> {
  const masterKey = await unwrapVaultMaterial(headerBytes, currentUnlockFactor);
  assertUnlockFactor(nextUnlockFactor);
  const salt = randomBytes(HEADER_SALT_BYTES);
  const wrappingKey = await deriveWrappingKey(nextUnlockFactor, salt);
  return encodeVaultHeader(encryptMaterial(masterKey, wrappingKey, salt));
}

export function deriveVaultKeys(masterKey: Uint8Array): VaultKeys {
  if (masterKey.byteLength !== VAULT_MASTER_KEY_BYTES) {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault master key has an unexpected length.');
  }
  return {
    databaseKey: deriveKey(masterKey, SQLITE_KEY_LABEL),
    recordKey: deriveKey(masterKey, RECORD_KEY_LABEL),
  };
}

export function encryptVaultRecordPayload(
  recordKey: Uint8Array,
  context: VaultRecordEncryptionContext,
  payload: Uint8Array,
): EncryptedVaultRecordPayload {
  const nonce = randomBytes(RECORD_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', recordKey, nonce);
  cipher.setAAD(vaultRecordAad(context));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

export function decryptVaultRecordPayload(
  recordKey: Uint8Array,
  context: VaultRecordEncryptionContext,
  encrypted: EncryptedVaultRecordPayload,
): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', recordKey, encrypted.nonce);
  decipher.setAAD(vaultRecordAad(context));
  decipher.setAuthTag(encrypted.tag);
  try {
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
  } catch (cause) {
    throw new SecureStorageError('secure_storage_corrupt', 'Vault record could not be decrypted.', { cause });
  }
}

export function encodeVaultHeader(header: VaultHeader): Buffer {
  if (
    header.salt.byteLength !== HEADER_SALT_BYTES ||
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
    salt: bytes.subarray(0, HEADER_SALT_BYTES),
    nonce: bytes.subarray(HEADER_SALT_BYTES, HEADER_SALT_BYTES + HEADER_NONCE_BYTES),
    tag: bytes.subarray(
      HEADER_SALT_BYTES + HEADER_NONCE_BYTES,
      HEADER_SALT_BYTES + HEADER_NONCE_BYTES + HEADER_TAG_BYTES,
    ),
    material: bytes.subarray(HEADER_SALT_BYTES + HEADER_NONCE_BYTES + HEADER_TAG_BYTES),
  };
}

async function deriveWrappingKey(unlockFactor: Uint8Array, salt: Uint8Array): Promise<Buffer> {
  const raw = await hashRaw(unlockFactor, {
    algorithm: ARGON2ID_ALGORITHM,
    memoryCost: ARGON2_MEMORY_COST_KIB,
    outputLen: ARGON2_OUTPUT_BYTES,
    parallelism: ARGON2_PARALLELISM,
    salt,
    timeCost: ARGON2_TIME_COST,
    version: ARGON2_VERSION_13,
  });
  return deriveKey(raw, WRAPPING_LABEL);
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

function deriveKey(masterKey: Uint8Array, label: Uint8Array): Buffer {
  const derived = hkdfSync('sha256', masterKey, Buffer.alloc(0), label, 32);
  return Buffer.from(derived);
}

function vaultRecordAad(context: VaultRecordEncryptionContext): Buffer {
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
