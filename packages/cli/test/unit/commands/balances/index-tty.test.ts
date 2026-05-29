import { type AuthTokens, type Balance, type IBalanceResource, Inflow, MemoryStorage } from '@inflowpayai/inflow-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/utils/render-ink-until-exit.js', () => ({
  renderInkUntilExit: vi.fn(),
}));

import { __testing, createBalancesCli } from '../../../../src/commands/balances/index.js';
import { renderInkUntilExit } from '../../../../src/utils/render-ink-until-exit.js';

const renderMock = vi.mocked(renderInkUntilExit);

const { runBalancesList } = __testing;

const tokens: AuthTokens = {
  access_token: 'a',
  refresh_token: 'r',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: Date.now() + 3600 * 1000,
};

function makeInflow(storage: MemoryStorage): Inflow {
  return new Inflow({
    authStorage: storage,
    environment: 'sandbox',
    cliClientId: 'test',
  });
}

function balanceStub(impl?: () => Promise<Balance[]>): Pick<IBalanceResource, 'list'> {
  return {
    list: vi.fn(impl ?? (() => Promise.resolve([]))),
  };
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

describe('runBalancesList (tty mode)', () => {
  it('returns the resolved balances when the TTY renderer surfaces them', async () => {
    const fixture: Balance[] = [{ available: '1.0', currency: 'USDC' }];
    renderMock.mockImplementation(async () => fixture);

    const ctx = ttyCtx();
    const storage = new MemoryStorage(tokens);
    const result = await runBalancesList(ctx, {
      balanceResource: balanceStub(),
      authStorage: storage,
      inflow: makeInflow(storage),
    });
    expect(result).toEqual(fixture);
  });

  it('still enforces the session guard in tty mode', async () => {
    const ctx = ttyCtx();
    const storage = new MemoryStorage();
    await expect(
      runBalancesList(ctx, {
        balanceResource: balanceStub(),
        authStorage: storage,
        inflow: makeInflow(storage),
      }),
    ).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_AUTHENTICATED' }));
  });
});

describe('createBalancesCli', () => {
  it('returns a Cli scoped to balance commands', () => {
    const storage = new MemoryStorage(tokens);
    const cli = createBalancesCli(balanceStub() as IBalanceResource, storage, makeInflow(storage));
    const description = (cli as unknown as { description?: string }).description;
    expect(description).toContain('Balance commands');
  });
});
