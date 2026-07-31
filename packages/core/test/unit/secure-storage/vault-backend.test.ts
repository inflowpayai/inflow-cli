import { describe, expect, it } from 'vitest';
import { DEFAULT_VAULT_POLICY, VAULT_BACKEND_METHODS } from '../../../src/secure-storage/vault-backend.js';
import type { VaultBackend } from '../../../src/secure-storage/vault-backend.js';

describe('VaultBackend contract', () => {
  it('keeps the interface generic and protocol-free', () => {
    const methods = VAULT_BACKEND_METHODS satisfies readonly (keyof VaultBackend)[];

    expect(methods).toContain('changePassphrase');
    expect(methods).toContain('reset');
    expect(methods).not.toContain('sign' as keyof VaultBackend);
    expect(methods).not.toContain('fetch' as keyof VaultBackend);
    expect(methods).not.toContain('aepGrant' as keyof VaultBackend);
    expect(methods).not.toContain('mppPay' as keyof VaultBackend);
    expect(methods).not.toContain('x402Pay' as keyof VaultBackend);
  });

  it('models the default policy fields without user or protocol ownership', () => {
    expect(DEFAULT_VAULT_POLICY).toEqual({
      idleTimeoutSeconds: 28_800,
      lockOnSleep: true,
    });
  });
});
