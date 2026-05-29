import {
  augmentUser,
  type AuthTokens,
  Inflow,
  type IUser,
  type IUserResource,
  MemoryStorage,
  type User,
} from '@inflowpayai/inflow-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/utils/render-ink-until-exit.js', () => ({
  renderInkUntilExit: vi.fn(),
}));

import { __testing, createUserCli } from '../../../../src/commands/user/index.js';
import { renderInkUntilExit } from '../../../../src/utils/render-ink-until-exit.js';

const renderMock = vi.mocked(renderInkUntilExit);

const { runUserGet } = __testing;

const tokens: AuthTokens = {
  access_token: 'a',
  refresh_token: 'r',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: Date.now() + 3600 * 1000,
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

function makeInflow(storage: MemoryStorage): Inflow {
  return new Inflow({
    authStorage: storage,
    environment: 'sandbox',
    cliClientId: 'test',
  });
}

function userStub(): IUserResource {
  return { retrieve: vi.fn(() => Promise.resolve(sampleUser)) };
}

function userHandle(): IUser {
  return augmentUser(userStub());
}

type ErrorEmitter = (err: {
  code: string;
  message: string;
  cta?: { commands: { command: string; description: string }[] };
}) => never;

interface TtyCtx {
  agent: false;
  formatExplicit: false;
  error: ErrorEmitter;
}

function ttyCtx(): TtyCtx {
  return {
    agent: false,
    formatExplicit: false,
    error: vi.fn<ErrorEmitter>((_err) => {
      throw new Error('c.error called');
    }),
  };
}

afterEach(() => {
  renderMock.mockReset();
});

describe('runUserGet (tty mode)', () => {
  it('returns the user when renderInkUntilExit produces a success outcome', async () => {
    renderMock.mockImplementation(async (_element, resolveResult) => {
      const resolver = resolveResult as (() => unknown) | undefined;
      return resolver ? (resolver() ?? { kind: 'success', user: sampleUser }) : { kind: 'success', user: sampleUser };
    });
    renderMock.mockImplementation(async (_element) => {
      return { kind: 'success', user: sampleUser } as const;
    });

    const ctx = ttyCtx();
    const storage = new MemoryStorage(tokens);
    const result = await runUserGet(ctx, {
      user: userHandle(),
      authStorage: storage,
      inflow: makeInflow(storage),
    });
    const { created: _created, updated: _updated, ...expectedPayload } = sampleUser;
    expect(result).toEqual(expectedPayload);
    expect(result).not.toHaveProperty('created');
    expect(result).not.toHaveProperty('updated');
    expect(renderMock).toHaveBeenCalledOnce();
  });

  it('throws an IncurError when the TTY frame produced no result (null outcome)', async () => {
    renderMock.mockImplementation(async () => null);

    const ctx = ttyCtx();
    const storage = new MemoryStorage(tokens);
    await expect(
      runUserGet(ctx, {
        user: userHandle(),
        authStorage: storage,
        inflow: makeInflow(storage),
      }),
    ).rejects.toThrowError(/exited without producing a result/);
  });

  it('throws an IncurError surfacing the error message when the TTY frame produced an error outcome', async () => {
    renderMock.mockImplementation(async () => ({
      kind: 'error',
      message: 'boom',
    }));
    const ctx = ttyCtx();
    const storage = new MemoryStorage(tokens);
    await expect(
      runUserGet(ctx, {
        user: userHandle(),
        authStorage: storage,
        inflow: makeInflow(storage),
      }),
    ).rejects.toThrowError(/boom/);
  });

  it('still enforces the session guard in tty mode', async () => {
    const ctx = ttyCtx();
    const storage = new MemoryStorage();
    await expect(
      runUserGet(ctx, {
        user: userHandle(),
        authStorage: storage,
        inflow: makeInflow(storage),
      }),
    ).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_AUTHENTICATED' }));
  });
});

describe('createUserCli', () => {
  it('registers a `get` subcommand on the returned Cli', () => {
    const storage = new MemoryStorage(tokens);
    const cli = createUserCli(userHandle(), storage, makeInflow(storage));
    const description = (cli as unknown as { description?: string }).description;
    expect(description).toContain('User profile commands');
  });
});
