import { describe, expect, it, vi } from 'vitest';
import { InflowApiError } from '../../../src/errors.js';
import { probeAuthStatus } from '../../../src/flows/auth-status.js';
import type { IUserResource } from '../../../src/resources/interfaces.js';
import type { AuthTokens, User } from '../../../src/types/index.js';
import { MemoryStorage } from '../../../src/utils/storage.js';

const sampleUser: User = {
  userId: 'u-1',
  email: 'ada@example.test',
  firstName: null,
  lastName: null,
  username: null,
  mobile: null,
  locale: 'EN_US',
  timezone: 'UTC',
  created: '2026-01-01T00:00:00Z',
  updated: '2026-01-01T00:00:00Z',
};

const sampleTokens: AuthTokens = {
  access_token: 'aaaaaaaaaaaaaaaaaaaaaa',
  refresh_token: 'r',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: Date.now() + 3600 * 1000,
};

function userResource(retrieve: () => Promise<User>): IUserResource {
  return { retrieve: vi.fn(retrieve) };
}

describe('probeAuthStatus', () => {
  it('returns unauthenticated when storage has no credentials', async () => {
    const result = await probeAuthStatus({
      authStorage: new MemoryStorage(),
      userResource: userResource(() => Promise.resolve(sampleUser)),
    });
    expect(result.kind).toBe('unauthenticated');
  });

  it('returns pending when a device flow is in flight', async () => {
    const storage = new MemoryStorage();
    storage.setPendingDeviceAuth({
      device_code: 'dc',
      interval: 5,
      expires_at: Date.now() + 60_000,
      verification_url: 'https://example.test',
      phrase: 'WXYZ',
    });
    const result = await probeAuthStatus({
      authStorage: storage,
      userResource: userResource(() => Promise.resolve(sampleUser)),
    });
    expect(result.kind).toBe('pending');
  });

  it('returns authenticated with the user when retrieval succeeds', async () => {
    const storage = new MemoryStorage(sampleTokens);
    const result = await probeAuthStatus({
      authStorage: storage,
      userResource: userResource(() => Promise.resolve(sampleUser)),
    });
    expect(result.kind).toBe('authenticated');
    if (result.kind === 'authenticated') {
      expect(result.user).toEqual(sampleUser);
      expect(result.frame.authenticated).toBe(true);
    }
  });

  it('returns invalid with a recovery note when the user retrieve 401s for a device token', async () => {
    const storage = new MemoryStorage(sampleTokens);
    const result = await probeAuthStatus({
      authStorage: storage,
      userResource: userResource(() =>
        Promise.reject(new InflowApiError('Unauthorized', { status: 401, code: 'unauthorized' })),
      ),
    });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.frame['probed_invalid']).toBe(true);
      expect(String(result.frame['note'])).toContain('Local token failed server validation');
    }
  });

  it('uses the api-key wording on 401 when the active method is an api key', async () => {
    const storage = new MemoryStorage();
    storage.setApiKey('inflow_old_key');
    const result = await probeAuthStatus({
      authStorage: storage,
      userResource: userResource(() =>
        Promise.reject(new InflowApiError('Unauthorized', { status: 401, code: 'unauthorized' })),
      ),
    });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(String(result.frame['note'])).toContain('API key failed server validation');
    }
  });

  it('returns error for non-401 retrieval failures', async () => {
    const storage = new MemoryStorage(sampleTokens);
    const boom = new Error('network down');
    const result = await probeAuthStatus({
      authStorage: storage,
      userResource: userResource(() => Promise.reject(boom)),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error).toBe(boom);
    }
  });
});
