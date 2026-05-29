import {
  type AuthTokens,
  type Balance,
  type IBalanceResource,
  MemoryStorage,
  Inflow,
  sanitizeResource,
} from '@inflowpayai/inflow-core';
import { describe, expect, it, vi } from 'vitest';
import { __testing } from '../../../../src/commands/balances/index.js';

const { runBalancesList } = __testing;

const tokens: AuthTokens = {
  access_token: 'a',
  refresh_token: 'r',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: Date.now() + 3600 * 1000,
};

const SAMPLE: Balance[] = [
  { available: '100.5', currency: 'USDC' },
  { available: '42.00', currency: 'USD' },
];

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

function agentCtx(): AgentCtx {
  return {
    agent: true,
    formatExplicit: true,
    error: vi.fn<ErrorEmitter>(() => {
      throw new Error('c.error called');
    }),
  };
}

function balancesStub(impl?: () => Promise<Balance[]>): Pick<IBalanceResource, 'list'> {
  return { list: vi.fn(impl ?? (() => Promise.resolve(SAMPLE))) };
}

describe('runBalancesList — session guard', () => {
  it('short-circuits via c.error when no token and no api key are available', async () => {
    const ctx = agentCtx();
    const storage = new MemoryStorage();
    await expect(
      runBalancesList(ctx, {
        balanceResource: balancesStub(),
        authStorage: storage,
        inflow: makeInflow({ storage }),
      }),
    ).rejects.toThrow('c.error called');
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_AUTHENTICATED' }));
  });

  it('admits the handler when only an api key is configured (no saved tokens)', async () => {
    const ctx = agentCtx();
    const storage = new MemoryStorage();
    const result = await runBalancesList(ctx, {
      balanceResource: balancesStub(),
      authStorage: storage,
      inflow: makeInflow({ storage, apiKey: 'inflow_test_key' }),
    });
    expect(result).toEqual(SAMPLE);
    expect(ctx.error).not.toHaveBeenCalled();
  });
});

describe('runBalancesList — agent mode payload', () => {
  it('returns the balances array verbatim (top-level array, not wrapped)', async () => {
    const ctx = agentCtx();
    const storage = new MemoryStorage(tokens);
    const result = await runBalancesList(ctx, {
      balanceResource: balancesStub(),
      authStorage: storage,
      inflow: makeInflow({ storage }),
    });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(SAMPLE);
    expect(result).not.toHaveProperty('balances');
  });

  it('returns [] (not null, not an error) when the server has zero balances', async () => {
    const ctx = agentCtx();
    const storage = new MemoryStorage(tokens);
    const result = await runBalancesList(ctx, {
      balanceResource: balancesStub(() => Promise.resolve([])),
      authStorage: storage,
      inflow: makeInflow({ storage }),
    });
    expect(result).toEqual([]);
  });

  it('preserves a balance with high-precision available string verbatim', async () => {
    const ctx = agentCtx();
    const storage = new MemoryStorage(tokens);
    const precise: Balance[] = [
      { available: '0.000001', currency: 'USDC' },
      { available: '1234567890.123456789', currency: 'USDT' },
    ];
    const result = await runBalancesList(ctx, {
      balanceResource: balancesStub(() => Promise.resolve(precise)),
      authStorage: storage,
      inflow: makeInflow({ storage }),
    });
    expect(result).toEqual(precise);
    expect(result[0]?.available).toBe('0.000001');
    expect(result[1]?.available).toBe('1234567890.123456789');
  });

  it('strips ANSI escape sequences planted in currency by the time the handler returns', async () => {
    const poisoned: Balance[] = [{ available: '\x1b[31m100.5\x1b[0m', currency: '\x1b[1mUSDC\x1b[0m' }];
    const wrapped = sanitizeResource<Pick<IBalanceResource, 'list'>>({
      list: () => Promise.resolve(poisoned),
    });
    const ctx = agentCtx();
    const storage = new MemoryStorage(tokens);
    const result = await runBalancesList(ctx, {
      balanceResource: wrapped,
      authStorage: storage,
      inflow: makeInflow({ storage }),
    });
    expect(result).toEqual([{ available: '100.5', currency: 'USDC' }]);
    expect(JSON.stringify(result)).not.toContain('\x1b');
  });
});
