import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VAULT_MASTER_KEY_BYTES,
  VAULT_SIDECAR_BYTES,
  assertUnlockFactor,
  changeVaultUnlockFactor,
  createVaultMaterial,
  decodeVaultHeader,
  encodeVaultHeader,
  equalBytes,
  unwrapVaultMaterial,
  createVaultMaterialWithWrappingKey,
  unwrapVaultMaterialWithWrappingKey,
  VAULT_SALT_BYTES,
} from '../../../src/secure-storage/vault-crypto.js';

const firstFactor = Buffer.from('123456', 'utf8');
const secondFactor = Buffer.from('better-passphrase', 'utf8');

describe('vault crypto', () => {
  beforeEach(() => vi.stubGlobal('__INFLOW_DEVELOPMENT_VAULT__', true));
  afterEach(() => vi.unstubAllGlobals());

  it.each([0, 31, 33])('rejects a %s-byte wrapping key before creating or unwrapping material', (length) => {
    const key = Buffer.alloc(length);
    const salt = Buffer.alloc(VAULT_SALT_BYTES);
    expect(() => createVaultMaterialWithWrappingKey(key, salt)).toThrow('Vault wrapping material is malformed.');
    expect(() => unwrapVaultMaterialWithWrappingKey(Buffer.alloc(VAULT_SIDECAR_BYTES), key)).toThrow(
      'Vault wrapping key is malformed.',
    );
  });

  it('rejects a malformed salt and a different wrapping key without modifying caller buffers', () => {
    const key = Buffer.alloc(VAULT_MASTER_KEY_BYTES, 1);
    const salt = Buffer.alloc(VAULT_SALT_BYTES, 2);
    expect(() => createVaultMaterialWithWrappingKey(key, salt.subarray(1))).toThrow(
      'Vault wrapping material is malformed.',
    );
    const material = createVaultMaterialWithWrappingKey(key, salt);
    const before = Buffer.from(material.header);
    try {
      expect(() =>
        unwrapVaultMaterialWithWrappingKey(material.header, Buffer.alloc(VAULT_MASTER_KEY_BYTES, 3)),
      ).toThrow('Vault material could not be unwrapped.');
      expect(material.header).toEqual(before);
      expect(key).toEqual(Buffer.alloc(VAULT_MASTER_KEY_BYTES, 1));
      expect(salt).toEqual(Buffer.alloc(VAULT_SALT_BYTES, 2));
    } finally {
      material.masterKey.fill(0);
      key.fill(0);
    }
  });
  it('wraps one random 32-byte vault master key in the fixed binary sidecar', () => {
    const wrapped = createVaultMaterial(firstFactor);

    expect(wrapped.header.byteLength).toBe(VAULT_SIDECAR_BYTES);
    expect(wrapped.masterKey.byteLength).toBe(VAULT_MASTER_KEY_BYTES);
    expect(decodeVaultHeader(wrapped.header)).toMatchObject({
      material: expect.any(Buffer) as Buffer,
      nonce: expect.any(Buffer) as Buffer,
      salt: expect.any(Buffer) as Buffer,
      tag: expect.any(Buffer) as Buffer,
    });

    const unwrapped = unwrapVaultMaterial(wrapped.header, firstFactor);
    expect(equalBytes(unwrapped, wrapped.masterKey)).toBe(true);
  });

  it('rewraps material when changing the unlock factor without changing the master key', () => {
    const wrapped = createVaultMaterial(firstFactor);
    const nextHeader = changeVaultUnlockFactor(wrapped.header, firstFactor, secondFactor);

    expect(() => unwrapVaultMaterial(nextHeader, firstFactor)).toThrow('Vault material could not be unwrapped.');
    const unwrapped = unwrapVaultMaterial(nextHeader, secondFactor);
    expect(equalBytes(unwrapped, wrapped.masterKey)).toBe(true);
  });

  it('rejects an unchanged unlock factor', () => {
    const wrapped = createVaultMaterial(firstFactor);

    expect(() => changeVaultUnlockFactor(wrapped.header, firstFactor, Buffer.from(firstFactor))).toThrow(
      'The new vault PIN or passphrase must differ from the current one.',
    );
  });

  it('rejects short unlock factors', () => {
    const short = Buffer.from('12345', 'utf8');

    expect(() => assertUnlockFactor(short)).toThrow('PIN or passphrase must be at least 6 characters.');
    expect(() => createVaultMaterial(short)).toThrow('PIN or passphrase must be at least 6 characters.');
  });

  it('fails closed for malformed and tampered sidecars', () => {
    const wrapped = createVaultMaterial(firstFactor);
    const truncated = wrapped.header.subarray(0, wrapped.header.byteLength - 1);
    const tamperedTag = Buffer.from(wrapped.header);
    const tamperedMaterial = Buffer.from(wrapped.header);
    tamperedTag[30] = tamperedTag[30] === 0 ? 1 : 0;
    tamperedMaterial[tamperedMaterial.byteLength - 1] = tamperedMaterial[tamperedMaterial.byteLength - 1] === 0 ? 1 : 0;

    expect(() => decodeVaultHeader(truncated)).toThrow('Vault header has an unexpected length.');
    expect(() => unwrapVaultMaterial(tamperedTag, firstFactor)).toThrow('Vault material could not be unwrapped.');
    expect(() => unwrapVaultMaterial(tamperedMaterial, firstFactor)).toThrow('Vault material could not be unwrapped.');
  });

  it('rejects unexpected field lengths when encoding sidecars', () => {
    const header = decodeVaultHeader(Buffer.alloc(VAULT_SIDECAR_BYTES));

    expect(() =>
      encodeVaultHeader({
        ...header,
        material: Buffer.alloc(VAULT_MASTER_KEY_BYTES - 1),
      }),
    ).toThrow('Vault header fields have unexpected lengths.');
  });
});
