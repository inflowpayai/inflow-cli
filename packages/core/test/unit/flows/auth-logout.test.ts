import { describe, expect, it, vi } from 'vitest';
import { runAuthLogout } from '../../../src/flows/auth-logout.js';
import type { IAuthResource } from '../../../src/resources/interfaces.js';
import type { AuthTokens } from '../../../src/types/index.js';
import { MemoryStorage } from '../../../src/utils/storage.js';

const sampleTokens: AuthTokens = {
  access_token: 'a',
  refresh_token: 'r',
  token_type: 'Bearer',
  expires_in: 3600,
};

function makeAuth(overrides: Partial<IAuthResource> = {}): IAuthResource {
  return {
    initiateDeviceAuth: vi.fn(),
    pollDeviceAuth: vi.fn(),
    refreshToken: vi.fn(),
    revokeToken: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('runAuthLogout', () => {
  it('revokes the refresh token then clears every artifact', async () => {
    const storage = new MemoryStorage(sampleTokens);
    storage.setApiKey('inflow_old_key');
    storage.setConnection({ environment: 'sandbox' });
    const revokeToken = vi.fn().mockResolvedValue(undefined);
    const auth = makeAuth({ revokeToken });

    await runAuthLogout({ authResource: auth, authStorage: storage });

    expect(revokeToken).toHaveBeenCalledWith('r');
    expect(storage.getAuth()).toBeNull();
    expect(storage.getApiKey()).toBeNull();
    expect(storage.getConnection()).toBeNull();
  });

  it('still clears local state when revokeToken throws', async () => {
    const storage = new MemoryStorage(sampleTokens);
    const auth = makeAuth({
      revokeToken: vi.fn().mockRejectedValue(new Error('network down')),
    });

    await expect(runAuthLogout({ authResource: auth, authStorage: storage })).resolves.toBeUndefined();
    expect(storage.getAuth()).toBeNull();
  });

  it('skips revokeToken when no refresh_token is present in storage', async () => {
    const storage = new MemoryStorage();
    storage.setApiKey('inflow_api_key_only');
    const revokeToken = vi.fn().mockResolvedValue(undefined);
    const auth = makeAuth({ revokeToken });

    await runAuthLogout({ authResource: auth, authStorage: storage });

    expect(revokeToken).not.toHaveBeenCalled();
    expect(storage.getApiKey()).toBeNull();
  });
});
