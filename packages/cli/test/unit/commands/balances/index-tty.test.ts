import { type AuthTokens, type Balance, type IBalanceResource, Inflow, MemoryStorage } from '@inflowpayai/inflow-core';
import { describe, expect, it, vi } from 'vitest';

import { __testing, createBalancesCli } from '../../../../src/commands/balances/index.js';

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

describe('runBalancesList (tty mode)', () => {
  it('returns balances loaded through the interactive view', async () => {
    const fixture: Balance[] = [{ available: '1.0', currency: 'USDC' }];

    const ctx = ttyCtx();
    const storage = new MemoryStorage(tokens);
    const result = await runBalancesList(ctx, {
      balanceResource: balanceStub(() => Promise.resolve(fixture)),
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
  it('dispatches the list command and sanitizes the JSON result', async () => {
    const storage = new MemoryStorage(tokens);
    const list = vi.fn(() => Promise.resolve([{ available: '1.0', currency: '\u001b[31mUSDC\u001b[0m' }]));
    const cli = createBalancesCli({ list }, storage, makeInflow(storage));
    const chunks: string[] = [];
    const exit = vi.fn();
    await cli.serve(['list', '--format', 'json'], {
      exit,
      stdout: (chunk) => {
        chunks.push(chunk);
      },
    });
    expect(exit).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledOnce();
    expect(JSON.parse(chunks.join(''))).toEqual([{ available: '1.0', currency: 'USDC' }]);
  });

  it('returns a Cli scoped to balance commands', () => {
    const storage = new MemoryStorage(tokens);
    const cli = createBalancesCli(balanceStub(), storage, makeInflow(storage));
    const description = (cli as unknown as { description?: string }).description;
    expect(description).toContain('Balance commands');
  });
});
