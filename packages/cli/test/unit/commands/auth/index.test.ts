import {
  augmentAuth,
  type AuthStorage,
  type AuthTokens,
  type DeviceAuthRequest,
  type IAuth,
  type IAuthResource,
  InflowApiError,
  type IUserResource,
  MemoryStorage,
  type User,
} from '@inflowpayai/inflow-core';
import { describe, expect, it, vi } from 'vitest';
import { type AuthCommandContext, __testing } from '../../../../src/commands/auth/index.js';

const defaultAuthCtx: AuthCommandContext = {
  apiKey: undefined,
  apiKeySource: undefined,
  environment: 'production',
  resolvedApiBaseUrl: 'https://api.inflowpay.ai',
  verbose: false,
};

const { runAuthLogin, runAuthLogout, runAuthStatus } = __testing;

const baseRequest: DeviceAuthRequest = {
  device_code: 'dc-1',
  user_code: 'AAAA-BBBB',
  verification_url: 'https://app.inflowpay.ai/device/',
  verification_url_complete: 'https://app.inflowpay.ai/device/?code=AAAA-BBBB',
  expires_in: 600,
  interval: 5,
};

const baseTokens: AuthTokens = {
  access_token: 'new-access-token-aaaaaaaaaaaaaaaaaaaaaaaa',
  refresh_token: 'new-refresh',
  token_type: 'Bearer',
  expires_in: 3600,
};

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

interface AuthHandles {
  resource: IAuth;
  raw: IAuthResource;
  initiateDeviceAuth: ReturnType<typeof vi.fn>;
  pollDeviceAuth: ReturnType<typeof vi.fn>;
  refreshToken: ReturnType<typeof vi.fn>;
  revokeToken: ReturnType<typeof vi.fn>;
}

function makeAuthResource(
  storage: AuthStorage,
  overrides: Partial<IAuthResource> = {},
  userResource: IUserResource = { retrieve: vi.fn(() => Promise.resolve(sampleUser)) },
): AuthHandles {
  const initiateDeviceAuth = vi.fn(() => Promise.resolve(baseRequest));
  const pollDeviceAuth = vi.fn(() => Promise.resolve(null));
  const refreshToken = vi.fn();
  const revokeToken = vi.fn(() => Promise.resolve());
  const raw: IAuthResource = {
    initiateDeviceAuth,
    pollDeviceAuth,
    refreshToken,
    revokeToken,
    ...overrides,
  };
  const resource = augmentAuth(raw, userResource, storage);
  return { resource, raw, initiateDeviceAuth, pollDeviceAuth, refreshToken, revokeToken };
}

interface UserHandles {
  resource: IUserResource;
  retrieve: ReturnType<typeof vi.fn>;
}

function makeUserResource(override?: () => Promise<User>): UserHandles {
  const retrieve = vi.fn(override ?? (() => Promise.resolve(sampleUser)));
  return { resource: { retrieve }, retrieve };
}

type ErrorEmitter = (err: { code: string; message: string; retryable?: boolean }) => never;

interface MockContext<O> {
  agent: boolean;
  formatExplicit: boolean;
  options: O;
  error: ErrorEmitter;
}

function makeContext<O>(options: O, agent = true): MockContext<O> {
  const error = vi.fn<ErrorEmitter>((_err) => {
    throw new Error('c.error called');
  });
  return { agent, formatExplicit: agent, options, error };
}

async function drainGenerator<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of gen) {
    out.push(value);
  }
  return out;
}

