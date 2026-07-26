import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import {
  ProtectedVaultKey,
  deriveVaultWrappingKey,
  hardenVaultDaemonProcess,
} from '../../../src/secure-storage/vault-protected-key.js';

describe('native vault key derivation', () => {
  it('matches the existing Argon2id sidecar derivation and preserves caller-owned input', () => {
    const unlockFactor = Buffer.from('compatibility-factor');
    const original = Buffer.from(unlockFactor);
    const salt = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');

    const key = deriveVaultWrappingKey(unlockFactor, salt);

    expect(key.toString('hex')).toBe('b14428c2aa1bd0af16cf37b0bbf7a52ab15df66629fb29d433808b938a3bbd00');
    expect(unlockFactor).toEqual(original);
  });
});

describe('ProtectedVaultKey', () => {
  it('moves the source bytes into native custody and clears the source', () => {
    const source = Buffer.alloc(32, 0x5a);
    const native = nativeModule();

    new ProtectedVaultKey(source, native);

    expect(source.equals(Buffer.alloc(32))).toBe(true);
    expect(native.createProtectedKey).toHaveBeenCalledOnce();
  });

  it('clears the source when native allocation fails', () => {
    const source = Buffer.alloc(32, 0x5a);
    const native = {
      ...nativeModule(),
      createProtectedKey: vi.fn((): object => {
        throw new Error('mlock failed');
      }),
    };

    expect(() => new ProtectedVaultKey(source, native)).toThrow('Vault protected memory is unavailable.');
    expect(source.equals(Buffer.alloc(32))).toBe(true);
  });

  it('destroys native custody once and rejects later operations', () => {
    const native = nativeModule();
    const key = new ProtectedVaultKey(Buffer.alloc(32), native);

    key.destroy();
    key.destroy();

    expect(native.destroyProtectedKey).toHaveBeenCalledOnce();
    expect(() => key.encrypt(recordContext, Buffer.from('secret'))).toThrow('The InFlow vault is locked.');
  });

  it('delegates record cryptography to the protected native handle', () => {
    const native = nativeModule();
    const key = new ProtectedVaultKey(Buffer.alloc(32), native);
    const payload = Buffer.from('secret');

    const encrypted = key.encrypt(recordContext, payload);
    const decrypted = key.decrypt(recordContext, encrypted);

    expect(encrypted.ciphertext).toEqual(Buffer.from('encrypted'));
    expect(decrypted).toEqual(payload);
    expect(native.encryptRecord).toHaveBeenCalledOnce();
    expect(native.decryptRecord).toHaveBeenCalledOnce();
  });

  it('maps native authentication rejection to corrupt storage', () => {
    const native = {
      ...nativeModule(),
      decryptRecord: vi.fn((): Buffer => {
        throw Object.assign(new Error('authentication failed'), { code: 'EAUTH' });
      }),
    };
    const key = new ProtectedVaultKey(Buffer.alloc(32), native);

    expect(() =>
      key.decrypt(recordContext, {
        ciphertext: Buffer.from('encrypted'),
        nonce: Buffer.alloc(12),
        tag: Buffer.alloc(16),
      }),
    ).toThrow('Vault record could not be decrypted.');
  });

  it('fails closed when native process hardening fails', () => {
    const native = {
      ...nativeModule(),
      hardenProcess: vi.fn((): void => {
        throw new Error('setrlimit failed');
      }),
    };

    expect(() => hardenVaultDaemonProcess(native)).toThrow('Vault process hardening is unavailable.');
  });
});

const recordContext = {
  encryptionVersion: 1,
  kind: 'inflow_api_key',
  reference: 'vlt_00000000000040008000000000000000',
  status: 'active',
} as const;

function nativeModule() {
  return {
    createProtectedKey: vi.fn(() => ({})),
    decryptRecord: vi.fn((_handle: object, _aad: Uint8Array, ciphertext: Uint8Array) =>
      Buffer.from(Buffer.from(ciphertext).equals(Buffer.from('encrypted')) ? 'secret' : ''),
    ),
    destroyProtectedKey: vi.fn(),
    encryptRecord: vi.fn(() => ({
      ciphertext: Buffer.from('encrypted'),
      nonce: Buffer.alloc(12),
      tag: Buffer.alloc(16),
    })),
    hardenProcess: vi.fn(),
  };
}
