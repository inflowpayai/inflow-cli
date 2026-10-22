import {
  augmentAuth,
  type AuthStorage,
  type AuthTokens,
  type IAuth,
  type IAuthResource,
  type IUserResource,
  InflowApiError,
  LocalVaultClient,
  MemoryStorage,
  startLocalVaultDaemon,
  type User,
} from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/utils/render-ink-until-exit.js', () => ({
  renderInkUntilExit: vi.fn(),
}));

import {
  type AuthCommandContext,
  buildInitialLoginPayload,
  createAuthCli,
  InteractiveLoginShell,
  toUpdateBlock,
  __testing,
} from '../../../../src/commands/auth/index.js';
import { renderInkUntilExit } from '../../../../src/utils/render-ink-until-exit.js';

const renderMock = vi.mocked(renderInkUntilExit);

const { runAuthLogin, runAuthLogout, runAuthStatus } = __testing;

const defaultAuthCtx: AuthCommandContext = {
  apiKey: undefined,
  apiKeySource: undefined,
  environment: 'production',
  resolvedApiBaseUrl: 'https://api.inflowpay.ai',
  verbose: false,
};

const sampleRequest = {
  device_code: 'dc-1',
  user_code: 'AAAA-BBBB',
  verification_url: 'https://app.inflowpay.ai/device/',
  verification_url_complete: 'https://app.inflowpay.ai/device/?code=AAAA-BBBB',
  expires_in: 600,
  interval: 5,
};

const sampleUser: User = {
  userId: 'u-1',
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  username: 'ada',
  mobile: null,
  locale: 'EN_US',
  timezone: 'UTC',
  created: '2025-01-01T00:00:00Z',
  updated: '2026-01-01T00:00:00Z',
};

const sampleTokens: AuthTokens = {
  access_token: 'access-token-aaaaaaaaaaaaaaaaaaaaaaaa',
  refresh_token: 'r',
  token_type: 'Bearer',
  expires_in: 3600,
};

