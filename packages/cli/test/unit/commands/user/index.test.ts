import {
  augmentUser,
  type AuthTokens,
  type IUser,
  type IUserResource,
  MemoryStorage,
  Inflow,
  sanitizeResource,
  type User,
} from '@inflowpayai/inflow-core';
import { describe, expect, it, vi } from 'vitest';
import { __testing } from '../../../../src/commands/user/index.js';

const { runUserGet } = __testing;

const baseTokens: AuthTokens = {
  access_token: 'a',
  refresh_token: 'r',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: Date.now() + 3600 * 1000,
};

const baseUser: User = {
  userId: 'u-1',
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  username: 'ada',
  mobile: '+1-555-0100',
  locale: 'EN_US',
  timezone: 'US/Pacific',
  created: '2025-08-12T18:24:31.501Z',
  updated: '2026-05-24T16:08:09.221Z',
};

function makeInflow(opts: { storage: MemoryStorage; apiKey?: string }): Inflow {
  return new Inflow({
    authStorage: opts.storage,
    environment: 'sandbox',
    cliClientId: 'test',
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  });
}

type ErrorEmitter = (err: { code: string; message: string }) => never;

interface AgentCtx {
  agent: boolean;
  formatExplicit: boolean;
  error: ErrorEmitter;
}

function agentContext(): AgentCtx {
  return {
    agent: true,
    formatExplicit: true,
    error: vi.fn<ErrorEmitter>(() => {
      throw new Error('c.error called');
    }),
  };
}

function userStub(impl?: () => Promise<User>): IUserResource {
  return { retrieve: vi.fn(impl ?? (() => Promise.resolve(baseUser))) };
}

function userHandle(impl?: () => Promise<User>): IUser {
  return augmentUser(userStub(impl));
}

function expectedPayload(user: User): Omit<User, 'created' | 'updated'> {
  const { created: _c, updated: _u, ...rest } = user;
  return rest;
}

describe('runUserGet — session guard', () => {
  it('short-circuits via c.error when neither a saved token nor an api key is present', async () => {
    const ctx = agentContext();
    const storage = new MemoryStorage();
    const inflow = makeInflow({ storage });
    await expect(
      runUserGet(ctx, {
        user: userHandle(),
        authStorage: storage,
        inflow,
      }),
    ).rejects.toThrow('c.error called');
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_AUTHENTICATED' }));
  });

  it('passes when only an api key is configured (empty storage is fine)', async () => {
    const ctx = agentContext();
    const storage = new MemoryStorage();
    const inflow = makeInflow({ storage, apiKey: 'inflow_test_key' });
    const user = userStub();
    const result = await runUserGet(ctx, {
      user: augmentUser(user),
      authStorage: storage,
      inflow,
    });
    expect(result).toEqual(expectedPayload(baseUser));
    expect(ctx.error).not.toHaveBeenCalled();
  });
});

describe('runUserGet — agent mode payload', () => {
  it('returns every field except created and updated when all fields are populated', async () => {
    const ctx = agentContext();
    const storage = new MemoryStorage(baseTokens);
    const inflow = makeInflow({ storage });
    const result = await runUserGet(ctx, {
      user: userHandle(),
      authStorage: storage,
      inflow,
    });
    expect(result).toEqual(expectedPayload(baseUser));
    expect(result.firstName).toBe('Ada');
    expect(result.lastName).toBe('Lovelace');
  });

  it('drops created and updated from the agent payload', async () => {
    const ctx = agentContext();
    const storage = new MemoryStorage(baseTokens);
    const inflow = makeInflow({ storage });
    const result = await runUserGet(ctx, {
      user: userHandle(),
      authStorage: storage,
      inflow,
    });
    expect(result).not.toHaveProperty('created');
    expect(result).not.toHaveProperty('updated');
  });

  it('preserves null fields rather than stripping them from the payload', async () => {
    const sparse: User = {
      ...baseUser,
      email: null,
      firstName: null,
      lastName: null,
      username: null,
      mobile: null,
    };
    const ctx = agentContext();
    const storage = new MemoryStorage(baseTokens);
    const inflow = makeInflow({ storage });
    const result = await runUserGet(ctx, {
      user: userHandle(() => Promise.resolve(sparse)),
      authStorage: storage,
      inflow,
    });
    expect(result).toEqual(expectedPayload(sparse));
    expect(result.email).toBeNull();
    expect(result.firstName).toBeNull();
    expect(result.lastName).toBeNull();
    expect(result.username).toBeNull();
    expect(result.mobile).toBeNull();
    expect(Object.keys(result).sort()).toEqual(Object.keys(expectedPayload(baseUser)).sort());
  });

  it('strips ANSI escape sequences planted in string fields by the time the handler returns', async () => {
    const poisoned: User = {
      ...baseUser,
      firstName: '\x1b[31mAda\x1b[0m',
      lastName: '\x1b[1mLovelace\x1b[0m',
    };
    const wrapped = sanitizeResource<IUserResource>({
      retrieve: () => Promise.resolve(poisoned),
    });
    const ctx = agentContext();
    const storage = new MemoryStorage(baseTokens);
    const inflow = makeInflow({ storage });
    const result = await runUserGet(ctx, {
      user: augmentUser(wrapped),
      authStorage: storage,
      inflow,
    });
    expect(result.firstName).toBe('Ada');
    expect(result.lastName).toBe('Lovelace');
    expect(JSON.stringify(result)).not.toContain('\x1b');
  });
});
