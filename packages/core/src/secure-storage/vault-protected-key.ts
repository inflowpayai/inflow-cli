import type { Buffer } from 'node:buffer';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { SecureStorageError } from './errors.js';
import {
  createVaultPeerVerificationConfig,
  verifyVaultNativeModule,
  verifyVaultPeerVerificationConfig,
} from './vault-peer-verifier.js';
import { runtimeRequire } from './runtime-require.js';
import { vaultRecordAad, type EncryptedVaultRecordPayload, type VaultRecordEncryptionContext } from './vault-crypto.js';

declare const __VAULT_PEER_NATIVE_SHA256__: string | undefined;

interface VaultSecureMemoryModule {
  createProtectedKey(bytes: Uint8Array): object;
  decryptRecord(
    handle: object,
    authenticatedData: Uint8Array,
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    tag: Uint8Array,
  ): Buffer;
  deriveVaultWrappingKey?(unlockFactor: Uint8Array, salt: Uint8Array): Buffer;
  destroyProtectedKey(handle: object): void;
  encryptRecord(handle: object, authenticatedData: Uint8Array, plaintext: Uint8Array): EncryptedVaultRecordPayload;
  hardenProcess(): void;
}

export function deriveVaultWrappingKey(unlockFactor: Uint8Array, salt: Uint8Array): Buffer {
  try {
    const native = loadSecureMemoryModule();
    if (native.deriveVaultWrappingKey === undefined) {
      throw new Error('Native vault key derivation is unavailable.');
    }
    return native.deriveVaultWrappingKey(unlockFactor, salt);
  } catch (cause) {
    throw new SecureStorageError('secure_storage_unavailable', 'Vault key derivation is unavailable.', { cause });
  }
}

export class ProtectedVaultKey {
  private handle: object | undefined;

  constructor(
    bytes: Uint8Array,
    private readonly native: VaultSecureMemoryModule = loadSecureMemoryModule(),
  ) {
    try {
      this.handle = native.createProtectedKey(bytes);
    } catch (cause) {
      throw new SecureStorageError('secure_storage_unavailable', 'Vault protected memory is unavailable.', { cause });
    } finally {
      bytes.fill(0);
    }
  }

  decrypt(context: VaultRecordEncryptionContext, encrypted: EncryptedVaultRecordPayload): Buffer {
    const handle = this.requireHandle();
    try {
      return this.native.decryptRecord(
        handle,
        vaultRecordAad(context),
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.tag,
      );
    } catch (cause) {
      if (nativeErrorCode(cause) === 'EAUTH') {
        throw new SecureStorageError('secure_storage_corrupt', 'Vault record could not be decrypted.', { cause });
      }
      throw new SecureStorageError('secure_storage_unavailable', 'Vault protected cryptography is unavailable.', {
        cause,
      });
    }
  }

  destroy(): void {
    if (this.handle === undefined) return;
    try {
      this.native.destroyProtectedKey(this.handle);
    } finally {
      this.handle = undefined;
    }
  }

  encrypt(context: VaultRecordEncryptionContext, payload: Uint8Array): EncryptedVaultRecordPayload {
    const handle = this.requireHandle();
    try {
      return this.native.encryptRecord(handle, vaultRecordAad(context), payload);
    } catch (cause) {
      throw new SecureStorageError('secure_storage_unavailable', 'Vault protected cryptography is unavailable.', {
        cause,
      });
    }
  }

  private requireHandle(): object {
    if (this.handle === undefined) {
      throw new SecureStorageError('vault_locked', 'The InFlow vault is locked.');
    }
    return this.handle;
  }
}

export function hardenVaultDaemonProcess(native: VaultSecureMemoryModule = loadSecureMemoryModule()): void {
  try {
    native.hardenProcess();
  } catch (cause) {
    throw new SecureStorageError('secure_storage_unavailable', 'Vault process hardening is unavailable.', { cause });
  }
}

function loadSecureMemoryModule(): VaultSecureMemoryModule {
  if (process.platform === 'win32') {
    if (typeof __VAULT_PEER_NATIVE_SHA256__ !== 'string') {
      throw new SecureStorageError('secure_storage_unavailable', 'Vault native module integrity is unavailable.');
    }
    const nativeModulePath = resolve(dirname(process.execPath), 'native', 'vault_peer_windows.node');
    verifyVaultNativeModule(nativeModulePath, {
      expectedSha256: __VAULT_PEER_NATIVE_SHA256__,
      expectedTeamId: '',
      requireSignature: false,
    });
    return runtimeRequire()(nativeModulePath) as VaultSecureMemoryModule;
  }
  const config = createVaultPeerVerificationConfig();
  verifyVaultPeerVerificationConfig(config);
  // The integrity-verified native module supplies this internal CommonJS boundary.
  return runtimeRequire()(config.nativeModulePath) as VaultSecureMemoryModule;
}

function nativeErrorCode(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
  return typeof cause.code === 'string' ? cause.code : undefined;
}