function rawAuthStub(overrides: Partial<IAuthResource> = {}): IAuthResource {
  return {
    initiateDeviceAuth: vi.fn(() => Promise.resolve(sampleRequest)),
    pollDeviceAuth: vi.fn(() => Promise.resolve(null)),
    refreshToken: vi.fn(),
    revokeToken: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function authStub(
  overrides: Partial<IAuthResource> = {},
  storage: AuthStorage = new MemoryStorage(),
  userResource: IUserResource = userStub(),
): IAuth {
  return augmentAuth(rawAuthStub(overrides), userResource, storage);
}

function userStub(retrieveImpl?: (opts?: { signal?: AbortSignal }) => Promise<User>): IUserResource {
  return {
    retrieve: vi.fn(retrieveImpl ?? (() => Promise.resolve(sampleUser))),
  };
}

afterEach(() => {
  renderMock.mockReset();
});

describe('buildInitialLoginPayload', () => {
  it('omits _next when interval > 0 and uses the with-interval instruction', () => {
    const payload = buildInitialLoginPayload(sampleRequest, 5);
    expect(payload._next).toBeUndefined();
    expect(payload.instruction).toContain('Polling has started automatically');
  });

  it('emits _next when interval <= 0 and uses the no-interval instruction', () => {
    const payload = buildInitialLoginPayload(sampleRequest, 0);
    expect(payload._next?.command).toContain('auth status');
    expect(payload.instruction).toContain('Then call');
    expect(payload.tip).toContain('balances list');
  });
});

describe('toUpdateBlock', () => {
  it('returns undefined when there is no update info', () => {
    expect(toUpdateBlock(undefined)).toBeUndefined();
  });

  it('translates UpdateInfo to the agent-facing UpdateBlock', () => {
    const block = toUpdateBlock({ current: '0.1.0', latest: '0.2.0' });
    expect(block).toEqual({
      current_version: '0.1.0',
      latest_version: '0.2.0',
    });
  });
});

describe('InteractiveLoginShell', () => {
  it.each(['n', 'y'])('preserves the existing session when answering %s to re-authentication', async (answer) => {
    const storage = new MemoryStorage(sampleTokens);
    const originalAuth = storage.getAuth();
    const auth = authStub({}, storage);
    const login = vi.spyOn(auth, 'login');
    const onComplete = vi.fn();
    const view = render(
      <InteractiveLoginShell
        authResource={auth}
        authStorage={storage}
        userResource={userStub()}
        clientName="Test"
        connection={{ environment: 'production' }}
        onComplete={onComplete}
      />,
    );
    try {
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Re-authenticate?'));
      view.stdin.write(answer);
      if (answer === 'n') {
        await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
        expect(view.lastFrame()).toContain('No change.');
        expect(login).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(view.lastFrame()).toContain(sampleRequest.verification_url_complete));
        expect(login).toHaveBeenCalledWith({
          clientName: 'Test',
          connection: { environment: 'production' },
          priorRefreshToken: sampleTokens.refresh_token,
        });
        expect(onComplete).not.toHaveBeenCalled();
      }
      expect(storage.getAuth()).toEqual(originalAuth);
    } finally {
      view.unmount();
    }
  });

  it('does not start login if the view unmounts while checking the existing session', async () => {
    const storage = new MemoryStorage(sampleTokens);
    const originalAuth = storage.getAuth();
    const auth = authStub({}, storage);
    const login = vi.spyOn(auth, 'login');
    let completeProbe: ((user: User) => void) | undefined;
    const probe = new Promise<User>((resolve) => {
      completeProbe = resolve;
    });
    const retrieve = vi.fn(() => probe);
    const onComplete = vi.fn();
    const view = render(
      <InteractiveLoginShell
        authResource={auth}
        authStorage={storage}
        userResource={userStub(retrieve)}
        clientName="Test"
        connection={{ environment: 'production' }}
        onComplete={onComplete}
      />,
    );
    await vi.waitFor(() => expect(retrieve).toHaveBeenCalledOnce());
    view.unmount();
    await new Promise<void>((resolve) => setImmediate(resolve));
    completeProbe?.(sampleUser);
    await probe;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(login).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(storage.getAuth()).toEqual(originalAuth);
  });

  it('skips the probe and jumps to the flow when no auth is stored', async () => {
    const storage = new MemoryStorage();
    const auth = authStub();
    const user = userStub();
    const { lastFrame, unmount } = render(
      <InteractiveLoginShell
        authResource={auth}
        authStorage={storage}
        userResource={user}
        clientName="Test"
        connection={{ environment: 'production' }}
        onComplete={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(sampleRequest.verification_url_complete);
    });
    unmount();
  });

  it('shows the re-auth prompt when an existing session probes successfully', async () => {
    const storage = new MemoryStorage(sampleTokens);
    const auth = authStub();
    const user = userStub();
    const { lastFrame, unmount } = render(
      <InteractiveLoginShell
        authResource={auth}
        authStorage={storage}
        userResource={user}
        clientName="Test"
        connection={{ environment: 'production' }}
        onComplete={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('ada@example.test');
    });
    unmount();
  });

  it('falls through to the flow when the probe rejects with non-401', async () => {
    const storage = new MemoryStorage(sampleTokens);
    const auth = authStub();
    const user = userStub(() => Promise.reject(new Error('network down')));
    const { lastFrame, unmount } = render(
      <InteractiveLoginShell
        authResource={auth}
        authStorage={storage}
        userResource={user}
        clientName="Test"
        connection={{ environment: 'production' }}
        onComplete={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(sampleRequest.verification_url_complete);
    });
    unmount();
  });
});

describe('runAuthLogin (tty mode)', () => {
  it.each(['device', 'api-key', 'status', 'status-api-key', 'logout'] as const)(
    'completes the real interactive %s renderer',
    async (command) => {
      const chunks: string[] = [];
      renderMock.mockImplementation(async (element) => {
        const { render: renderInk } = await import('ink');
        const stdout = new PassThrough();
        const stdin = new PassThrough();
        stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
        const instance = renderInk(element, {
          // These noninteractive views only need ordinary stream operations from Ink's terminal interfaces.
          stdout: stdout as unknown as NodeJS.WriteStream,
          stderr: stdout as unknown as NodeJS.WriteStream,
          stdin: stdin as unknown as NodeJS.ReadStream,
          debug: true,
          exitOnCtrlC: false,
          patchConsole: false,
        });
        try {
          await instance.waitUntilExit();
        } finally {
          instance.unmount();
          stdout.destroy();
          stdin.destroy();
        }
      });
      const storage = new MemoryStorage(command === 'status' || command === 'logout' ? sampleTokens : undefined);
      const auth = authStub({ pollDeviceAuth: () => Promise.resolve(sampleTokens) }, storage);
      const error = vi.fn(() => {
        throw new Error('Unexpected command error');
      });
      const c = {
        agent: false,
        formatExplicit: false,
        options: { clientName: 'Test', interval: 1, maxAttempts: 1, timeout: 60, probe: false },
        error,
      };
      const resetVault = vi.fn(() => Promise.resolve());
      if (command === 'logout') {
        await runAuthLogout(c, { authResource: auth, authStorage: storage, resetVault });
        expect(resetVault).toHaveBeenCalledOnce();
      } else {
        const dependencies = {
          authResource: auth,
          authStorage: storage,
          userResource: userStub(),
          updateProbe: undefined,
        };
        const events =
          command === 'status' || command === 'status-api-key'
            ? runAuthStatus(c, dependencies, {
                ...defaultAuthCtx,
                ...(command === 'status-api-key' ? { apiKey: 'private-test-key', apiKeySource: 'flag' as const } : {}),
              })
            : runAuthLogin(c, dependencies, {
                ...defaultAuthCtx,
                apiKey: command === 'api-key' ? 'private-test-key' : undefined,
              });
        for await (const _event of events) {
          /* Interactive commands render instead of yielding frames. */
        }
      }
      expect(chunks.join('')).not.toContain('private-test-key');
      expect(chunks.join('')).not.toContain(sampleTokens.access_token);
      expect(renderMock).toHaveBeenCalledOnce();
      expect(error).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])('delegates interactive login rendering with a saved API key: %s', async (savedKey) => {
    renderMock.mockResolvedValueOnce(undefined);
    const storage = new MemoryStorage();
    if (savedKey) storage.setApiKey('saved-interactive-key');
    const ctx = {
      agent: false,
      formatExplicit: false,
      options: {
        clientName: 'Test',
        interval: 0,
        maxAttempts: 0,
        timeout: 60,
      },
      error: vi.fn(() => {
        throw new Error('c.error called');
      }),
    };
    const gen = runAuthLogin(
      ctx,
      {
        authResource: authStub(),
        userResource: userStub(),
        authStorage: storage,
      },
      { ...defaultAuthCtx, apiKeySource: savedKey ? 'saved' : undefined },
    );
    const out: unknown[] = [];
    for await (const y of gen) out.push(y);
    expect(renderMock).toHaveBeenCalledOnce();
    if (savedKey) {
      expect(renderMock.mock.calls[0]?.[0]).toMatchObject({ props: { apiKey: 'saved-interactive-key' } });
    }
    expect(out).toEqual([]);
  });
});

describe('runAuthLogout (tty mode)', () => {
  it('delegates rendering to renderInkUntilExit and returns the unauthenticated envelope', async () => {
    renderMock.mockResolvedValueOnce(undefined);
    const storage = new MemoryStorage(sampleTokens);
    const ctx = { agent: false, formatExplicit: false };
    const resetVault = vi.fn(() => Promise.resolve());
    const result = await runAuthLogout(ctx, {
      authResource: authStub(),
      authStorage: storage,
      resetVault,
    });
    expect(result).toEqual({ authenticated: false });
    expect(renderMock).toHaveBeenCalledOnce();
    expect(resetVault).toHaveBeenCalledOnce();
  });
});

describe('runAuthStatus (tty + agent details)', () => {
  it('delegates to renderInkUntilExit and forwards an updateNotice when one is available', async () => {
    renderMock.mockResolvedValueOnce(undefined);
    const ctx = {
      agent: false,
      formatExplicit: false,
      options: { interval: 0, maxAttempts: 0, timeout: 60, probe: false },
      error: vi.fn(() => {
        throw new Error('c.error called');
      }),
    };
    const storage = new MemoryStorage(sampleTokens);
    const gen = runAuthStatus(
      ctx,
      {
        authResource: authStub(),
        userResource: userStub(),
        authStorage: storage,
        updateProbe: () => Promise.resolve({ current: '0.1', latest: '0.2' }),
      },
      defaultAuthCtx,
    );
    for await (const _frame of gen) {
      /* drain */
    }
    expect(renderMock).toHaveBeenCalledOnce();
  });

  it('agent + probe mode surfaces PROBE_FAILED on non-401 errors', async () => {
    const ctx = {
      agent: true,
      formatExplicit: true,
      options: { interval: 0, maxAttempts: 0, timeout: 60, probe: true },
      error: vi.fn(() => {
        throw new Error('c.error called');
      }),
    };
    const storage = new MemoryStorage(sampleTokens);
    const failingUser = userStub(() => Promise.reject(new Error('network')));
    const gen = runAuthStatus(
      ctx,
      {
        authResource: authStub({}, storage, failingUser),
        userResource: failingUser,
        authStorage: storage,
        updateProbe: undefined,
      },
      defaultAuthCtx,
    );
    await expect(
      (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })(),
    ).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROBE_FAILED' }));
  });

  it('agent + polling mode (no probe) yields frames from pollAuthStatus once', async () => {
    const ctx = {
      agent: true,
      formatExplicit: true,
      options: { interval: 0, maxAttempts: 0, timeout: 60, probe: false },
      error: vi.fn(),
    };
    const storage = new MemoryStorage(sampleTokens);
    const gen = runAuthStatus(
      ctx as never,
      {
        authResource: authStub({}, storage),
        userResource: userStub(),
        authStorage: storage,
        updateProbe: undefined,
      },
      defaultAuthCtx,
    );
    const out: unknown[] = [];
    for await (const frame of gen) {
      out.push(frame);
    }
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect((out[0] as { authenticated: boolean }).authenticated).toBe(true);
  });
});

