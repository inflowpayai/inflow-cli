import {
  augmentAuth,
  type AuthStorage,
  type AuthTokens,
  type IAuth,
  type IAuthResource,
  type IUserResource,
  InflowApiError,
  MemoryStorage,
  type User,
} from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import React from 'react';
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
      update_command: 'npm install -g @inflowpayai/inflow',
    });
  });
});

describe('InteractiveLoginShell', () => {
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
  it('delegates rendering to renderInkUntilExit when not in agent mode', async () => {
    renderMock.mockResolvedValueOnce(undefined);
    const storage = new MemoryStorage();
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
      ctx as never,
      {
        authResource: authStub(),
        userResource: userStub(),
        authStorage: storage,
      },
      defaultAuthCtx,
    );
    const out: unknown[] = [];
    for await (const y of gen) out.push(y);
    expect(renderMock).toHaveBeenCalledOnce();
    expect(out).toEqual([]);
  });
});

describe('runAuthLogout (tty mode)', () => {
  it('delegates rendering to renderInkUntilExit and returns the unauthenticated envelope', async () => {
    renderMock.mockResolvedValueOnce(undefined);
    const storage = new MemoryStorage(sampleTokens);
    const ctx = { agent: false, formatExplicit: false };
    const result = await runAuthLogout(ctx, {
      authResource: authStub(),
      authStorage: storage,
    });
    expect(result).toEqual({ authenticated: false });
    expect(renderMock).toHaveBeenCalledOnce();
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
      ctx as never,
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
      ctx as never,
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
          ctx as never,
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
          ctx as never,
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
