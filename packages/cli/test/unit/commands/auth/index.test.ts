import {
  augmentAuth,
  type AuthStorage,
  type AuthTokens,
  type ConnectionSettings,
  type DeviceAuthRequest,
  type IAuth,
  type IAuthResource,
  InflowApiError,
  type IUserResource,
  MemoryStorage,
  type PendingDeviceAuth,
  SecureStorageError,
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

class LockedStorage extends MemoryStorage {
  override getAuth(): AuthTokens | null {
    throw new SecureStorageError('vault_locked', 'The InFlow vault is locked.');
  }

  override getApiKey(): string | null {
    throw new SecureStorageError('vault_locked', 'The InFlow vault is locked.');
  }

  override getConnection(): ConnectionSettings | null {
    throw new SecureStorageError('vault_locked', 'The InFlow vault is locked.');
  }

  override getPendingDeviceAuth(): PendingDeviceAuth | null {
    throw new SecureStorageError('vault_locked', 'The InFlow vault is locked.');
  }
}

describe('runAuthLogin (agent mode)', () => {
  it('reports a polling transport failure without authenticating or discarding the pending login', async () => {
    const storage = new MemoryStorage();
    const auth = makeAuthResource(storage, {
      pollDeviceAuth: vi.fn().mockRejectedValue(new Error('Connection interrupted')),
    });
    const user = makeUserResource();
    const ctx = makeContext({ clientName: 'Test', interval: 0.001, maxAttempts: 5, timeout: 30 });
    const frames: unknown[] = [];
    const run = async () => {
      for await (const frame of runAuthLogin(
        ctx,
        {
          authResource: auth.resource,
          userResource: user.resource,
          authStorage: storage,
        },
        defaultAuthCtx,
      ))
        frames.push(frame);
    };
    await expect(run()).rejects.toThrow('c.error called');
    expect(ctx.error).toHaveBeenCalledWith({ code: 'DEVICE_AUTH_POLL_FAILED', message: 'Connection interrupted' });
    expect(frames).toEqual([
      expect.objectContaining({ verification_url: baseRequest.verification_url_complete }),
      { authenticated: false },
    ]);
    expect(storage.getAuth()).toBeNull();
    expect(storage.getPendingDeviceAuth()?.device_code).toBe(baseRequest.device_code);
    expect(user.retrieve).not.toHaveBeenCalled();
    expect(auth.revokeToken).not.toHaveBeenCalled();
  });

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

  it('unlocks the local vault before initiating device auth', async () => {
    const ctx = makeContext({
      clientName: 'Test',
      interval: 0,
      maxAttempts: 0,
      timeout: 300,
    });
    const storage = new MemoryStorage();
    const auth = makeAuthResource(storage);
    const user = makeUserResource();
    const ensureVaultUnlocked = vi.fn(() => Promise.resolve());

    await drainGenerator(
      runAuthLogin(
        ctx,
        {
          authResource: auth.resource,
          userResource: user.resource,
          authStorage: storage,
          ensureVaultUnlocked,
        },
        defaultAuthCtx,
      ),
    );

    expect(ensureVaultUnlocked).toHaveBeenCalledWith('agent');
    expect(ensureVaultUnlocked.mock.invocationCallOrder[0]).toBeLessThan(
      auth.initiateDeviceAuth.mock.invocationCallOrder[0] ?? 0,
    );
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

  it.each([0, 60])('polls until authenticated with timeout %s', async (timeout) => {
    const ctx = makeContext({
      clientName: 'Test',
      interval: 0.01,
      maxAttempts: 5,
      timeout,
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
  it.each([new Error('Logout transport failed'), 'Logout transport failed'])(
    'resets the vault before reporting a non-storage logout failure: %s',
    async (failure) => {
      const storage = new MemoryStorage(baseTokens);
      const auth = makeAuthResource(storage).resource;
      vi.spyOn(auth, 'logout').mockRejectedValue(failure);
      const resetVault = vi.fn(() => Promise.resolve());
      await expect(
        runAuthLogout(
          { agent: true, formatExplicit: true },
          {
            authResource: auth,
            authStorage: storage,
            resetVault,
          },
        ),
      ).rejects.toThrow(failure instanceof Error ? failure.message : 'The InFlow logout operation failed.');
      expect(resetVault).toHaveBeenCalledOnce();
    },
  );
  it('clears local state and revokes the refresh token', async () => {
    const ctx = makeContext({});
    const storage = new MemoryStorage({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const auth = makeAuthResource(storage);
    const resetVault = vi.fn(() => Promise.resolve());
    const result = await runAuthLogout(ctx, {
      authResource: auth.resource,
      authStorage: storage,
      resetVault,
    });
    expect(result).toEqual({ authenticated: false });
    expect(auth.revokeToken).toHaveBeenCalledWith('r');
    expect(storage.getAuth()).toBeNull();
    expect(resetVault).toHaveBeenCalledOnce();
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
    const resetVault = vi.fn(() => Promise.resolve());
    const result = await runAuthLogout(ctx, {
      authResource: auth.resource,
      authStorage: storage,
      resetVault,
    });
    expect(result).toEqual({ authenticated: false });
    expect(storage.getAuth()).toBeNull();
    expect(resetVault).toHaveBeenCalledOnce();
  });

  it('still resets the vault when stored secure material is unreadable', async () => {
    const ctx = makeContext({});
    const storage = new MemoryStorage();
    const authResource = {
      logout: vi.fn(() =>
        Promise.reject(new SecureStorageError('secure_storage_secret_missing', 'The InFlow vault is locked.')),
      ),
    } as unknown as IAuth;
    const resetVault = vi.fn(() => Promise.resolve());

    const result = await runAuthLogout(ctx, {
      authResource,
      authStorage: storage,
      resetVault,
    });

    expect(result).toEqual({ authenticated: false });
    expect(resetVault).toHaveBeenCalledOnce();
  });

  it('reports logout failure when vault cleanup cannot reach the daemon', async () => {
    const ctx = makeContext({});
    const storage = new MemoryStorage({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const auth = makeAuthResource(storage);
    const resetVault = vi.fn(() =>
      Promise.reject(new SecureStorageError('secure_storage_unavailable', 'The InFlow vault daemon did not start.')),
    );

    await expect(
      runAuthLogout(ctx, {
        authResource: auth.resource,
        authStorage: storage,
        resetVault,
      }),
    ).rejects.toMatchObject({ secureStorageCode: 'secure_storage_unavailable' });
    expect(storage.getAuth()).toBeNull();
    expect(resetVault).toHaveBeenCalledOnce();
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
      authBaseUrl: 'https://auth.example.test',
    });
    const auth = makeAuthResource(storage);
    const resetVault = vi.fn(() => Promise.resolve());
    await runAuthLogout(ctx, {
      authResource: auth.resource,
      authStorage: storage,
      resetVault,
    });
    expect(storage.getAuth()).toBeNull();
    expect(storage.getApiKey()).toBeNull();
    expect(storage.getConnection()).toBeNull();
    expect(resetVault).toHaveBeenCalledOnce();
  });
});

describe('runAuthLogin (agent mode) — api-key save path', () => {
  it.each([
    {
      maxAttempts: 1,
      timeout: 300,
      message: 'Reached the configured maximum poll attempts before authentication completed.',
    },
    { maxAttempts: 0, timeout: 1, message: 'Polling timed out before authentication completed.' },
  ])(
    'reports a retryable polling limit and retains the pending login: $message',
    async ({ maxAttempts, timeout, message }) => {
      vi.useFakeTimers();
      try {
        const storage = new MemoryStorage();
        const auth = makeAuthResource(storage);
        const context = makeContext({ clientName: 'Test', interval: 0.1, maxAttempts, timeout });
        const operation = drainGenerator(
          runAuthLogin(
            context,
            {
              authResource: auth.resource,
              userResource: makeUserResource().resource,
              authStorage: storage,
            },
            defaultAuthCtx,
          ),
        );
        const rejected = expect(operation).rejects.toThrow('c.error called');
        await vi.advanceTimersByTimeAsync(2500);
        await rejected;
        expect(context.error).toHaveBeenCalledWith({ code: 'POLLING_TIMEOUT', message, retryable: true });
        expect(storage.getAuth()).toBeNull();
        expect(storage.getPendingDeviceAuth()).toMatchObject({ device_code: baseRequest.device_code });
        expect(auth.pollDeviceAuth).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { failure: new Error('connection failed'), message: 'connection failed' },
    { failure: 'connection failed', message: 'connection failed' },
    { failure: new InflowApiError('unavailable', { status: 503, code: 'unavailable' }), message: 'unavailable' },
  ])('preserves saved authentication when key validation fails: $message', async ({ failure, message }) => {
    const storage = new MemoryStorage(baseTokens);
    storage.setApiKey('existing-key');
    const connection: ConnectionSettings = { environment: 'sandbox', apiBaseUrl: 'https://sandbox.example' };
    storage.setConnection(connection);
    const previousAuth = storage.getAuth();
    const auth = makeAuthResource(storage);
    const user = makeUserResource(vi.fn<() => Promise<User>>().mockRejectedValue(failure));
    const context = makeContext({ clientName: 'Test', interval: 0, maxAttempts: 0, timeout: 300 });
    await expect(
      drainGenerator(
        runAuthLogin(
          context,
          {
            authResource: auth.resource,
            userResource: user.resource,
            authStorage: storage,
          },
          { ...defaultAuthCtx, apiKey: 'candidate-key', apiKeySource: 'flag' },
        ),
      ),
    ).rejects.toThrow('c.error called');
    expect(context.error).toHaveBeenCalledWith({ code: 'API_KEY_VALIDATION_FAILED', message });
    expect(storage.getAuth()).toEqual(previousAuth);
    expect(storage.getApiKey()).toBe('existing-key');
    expect(storage.getConnection()).toEqual(connection);
    expect(auth.initiateDeviceAuth).not.toHaveBeenCalled();
  });

  it('reads the saved key after unlocking instead of requiring a key in the command context', async () => {
    const storage = new MemoryStorage();
    const auth = makeAuthResource(storage);
    const user = makeUserResource();
    const yields = await drainGenerator(
      runAuthLogin(
        makeContext({ clientName: 'Test', interval: 0, maxAttempts: 0, timeout: 300 }),
        {
          authResource: auth.resource,
          userResource: user.resource,
          authStorage: storage,
          ensureVaultUnlocked: () => {
            storage.setApiKey('saved-after-unlock');
            return Promise.resolve();
          },
        },
        { ...defaultAuthCtx, apiKeySource: 'saved' },
      ),
    );
    expect(auth.initiateDeviceAuth).not.toHaveBeenCalled();
    expect(user.retrieve).toHaveBeenCalledOnce();
    expect(yields[0]).toMatchObject({ authenticated: true, method: 'api_key' });
    expect(storage.getApiKey()).toBe('saved-after-unlock');
  });

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
      authBaseUrl: 'https://auth.example.test',
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
      authBaseUrl: 'https://auth.example.test',
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
  it('reports an unauthenticated environment when saved connection metadata is missing', async () => {
    const storage = new MemoryStorage();
    vi.spyOn(storage, 'getConnection').mockImplementation(() => {
      throw new SecureStorageError('secure_storage_secret_missing', 'Connection metadata is missing.');
    });
    const user = makeUserResource();
    const frames = await drainGenerator(
      runAuthStatus(
        makeContext({ interval: 0, maxAttempts: 0, timeout: 60, probe: false }),
        {
          authResource: makeAuthResource(storage).resource,
          authStorage: storage,
          userResource: user.resource,
          updateProbe: undefined,
        },
        defaultAuthCtx,
      ),
    );
    expect(frames[0]).toMatchObject({
      authenticated: false,
      connection: { environment: 'production', apiBaseUrl: 'https://api.inflowpay.ai' },
    });
    expect(user.retrieve).not.toHaveBeenCalled();
  });
  it.each(['saved', 'flag', 'env'] as const)(
    'reports the environment belonging to %s authentication without rewriting saved settings',
    async (apiKeySource) => {
      const storage = new MemoryStorage(baseTokens);
      const saved: ConnectionSettings = {
        environment: 'sandbox',
        apiBaseUrl: 'https://saved-api.example',
        authBaseUrl: 'https://saved-auth.example',
      };
      storage.setConnection(saved);
      const auth = makeAuthResource(storage);
      const user = makeUserResource();
      const runtime: AuthCommandContext = {
        ...defaultAuthCtx,
        apiKeySource,
        apiKey: 'selected-key',
        apiBaseUrl: 'https://runtime-api.example',
        authBaseUrl: 'https://runtime-auth.example',
      };
      const frames = await drainGenerator(
        runAuthStatus(
          makeContext({ interval: 0, maxAttempts: 0, timeout: 60, probe: false }),
          { authResource: auth.resource, authStorage: storage, userResource: user.resource, updateProbe: undefined },
          runtime,
        ),
      );
      expect(frames[0]).toMatchObject({
        authenticated: true,
        connection:
          apiKeySource === 'saved'
            ? saved
            : {
                environment: 'production',
                apiBaseUrl: runtime.apiBaseUrl,
                authBaseUrl: runtime.authBaseUrl,
              },
      });
      expect(storage.getConnection()).toEqual(saved);
      expect(user.retrieve).not.toHaveBeenCalled();
      expect(JSON.stringify(frames)).not.toContain('selected-key');
    },
  );

  it.each(['snapshot', 'probe', 'poll'] as const)(
    'reports a vault lock during %s without emitting an unauthenticated frame',
    async (phase) => {
      const storage = new MemoryStorage(baseTokens);
      const originalAuth = storage.getAuth();
      const getAuth = vi.spyOn(storage, 'getAuth').mockImplementation(() => {
        throw new SecureStorageError('vault_locked', 'The InFlow vault is locked.');
      });
      if (phase !== 'snapshot') getAuth.mockReturnValueOnce(originalAuth);
      const auth = makeAuthResource(storage);
      const user = makeUserResource();
      const ctx = makeContext({ interval: 0, maxAttempts: 0, timeout: 60, probe: phase === 'probe' });
      const frames: unknown[] = [];
      await expect(
        (async () => {
          for await (const frame of runAuthStatus(
            ctx,
            {
              authResource: auth.resource,
              authStorage: storage,
              userResource: user.resource,
              updateProbe: undefined,
            },
            defaultAuthCtx,
          ))
            frames.push(frame);
        })(),
      ).rejects.toThrow('c.error called');
      expect(frames).toEqual([]);
      expect(ctx.error).toHaveBeenCalledWith({
        code: 'VAULT_LOCKED',
        message:
          'Authentication status unavailable. The InFlow vault is locked. Run `inflow vault unlock` and try again.',
      });
      expect(user.retrieve).not.toHaveBeenCalled();
      expect(auth.pollDeviceAuth).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])('does not probe a user while authentication is pending: %s', async (pending) => {
    const storage = new MemoryStorage();
    if (pending)
      storage.setPendingDeviceAuth({
        device_code: 'private-code',
        expires_at: Date.now() + 60_000,
        interval: 5,
        phrase: 'ABCD',
        verification_url: 'https://app.inflowpay.ai/device/',
      });
    const user = makeUserResource();
    const auth = makeAuthResource(storage, {}, user.resource);
    const ctx = makeContext({ interval: 0, maxAttempts: 0, timeout: 60, probe: true });
    const frames = await drainGenerator(
      runAuthStatus(
        ctx,
        { authResource: auth.resource, authStorage: storage, userResource: user.resource, updateProbe: undefined },
        defaultAuthCtx,
      ),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ authenticated: false });
    if (pending) expect(frames[0]).toMatchObject({ pending: true, phrase: 'ABCD' });
    expect(JSON.stringify(frames)).not.toContain('private-code');
    expect(user.retrieve).not.toHaveBeenCalled();
  });

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

  it('reports the locked vault instead of claiming the user is unauthenticated', async () => {
    const ctx = makeContext({
      interval: 0,
      maxAttempts: 0,
      timeout: 60,
      probe: false,
    });
    const storage = new LockedStorage();
    const auth = makeAuthResource(storage);
    const user = makeUserResource();
    await expect(
      drainGenerator(
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
      ),
    ).rejects.toThrow('c.error called');
    expect(ctx.error).toHaveBeenCalledWith({
      code: 'VAULT_LOCKED',
      message:
        'Authentication status unavailable. The InFlow vault is locked. Run `inflow vault unlock` and try again.',
    });
  });

  it('reports a runtime API key without reading a locked vault', async () => {
    const ctx = makeContext({
      interval: 0,
      maxAttempts: 0,
      timeout: 60,
      probe: false,
    });
    const storage = new LockedStorage();
    const auth = makeAuthResource(storage);
    const yields = await drainGenerator(
      runAuthStatus(
        ctx,
        {
          authResource: auth.resource,
          userResource: makeUserResource().resource,
          authStorage: storage,
          updateProbe: undefined,
        },
        { ...defaultAuthCtx, apiKey: 'inflow_runtime_key', apiKeySource: 'flag' },
      ),
    );

    expect(yields).toEqual([
      {
        authenticated: true,
        auth_method: 'api_key',
        connection: {
          apiBaseUrl: 'https://api.inflowpay.ai',
          environment: 'production',
        },
      },
    ]);
    expect(ctx.error).not.toHaveBeenCalled();
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

  it.each([new InflowApiError('Service unavailable', { status: 503, code: 'unavailable' }), 'Connection interrupted'])(
    'preserves credentials and reports a failed probe for %s',
    async (failure) => {
      const ctx = makeContext({ interval: 0, maxAttempts: 0, timeout: 60, probe: true });
      const storage = new MemoryStorage(baseTokens);
      const storedTokens = storage.getAuth();
      const user = makeUserResource();
      user.retrieve.mockRejectedValue(failure);
      const auth = makeAuthResource(storage, {}, user.resource);
      const generator = runAuthStatus(
        ctx,
        {
          authResource: auth.resource,
          userResource: user.resource,
          authStorage: storage,
          updateProbe: undefined,
        },
        defaultAuthCtx,
      );

      await expect(generator.next()).rejects.toThrow('c.error called');
      expect(ctx.error).toHaveBeenCalledOnce();
      expect(ctx.error).toHaveBeenCalledWith({
        code: 'PROBE_FAILED',
        message: failure instanceof Error ? failure.message : failure,
      });
      expect(user.retrieve).toHaveBeenCalledOnce();
      expect(storage.getAuth()).toEqual(storedTokens);
      expect(auth.revokeToken).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])('probe mode preserves verbose/update metadata after a 401: %s', async (verbose) => {
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
          updateProbe: verbose ? () => Promise.resolve({ current: '1.0.0', latest: '1.1.0' }) : undefined,
        },
        { ...defaultAuthCtx, verbose },
      ),
    );
    expect(yields[0]).toMatchObject({
      authenticated: false,
      probed_invalid: true,
    });
    if (verbose)
      expect(yields[0]).toMatchObject({
        credentials_path: 'memory',
        update: { current_version: '1.0.0', latest_version: '1.1.0' },
      });
  });
});
