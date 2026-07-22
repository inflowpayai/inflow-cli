import { describe, expect, it } from 'vitest';
import {
  createVaultSecretReference,
  parseVaultSecretReference,
  vaultRecordStatusCode,
  vaultRecordStatusName,
  vaultSecretKindCode,
  vaultSecretKindName,
  type VaultRecordStatus,
  type VaultSecretKind,
} from '../../../src/secure-storage/vault-types.js';

const secretKinds: readonly VaultSecretKind[] = [
  'auth_access_token',
  'auth_refresh_token',
  'inflow_api_key',
  'pending_device_code',
  'aep_credential',
];

const statuses: readonly VaultRecordStatus[] = ['active', 'pending', 'deleting'];

describe('vault type mappings', () => {
  it('creates opaque generated references without protocol metadata', () => {
    const first = createVaultSecretReference();
    const second = createVaultSecretReference();

    expect(first.reference).toMatch(/^vlt_[0-9a-f]{32}$/);
    expect(second.reference).toMatch(/^vlt_[0-9a-f]{32}$/);
    expect(first.reference).not.toBe(second.reference);
    expect(first.reference).not.toContain('aep');
    expect(first.reference).not.toContain('user');
    expect(parseVaultSecretReference(first.reference)).toEqual(first);
  });

  it('rejects malformed references', () => {
    for (const reference of ['vlt_', 'vlt_not-hex', 'auth_access_token', 'vlt_0123', `vlt_${'g'.repeat(32)}`]) {
      expect(() => parseVaultSecretReference(reference)).toThrow('Vault secret reference is malformed.');
    }
  });

  it('round-trips stable secret kind codes and rejects unknown values', () => {
    for (const [index, kind] of secretKinds.entries()) {
      const code = index + 1;
      expect(vaultSecretKindCode(kind)).toBe(code);
      expect(vaultSecretKindName(code)).toBe(kind);
    }

    expect(() => vaultSecretKindName(0)).toThrow('Vault secret kind is unknown.');
    expect(() => vaultSecretKindName(6)).toThrow('Vault secret kind is unknown.');
  });

  it('round-trips stable record status codes and rejects unknown values', () => {
    for (const [index, status] of statuses.entries()) {
      const code = index + 1;
      expect(vaultRecordStatusCode(status)).toBe(code);
      expect(vaultRecordStatusName(code)).toBe(status);
    }

    expect(() => vaultRecordStatusName(0)).toThrow('Vault record status is unknown.');
    expect(() => vaultRecordStatusName(4)).toThrow('Vault record status is unknown.');
  });
});
