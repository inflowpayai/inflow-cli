import { describe, expect, it, vi } from 'vitest';
import { InflowApiError } from '../../../src/errors.js';
import { reduceAuthLoginApiKey, runAuthLoginApiKey } from '../../../src/flows/auth-login-api-key.js';
import type { IUserResource } from '../../../src/resources/interfaces.js';
import type { User } from '../../../src/types/index.js';
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

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iterable) out.push(v);
  return out;
}

describe('reduceAuthLoginApiKey', () => {
  it('validating + validated -> saved with user', () => {
    expect(reduceAuthLoginApiKey({ kind: 'validating' }, { type: 'validated', user: sampleUser })).toEqual({
      kind: 'saved',
      user: sampleUser,
    });
  });

  it('validating + failed -> failed with message', () => {
    expect(reduceAuthLoginApiKey({ kind: 'validating' }, { type: 'failed', message: 'oops' })).toEqual({
      kind: 'failed',
      message: 'oops',
    });
  });
});

describe('runAuthLoginApiKey', () => {
  it('preserves the current account when validation rejects with a non-Error value', async () => {
    const storage = new MemoryStorage();
    storage.setApiKey('existing-key');
    storage.setConnection({ environment: 'production' });
    const run = runAuthLoginApiKey({
      apiKey: 'replacement-key',
      authStorage: storage,
      userResource: { retrieve: vi.fn().mockRejectedValue('transport unavailable') },
      connection: { environment: 'sandbox' },
    });
    expect(await drain(run.events)).toEqual([{ type: 'failed', message: 'transport unavailable' }]);
    expect(storage.getApiKey()).toBe('existing-key');
    expect(storage.getConnection()).toEqual({ environment: 'production' });
  });
  it('emits validated and persists the api key + connection on success', async () => {
    const storage = new MemoryStorage();
    const userResource: IUserResource = { retrieve: vi.fn().mockResolvedValue(sampleUser) };
    const run = runAuthLoginApiKey({
      apiKey: 'inflow_test_key',
      authStorage: storage,
      userResource,
      connection: { environment: 'sandbox' },
    });
    const events = await drain(run.events);
    expect(events).toEqual([{ type: 'validated', user: sampleUser }]);
    expect(storage.getApiKey()).toBe('inflow_test_key');
    expect(storage.getConnection()).toEqual({ environment: 'sandbox' });
  });

  it('clears prior device tokens before saving the api key', async () => {
    const storage = new MemoryStorage({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const userResource: IUserResource = { retrieve: vi.fn().mockResolvedValue(sampleUser) };
    const run = runAuthLoginApiKey({
      apiKey: 'inflow_test_key',
      authStorage: storage,
      userResource,
      connection: { environment: 'sandbox' },
    });
    await drain(run.events);
    expect(storage.getAuth()).toBeNull();
    expect(storage.getApiKey()).toBe('inflow_test_key');
  });

  it('emits failed with the 401 message when the api key is rejected', async () => {
    const storage = new MemoryStorage();
    const userResource: IUserResource = {
      retrieve: vi.fn().mockRejectedValue(new InflowApiError('Unauthorized', { status: 401, code: 'unauthorized' })),
    };
    const run = runAuthLoginApiKey({
      apiKey: 'inflow_bad_key',
      authStorage: storage,
      userResource,
      connection: { environment: 'sandbox' },
    });
    const events = await drain(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('failed');
    expect((events[0] as { message: string }).message).toContain('HTTP 401');
    expect(storage.getApiKey()).toBeNull();
  });

  it('emits failed with the raw error message for non-401 errors', async () => {
    const userResource: IUserResource = {
      retrieve: vi.fn().mockRejectedValue(new Error('network down')),
    };
    const run = runAuthLoginApiKey({
      apiKey: 'inflow_test_key',
      authStorage: new MemoryStorage(),
      userResource,
      connection: { environment: 'sandbox' },
    });
    const events = await drain(run.events);
    expect(events).toEqual([{ type: 'failed', message: 'network down' }]);
  });
});
