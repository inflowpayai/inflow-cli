import {
  type AuthTokens,
  type ConfiguredDepositAddress,
  type DepositAddresses,
  type IDepositAddressResource,
  MemoryStorage,
  Inflow,
  sanitizeResource,
} from '@inflowpayai/inflow-core';
import { describe, expect, it, vi } from 'vitest';
import { __testing } from '../../../../src/commands/deposit-addresses/index.js';

const { runDepositAddressesList } = __testing;

const tokens: AuthTokens = {
  access_token: 'a',
  refresh_token: 'r',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: Date.now() + 3600 * 1000,
};

const CONFIGURED: ConfiguredDepositAddress[] = [
  {
    address: '4q6BvgEM9p3uK8jPyzfNcQa7DRRkU8eKbtdgFsHs8uYJW',
    blockchain: 'SOLANA',
    currencies: ['USDC', 'USDT'],
  },
  {
    address: '0x9f3a4cdcEbA63E4b21cBBe4D52f0E1c98F46c12d',
    blockchain: 'BASE',
    currencies: ['USDC'],
  },
];

const FULL_WRAPPER: DepositAddresses = {
  configured: CONFIGURED,
  unconfigured: [
    { blockchain: 'STELLAR', currencies: ['USDC'] },
    { blockchain: 'ETHEREUM', currencies: ['USDC', 'USDT'] },
  ],
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

function agentCtx(): AgentCtx {
  return {
    agent: true,
    formatExplicit: true,
    error: vi.fn<ErrorEmitter>(() => {
      throw new Error('c.error called');
    }),
  };
}

function resourceStub(impl?: () => Promise<DepositAddresses>): Pick<IDepositAddressResource, 'list'> {
  return {
    list: vi.fn(impl ?? (() => Promise.resolve(FULL_WRAPPER))),
  };
}

describe('runDepositAddressesList — session guard', () => {
  it('short-circuits via c.error when no token and no api key are available', async () => {
    const ctx = agentCtx();
    const storage = new MemoryStorage();
    await expect(
      runDepositAddressesList(ctx, {
        depositAddressResource: resourceStub(),
        authStorage: storage,
        inflow: makeInflow({ storage }),
      }),
    ).rejects.toThrow('c.error called');
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_AUTHENTICATED' }));
  });

  it('admits the handler when only an api key is configured (no saved tokens)', async () => {
    const ctx = agentCtx();
    const storage = new MemoryStorage();
    const result = await runDepositAddressesList(ctx, {
      depositAddressResource: resourceStub(),
      authStorage: storage,
      inflow: makeInflow({ storage, apiKey: 'inflow_test_key' }),
    });
    expect(result).toEqual(CONFIGURED);
    expect(ctx.error).not.toHaveBeenCalled();
  });
});

describe('runDepositAddressesList — agent mode payload', () => {
  it('returns ConfiguredDepositAddress[] (top-level array, not the server wrapper)', async () => {
    const ctx = agentCtx();
    const storage = new MemoryStorage(tokens);
    const result = await runDepositAddressesList(ctx, {
      depositAddressResource: resourceStub(),
      authStorage: storage,
      inflow: makeInflow({ storage }),
    });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(CONFIGURED);
    expect(result).not.toHaveProperty('configured');
    expect(result).not.toHaveProperty('unconfigured');
  });

  it('hides the unconfigured half: every returned entry has an address field', async () => {
    const ctx = agentCtx();
    const storage = new MemoryStorage(tokens);
    const result = await runDepositAddressesList(ctx, {
      depositAddressResource: resourceStub(),
      authStorage: storage,
      inflow: makeInflow({ storage }),
    });
    expect(result).toHaveLength(CONFIGURED.length);
    for (const entry of result) {
      expect(entry).toHaveProperty('address');
      expect(typeof entry.address).toBe('string');
      expect(entry.address.length).toBeGreaterThan(0);
    }
    const json = JSON.stringify(result);
    expect(json).not.toContain('STELLAR');
    expect(json).not.toContain('ETHEREUM');
    expect(json).not.toContain('unconfigured');
  });

  it('returns [] when the server returns zero configured addresses, even with unconfigured suggestions', async () => {
    const ctx = agentCtx();
    const storage = new MemoryStorage(tokens);
    const result = await runDepositAddressesList(ctx, {
      depositAddressResource: resourceStub(() =>
        Promise.resolve({
          configured: [],
          unconfigured: [{ blockchain: 'SOLANA', currencies: ['USDC'] }],
        }),
      ),
      authStorage: storage,
      inflow: makeInflow({ storage }),
    });
    expect(result).toEqual([]);
  });

  it('strips ANSI escape sequences planted in the address by the time the handler returns', async () => {
    const poisoned: DepositAddresses = {
      configured: [
        {
          address: '\x1b[31m4q6BvgEM9p3uK8jPyzfNcQa7DRRkU8eKbtdgFsHs8uYJW\x1b[0m',
          blockchain: '\x1b[1mSOLANA\x1b[0m',
          currencies: ['\x1b[33mUSDC\x1b[0m'],
        },
      ],
      unconfigured: [],
    };
    const wrapped = sanitizeResource<Pick<IDepositAddressResource, 'list'>>({
      list: () => Promise.resolve(poisoned),
    });
    const ctx = agentCtx();
    const storage = new MemoryStorage(tokens);
    const result = await runDepositAddressesList(ctx, {
      depositAddressResource: wrapped,
      authStorage: storage,
      inflow: makeInflow({ storage }),
    });
    expect(result).toEqual([
      {
        address: '4q6BvgEM9p3uK8jPyzfNcQa7DRRkU8eKbtdgFsHs8uYJW',
        blockchain: 'SOLANA',
        currencies: ['USDC'],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('\x1b');
  });

  it('preserves server-provided blockchain casing verbatim (no display normalization)', async () => {
    const ctx = agentCtx();
    const storage = new MemoryStorage(tokens);
    const result = await runDepositAddressesList(ctx, {
      depositAddressResource: resourceStub(),
      authStorage: storage,
      inflow: makeInflow({ storage }),
    });
    expect(result.map((entry) => entry.blockchain)).toEqual(['SOLANA', 'BASE']);
  });
});