describe('createAuthCli', () => {
  it('checks the isolated vault before login and shuts it down on logout', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'inflow-auth-command-'));
    const daemon = await startLocalVaultDaemon({ rootDirectory });
    const client = new LocalVaultClient({ rootDirectory });
    const passphrase = Buffer.from('test-passphrase');
    const storage = new MemoryStorage();
    const user = userStub();
    const retrieve = vi.spyOn(user, 'retrieve');
    const cli = createAuthCli(authStub({}, storage, user), user, undefined, storage, {
      ...defaultAuthCtx,
      apiKey: 'test-api-key',
      apiKeySource: 'flag',
      vaultOptions: { rootDirectory, client },
    });
    const execute = async (command: string) => {
      const output: string[] = [];
      const exit = vi.fn();
      await cli.serve([command, '--format', 'json'], {
        exit,
        stdout: (chunk) => {
          output.push(chunk);
        },
      });
      return { output: JSON.parse(output.join('')) as unknown, exit };
    };
    try {
      await client.unlock(passphrase);
      await client.lock();
      const refused = await execute('login');
      expect(refused.exit).toHaveBeenCalledWith(1);
      expect(retrieve).not.toHaveBeenCalled();
      expect(storage.getApiKey()).toBeNull();

      await client.unlock(passphrase);
      const login = await execute('login');
      expect(login.exit).not.toHaveBeenCalledWith(1);
      expect(login.output).toMatchObject([{ authenticated: true, method: 'api_key' }]);
      expect(storage.getApiKey()).toBe('test-api-key');
      expect(retrieve).toHaveBeenCalledOnce();

      const logout = await execute('logout');
      expect(logout.exit).not.toHaveBeenCalledWith(1);
      expect(logout.output).toEqual({ authenticated: false });
      expect(storage.getApiKey()).toBeNull();
      await daemon.closed;
      expect(renderMock).not.toHaveBeenCalled();
    } finally {
      passphrase.fill(0);
      client.dispose();
      await daemon.close();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    'dispatches JSON status with authenticated=%s without rendering Ink',
    async (authenticated) => {
      const storage = new MemoryStorage(authenticated ? sampleTokens : undefined);
      const user = userStub();
      const retrieve = vi.spyOn(user, 'retrieve');
      const output: string[] = [];
      const exit = vi.fn();
      const cli = createAuthCli(authStub({}, storage, user), user, undefined, storage, defaultAuthCtx);

      await cli.serve(['status', '--format', 'json'], {
        stdout: (chunk) => {
          output.push(chunk);
        },
        exit,
      });

      expect(JSON.parse(output.join(''))).toMatchObject([{ authenticated }]);
      expect(output.join('')).not.toContain(sampleTokens.access_token);
      expect(retrieve).not.toHaveBeenCalled();
      expect(renderMock).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalledWith(1);
    },
  );

  it('rejects a blank client name before requesting vault access or device authorization', async () => {
    const storage = new MemoryStorage();
    const auth = authStub({}, storage);
    const login = vi.spyOn(auth, 'login');
    const output: string[] = [];
    const exit = vi.fn();
    await createAuthCli(auth, userStub(), undefined, storage, defaultAuthCtx).serve(
      ['login', '--client-name', ' ', '--format', 'json'],
      {
        stdout: (chunk) => {
          output.push(chunk);
        },
        exit,
      },
    );

    expect(JSON.parse(output.join(''))).toMatchObject({ code: 'INVALID_INPUT' });
    expect(exit).toHaveBeenCalledWith(1);
    expect(login).not.toHaveBeenCalled();
    expect(storage.getPendingDeviceAuth()).toBeNull();
    expect(renderMock).not.toHaveBeenCalled();
  });

  it('builds an auth Cli with login/logout/status subcommands', () => {
    const cli = createAuthCli(authStub(), userStub(), undefined, new MemoryStorage(), defaultAuthCtx);
    const description = (cli as unknown as { description?: string }).description;
    expect(description).toContain('Authentication commands');
  });
});