describe('runAuthLogin (agent mode)', () => {
  it('rejects empty client-name with INVALID_INPUT', async () => {
    const ctx = makeContext({
      clientName: '   ',
      interval: 0,
      maxAttempts: 0,
      timeout: 300,
    });
    const storage = new MemoryStorage();
    const auth = makeAuthResource(storage);
    const user = makeUserResource();
    await expect(
      drainGenerator(
        runAuthLogin(
          ctx,
          {
            authResource: auth.resource,
            userResource: user.resource,
            authStorage: storage,
          },
          defaultAuthCtx,
        ),
      ),
    ).rejects.toThrow('c.error called');
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('no-interval mode persists pendingDeviceAuth and yields the URL + _next hint', async () => {
    const ctx = makeContext({
      clientName: 'Test',
      interval: 0,
      maxAttempts: 0,
      timeout: 300,
    });
    const storage = new MemoryStorage();
    const auth = makeAuthResource(storage);
    const user = makeUserResource();
    const yields = await drainGenerator(
      runAuthLogin(
        ctx,
        {
          authResource: auth.resource,
          userResource: user.resource,
          authStorage: storage,
        },
        defaultAuthCtx,
      ),
    );
    expect(yields).toHaveLength(1);
    const first = yields[0] as Record<string, unknown>;
    expect(first['verification_url']).toBe(baseRequest.verification_url_complete);
    expect(first['phrase']).toBe(baseRequest.user_code);
    expect(first['_next']).toMatchObject({
      command: 'auth status --interval 5 --max-attempts 60',
    });
    expect(storage.getPendingDeviceAuth()?.device_code).toBe(baseRequest.device_code);
  });

  it('initiateDeviceAuth failure surfaces DEVICE_AUTH_INITIATE_FAILED', async () => {
    const ctx = makeContext({
      clientName: 'Test',
      interval: 0,
      maxAttempts: 0,
      timeout: 300,
    });
    const storage = new MemoryStorage();
    const auth = makeAuthResource(storage, {
      initiateDeviceAuth: vi.fn(() => Promise.reject(new Error('server down'))),
    });
    const user = makeUserResource();
    await expect(
      drainGenerator(
        runAuthLogin(
          ctx,
          {
            authResource: auth.resource,
            userResource: user.resource,
            authStorage: storage,
          },
          defaultAuthCtx,
        ),
      ),
    ).rejects.toThrow('c.error called');
    expect(ctx.error).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'DEVICE_AUTH_INITIATE_FAILED',
        message: 'server down',
      }),
    );
  });

  it('with-interval mode yields the prologue then polls until authenticated', async () => {
    const ctx = makeContext({
      clientName: 'Test',
      interval: 0.01,
      maxAttempts: 5,
      timeout: 60,
    });
    const storage = new MemoryStorage();
    const pollSequence: Array<AuthTokens | null> = [null, baseTokens];
    const auth = makeAuthResource(storage, {
      pollDeviceAuth: vi.fn(() => Promise.resolve(pollSequence.shift() ?? null)),
    });
    const user = makeUserResource();
    const yields = await drainGenerator(
      runAuthLogin(
        ctx,
        {
          authResource: auth.resource,
          userResource: user.resource,
          authStorage: storage,
        },
        defaultAuthCtx,
      ),
    );
    expect(yields.length).toBeGreaterThanOrEqual(2);
    const last = yields[yields.length - 1] as { authenticated: boolean };
    expect(last.authenticated).toBe(true);
    expect(storage.getAuth()?.access_token).toBe(baseTokens.access_token);
  });

  it('with-interval expired_token yields denial frame then surfaces EXPIRED_TOKEN', async () => {
    const ctx = makeContext({
      clientName: 'Test',
      interval: 0.01,
      maxAttempts: 5,
      timeout: 60,
    });
    const storage = new MemoryStorage();
    const auth = makeAuthResource(storage, {
      pollDeviceAuth: vi.fn(() =>
        Promise.reject(
          new InflowApiError('Device code expired.', {
            status: 400,
            code: 'expired_token',
          }),
        ),
      ),
    });
    const user = makeUserResource();
    await expect(
      drainGenerator(
        runAuthLogin(
          ctx,
          {
            authResource: auth.resource,
            userResource: user.resource,
            authStorage: storage,
          },
          defaultAuthCtx,
        ),
      ),
    ).rejects.toThrow('c.error called');
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'EXPIRED_TOKEN' }));
  });
});

