import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  VAULT_MASTER_KEY_BYTES,
  VAULT_SIDECAR_BYTES,
  assertUnlockFactor,
  changeVaultUnlockFactor,
  createVaultMaterial,
  decodeVaultHeader,
  deriveVaultKeys,
  encodeVaultHeader,
  equalBytes,
  unwrapVaultMaterial,
} from '../../../src/secure-storage/vault-crypto.js';

const firstFactor = Buffer.from('123456', 'utf8');
const secondFactor = Buffer.from('better-passphrase', 'utf8');

describe('vault crypto', () => {
  it('wraps one random 32-byte vault master key in the fixed binary sidecar', async () => {
    const wrapped = await createVaultMaterial(firstFactor);

    expect(wrapped.header.byteLength).toBe(VAULT_SIDECAR_BYTES);
    expect(wrapped.masterKey.byteLength).toBe(VAULT_MASTER_KEY_BYTES);
    expect(decodeVaultHeader(wrapped.header)).toMatchObject({
      material: expect.any(Buffer) as Buffer,
      nonce: expect.any(Buffer) as Buffer,
      salt: expect.any(Buffer) as Buffer,
      tag: expect.any(Buffer) as Buffer,
    });

    const unwrapped = await unwrapVaultMaterial(wrapped.header, firstFactor);
    expect(equalBytes(unwrapped, wrapped.masterKey)).toBe(true);
  });

  it('derives separate record and database keys from the unwrapped master key', async () => {
    const wrapped = await createVaultMaterial(firstFactor);
    const keys = deriveVaultKeys(await unwrapVaultMaterial(wrapped.header, firstFactor));

    expect(keys.recordKey.byteLength).toBe(32);
    expect(keys.databaseKey.byteLength).toBe(32);
    expect(equalBytes(keys.recordKey, keys.databaseKey)).toBe(false);
  });

  it('rewraps material when changing the unlock factor without changing the master key', async () => {
    const wrapped = await createVaultMaterial(firstFactor);
    const nextHeader = await changeVaultUnlockFactor(wrapped.header, firstFactor, secondFactor);

    await expect(unwrapVaultMaterial(nextHeader, firstFactor)).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_corrupt',
    });
    const unwrapped = await unwrapVaultMaterial(nextHeader, secondFactor);
    expect(equalBytes(unwrapped, wrapped.masterKey)).toBe(true);
  });

  it('rejects short unlock factors', async () => {
    const short = Buffer.from('12345', 'utf8');

    expect(() => assertUnlockFactor(short)).toThrow('PIN or passphrase must be at least 6 characters.');
    await expect(createVaultMaterial(short)).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_invalid_path',
    });
  });

  it('fails closed for malformed and tampered sidecars', async () => {
    const wrapped = await createVaultMaterial(firstFactor);
    const truncated = wrapped.header.subarray(0, wrapped.header.byteLength - 1);
    const tamperedTag = Buffer.from(wrapped.header);
    const tamperedMaterial = Buffer.from(wrapped.header);
    tamperedTag[30] = tamperedTag[30] === 0 ? 1 : 0;
    tamperedMaterial[tamperedMaterial.byteLength - 1] = tamperedMaterial[tamperedMaterial.byteLength - 1] === 0 ? 1 : 0;

    expect(() => decodeVaultHeader(truncated)).toThrow('Vault header has an unexpected length.');
    await expect(unwrapVaultMaterial(tamperedTag, firstFactor)).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_corrupt',
    });
    await expect(unwrapVaultMaterial(tamperedMaterial, firstFactor)).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_corrupt',
    });
  });

  it('rejects unexpected field lengths when encoding sidecars and master keys', () => {
    const header = decodeVaultHeader(Buffer.alloc(VAULT_SIDECAR_BYTES));

    expect(() =>
      encodeVaultHeader({
        ...header,
        material: Buffer.alloc(VAULT_MASTER_KEY_BYTES - 1),
      }),
    ).toThrow('Vault header fields have unexpected lengths.');
    expect(() => deriveVaultKeys(Buffer.alloc(VAULT_MASTER_KEY_BYTES - 1))).toThrow(
      'Vault master key has an unexpected length.',
    );
  });
});