describe('runAuthLogin error envelope', () => {
  it('yields the denial frame and surfaces ACCESS_DENIED when polling rejects with access_denied', async () => {
    const ctx = {
      agent: true,
      formatExplicit: true,
      options: {
        clientName: 'Test',
        interval: 0.01,
        maxAttempts: 5,
        timeout: 60,
      },
      error: vi.fn(() => {
        throw new Error('c.error called');
      }),
    };
    const storage = new MemoryStorage();
    const auth = authStub({
      pollDeviceAuth: vi.fn(() =>
        Promise.reject(
          new InflowApiError('denied', {
            status: 400,
            code: 'access_denied',
          }),
        ),
      ),
    });
    const collected: unknown[] = [];
    await expect(
      (async () => {
        for await (const frame of runAuthLogin(
          ctx,
          {
            authResource: auth,
            userResource: userStub(),
            authStorage: storage,
          },
          defaultAuthCtx,
        )) {
          collected.push(frame);
        }
      })(),
    ).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'ACCESS_DENIED' }));
    expect(collected.length).toBeGreaterThanOrEqual(1);
  });

  it('surfaces a POLLING_TIMEOUT when pollAuthStatus exhausts max_attempts', async () => {
    const ctx = {
      agent: true,
      formatExplicit: true,
      options: {
        clientName: 'Test',
        interval: 0.01,
        maxAttempts: 1,
        timeout: 60,
      },
      error: vi.fn(() => {
        throw new Error('c.error called');
      }),
    };
    const storage = new MemoryStorage();
    const auth = authStub();
    await expect(
      (async () => {
        for await (const _frame of runAuthLogin(
          ctx,
          {
            authResource: auth,
            userResource: userStub(),
            authStorage: storage,
          },
          defaultAuthCtx,
        )) {
          /* drain */
        }
      })(),
    ).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'POLLING_TIMEOUT' }));
  });
});
