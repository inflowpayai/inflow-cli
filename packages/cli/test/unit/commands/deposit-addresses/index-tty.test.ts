import {
  type AuthTokens,
  type ConfiguredDepositAddress,
  type DepositAddresses,
  type IDepositAddressResource,
  Inflow,
  MemoryStorage,
} from '@inflowpayai/inflow-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/utils/render-ink-until-exit.js', () => ({
  renderInkUntilExit: vi.fn(),
}));

import { __testing, createDepositAddressesCli } from '../../../../src/commands/deposit-addresses/index.js';
import { renderInkUntilExit } from '../../../../src/utils/render-ink-until-exit.js';

const renderMock = vi.mocked(renderInkUntilExit);

const { runDepositAddressesList } = __testing;

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

function resourceStub(impl?: () => Promise<DepositAddresses>): Pick<IDepositAddressResource, 'list'> {
  return {
    list: vi.fn(
      impl ??
        (() =>
          Promise.resolve<DepositAddresses>({
            configured: [],
            unconfigured: [],
          })),
    ),
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
    error: vi.fn<ErrorEmitter>(() => {
      throw new Error('c.error called');
    }),
  };
}

afterEach(() => {
  renderMock.mockReset();
});

describe('runDepositAddressesList (tty mode)', () => {
  it('returns the configured addresses when the TTY renderer surfaces them', async () => {
    const fixture: ConfiguredDepositAddress[] = [
      {
        address: 'GA7HQ3RJ5EFAQTI3TDRJ5SK24GZSXP4IW5OQXPYO',
        blockchain: 'STELLAR',
        currencies: ['USDC'],
      },
    ];
    renderMock.mockImplementation(() => Promise.resolve(fixture));

    const ctx = ttyCtx();
    const storage = new MemoryStorage(tokens);
    const result = await runDepositAddressesList(ctx, {
      depositAddressResource: resourceStub(),
      authStorage: storage,
      inflow: makeInflow(storage),
    });
    expect(result).toEqual(fixture);
  });

  it('still enforces the session guard in tty mode', async () => {
    const ctx = ttyCtx();
    const storage = new MemoryStorage();
    await expect(
      runDepositAddressesList(ctx, {
        depositAddressResource: resourceStub(),
        authStorage: storage,
        inflow: makeInflow(storage),
      }),
    ).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_AUTHENTICATED' }));
  });
});

describe('createDepositAddressesCli', () => {
  it('returns a Cli scoped to deposit-address commands', () => {
    const storage = new MemoryStorage(tokens);
    const cli = createDepositAddressesCli(resourceStub(), storage, makeInflow(storage));
    const description = (cli as unknown as { description?: string }).description;
    expect(description).toContain('Deposit-address commands');
  });
});