describe('runAuthLogout (agent mode)', () => {
  it('clears local state and revokes the refresh token', async () => {
    const ctx = makeContext({});
    const storage = new MemoryStorage({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const auth = makeAuthResource(storage);
    const result = await runAuthLogout(ctx, {
      authResource: auth.resource,
      authStorage: storage,
    });
    expect(result).toEqual({ authenticated: false });
    expect(auth.revokeToken).toHaveBeenCalledWith('r');
    expect(storage.getAuth()).toBeNull();
  });

  it('still succeeds when revokeToken rejects', async () => {
    const ctx = makeContext({});
    const storage = new MemoryStorage({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const auth = makeAuthResource(storage, {
      revokeToken: vi.fn(() => Promise.reject(new Error('network'))),
    });
    const result = await runAuthLogout(ctx, {
      authResource: auth.resource,
      authStorage: storage,
    });
    expect(result).toEqual({ authenticated: false });
    expect(storage.getAuth()).toBeNull();
  });

  it('clears api key and connection in addition to tokens (full reset)', async () => {
    const ctx = makeContext({});
    const storage = new MemoryStorage({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    storage.setApiKey('inflow_live_persisted');
    storage.setConnection({
      environment: 'sandbox',
      apiBaseUrl: 'https://dev.inflowpay.ai',
    });
    const auth = makeAuthResource(storage);
    await runAuthLogout(ctx, {
      authResource: auth.resource,
      authStorage: storage,
    });
    expect(storage.getAuth()).toBeNull();
    expect(storage.getApiKey()).toBeNull();
    expect(storage.getConnection()).toBeNull();
  });
});

describe('runAuthLogin (agent mode) — api-key save path', () => {
  it('skips the device flow and persists the api key + connection on a successful probe', async () => {
    const ctx = makeContext({
      clientName: 'Test',
      interval: 0,
      maxAttempts: 0,
      timeout: 300,
    });
    const storage = new MemoryStorage();
    const auth = makeAuthResource(storage);
    const user = makeUserResource();
    const apiKeyCtx: AuthCommandContext = {
      apiKey: 'inflow_live_runtime',
      apiKeySource: 'flag',
      environment: 'sandbox',
      apiBaseUrl: 'https://dev.inflowpay.ai',
      resolvedApiBaseUrl: 'https://dev.inflowpay.ai',
      verbose: false,
    };
    const yields = await drainGenerator(
      runAuthLogin(
        ctx,
        {
          authResource: auth.resource,
          userResource: user.resource,
          authStorage: storage,
        },
        apiKeyCtx,
      ),
    );
    expect(auth.initiateDeviceAuth).not.toHaveBeenCalled();
    expect(user.retrieve).toHaveBeenCalledTimes(1);
    expect(yields).toHaveLength(1);
    expect(yields[0]).toMatchObject({
      authenticated: true,
      method: 'api_key',
      connection: {
        environment: 'sandbox',
        apiBaseUrl: 'https://dev.inflowpay.ai',
      },
    });
    expect(storage.getApiKey()).toBe('inflow_live_runtime');
    expect(storage.getConnection()).toEqual({
      environment: 'sandbox',
      apiBaseUrl: 'https://dev.inflowpay.ai',
    });
    expect(storage.getAuth()).toBeNull();
  });

  it('does not persist the api key when the probe fails with 401 — surfaces API_KEY_REJECTED', async () => {
    const ctx = makeContext({
      clientName: 'Test',
      interval: 0,
      maxAttempts: 0,
      timeout: 300,
    });
    const storage = new MemoryStorage();
    const auth = makeAuthResource(storage);
    const user = makeUserResource(() =>
      Promise.reject(new InflowApiError('unauthorized', { status: 401, code: 'unauthorized' })),
    );
    const apiKeyCtx: AuthCommandContext = {
      apiKey: 'inflow_live_bad',
      apiKeySource: 'flag',
      environment: 'production',
      resolvedApiBaseUrl: 'https://api.inflowpay.ai',
      verbose: false,
    };
    await expect(
      drainGenerator(
        runAuthLogin(
          ctx,
          {
            authResource: auth.resource,
            userResource: user.resource,
            authStorage: storage,
          },
          apiKeyCtx,
        ),
      ),
    ).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'API_KEY_REJECTED' }));
    expect(storage.getApiKey()).toBeNull();
    expect(storage.getConnection()).toBeNull();
  });

  it('clears a prior device token when the api-key save path lands', async () => {
    const ctx = makeContext({
      clientName: 'Test',
      interval: 0,
      maxAttempts: 0,
      timeout: 300,
    });
    const storage = new MemoryStorage({
      access_token: 'old-token',
      refresh_token: 'old-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const auth = makeAuthResource(storage);
    const user = makeUserResource();
    const apiKeyCtx: AuthCommandContext = {
      apiKey: 'inflow_live_new',
      apiKeySource: 'flag',
      environment: 'production',
      resolvedApiBaseUrl: 'https://api.inflowpay.ai',
      verbose: false,
    };
    await drainGenerator(
      runAuthLogin(
        ctx,
        {
          authResource: auth.resource,
          userResource: user.resource,
          authStorage: storage,
        },
        apiKeyCtx,
      ),
    );
    expect(storage.getAuth()).toBeNull();
    expect(storage.getApiKey()).toBe('inflow_live_new');
  });
});

describe('runAuthStatus (agent mode)', () => {
  it('yields { authenticated: false } when storage is empty', async () => {
    const ctx = makeContext({
      interval: 0,
      maxAttempts: 0,
      timeout: 60,
      probe: false,
    });
    const storage = new MemoryStorage();
    const auth = makeAuthResource(storage);
    const user = makeUserResource();
    const yields = await drainGenerator(
      runAuthStatus(
        ctx,
        {
          authResource: auth.resource,
          userResource: user.resource,
          authStorage: storage,
          updateProbe: undefined,
        },
        defaultAuthCtx,
      ),
    );
    expect(yields[0]).toMatchObject({
      authenticated: false,
    });
    expect(yields[0]).not.toHaveProperty('credentials_path');
  });

  it('includes credentials_path in the agent payload when ctx.verbose=true', async () => {
    const ctx = makeContext({
      interval: 0,
      maxAttempts: 0,
      timeout: 60,
      probe: false,
    });
    const storage = new MemoryStorage();
    const auth = makeAuthResource(storage);
    const user = makeUserResource();
    const yields = await drainGenerator(
      runAuthStatus(
        ctx,
        {
          authResource: auth.resource,
          userResource: user.resource,
          authStorage: storage,
          updateProbe: undefined,
        },
        { ...defaultAuthCtx, verbose: true },
      ),
    );
    expect(yields[0]).toMatchObject({
      authenticated: false,
      credentials_path: 'memory',
    });
  });

  it('yields { authenticated: true } with the access-token preview', async () => {
    const ctx = makeContext({
      interval: 0,
      maxAttempts: 0,
      timeout: 60,
      probe: false,
    });
    const storage = new MemoryStorage({
      access_token: 'access-token-aaaaaaaaaaaaaaaaaaaaaaaa',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const auth = makeAuthResource(storage);
    const user = makeUserResource();
    const yields = await drainGenerator(
      runAuthStatus(
        ctx,
        {
          authResource: auth.resource,
          userResource: user.resource,
          authStorage: storage,
          updateProbe: undefined,
        },
        defaultAuthCtx,
      ),
    );
    expect(yields[0]).toMatchObject({
      authenticated: true,
      token_type: 'Bearer',
    });
    expect((yields[0] as { access_token: string }).access_token).toMatch(/\.\.\.$/);
  });

  it('includes pending fields when a device flow is in progress', async () => {
    const ctx = makeContext({
      interval: 0,
      maxAttempts: 0,
      timeout: 60,
      probe: false,
    });
    const storage = new MemoryStorage();
    storage.setPendingDeviceAuth({
      device_code: 'dc',
      interval: 5,
      expires_at: Date.now() + 60_000,
      verification_url: 'https://example.test/device',
      phrase: 'XXXX-YYYY',
    });
    const auth = makeAuthResource(storage);
    const user = makeUserResource();
    const yields = await drainGenerator(
      runAuthStatus(
        ctx,
        {
          authResource: auth.resource,
          userResource: user.resource,
          authStorage: storage,
          updateProbe: undefined,
        },
        defaultAuthCtx,
      ),
    );
    expect(yields[0]).toMatchObject({
      authenticated: false,
      pending: true,
      verification_url: 'https://example.test/device',
      phrase: 'XXXX-YYYY',
    });
  });

  it('probe mode adds the user block on success', async () => {
    const ctx = makeContext({
      interval: 0,
      maxAttempts: 0,
      timeout: 60,
      probe: true,
    });
    const storage = new MemoryStorage({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const auth = makeAuthResource(storage);
    const user = makeUserResource();
    const yields = await drainGenerator(
      runAuthStatus(
        ctx,
        {
          authResource: auth.resource,
          userResource: user.resource,
          authStorage: storage,
          updateProbe: undefined,
        },
        defaultAuthCtx,
      ),
    );
    expect(yields[0]).toMatchObject({
      authenticated: true,
    });
    const userField = (yields[0] as { user?: { email?: string } }).user;
    expect(userField?.email).toBe('ada@example.test');
  });

  it('probe mode yields probed_invalid when retrieve returns 401', async () => {
    const ctx = makeContext({
      interval: 0,
      maxAttempts: 0,
      timeout: 60,
      probe: true,
    });
    const storage = new MemoryStorage({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const user = makeUserResource(() =>
      Promise.reject(
        new InflowApiError('unauthorized', {
          status: 401,
          code: 'unauthorized',
        }),
      ),
    );
    const auth = makeAuthResource(storage, {}, user.resource);
    const yields = await drainGenerator(
      runAuthStatus(
        ctx,
        {
          authResource: auth.resource,
          userResource: user.resource,
          authStorage: storage,
          updateProbe: undefined,
        },
        defaultAuthCtx,
      ),
    );
    expect(yields[0]).toMatchObject({
      authenticated: false,
      probed_invalid: true,
    });
  });
});
