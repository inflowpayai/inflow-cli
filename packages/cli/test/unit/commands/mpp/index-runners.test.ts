import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthStorage, ICliCapabilitiesResource } from '@inflowpayai/inflow-core';
import { Inflow, InflowApiError, MemoryStorage, SecureStorageError } from '@inflowpayai/inflow-core';
import {
  encode,
  type MppChallenge,
  type MppClient,
  renderChallengeHeader,
  subscriptionOptionFingerprint,
} from '@inflowpayai/mpp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testing, createMppCli } from '../../../../src/commands/mpp/index.js';
import { fetchArgs, fetchOptions, payOptions } from '../../../../src/commands/mpp/schema.js';

const {
  runPayCommand,
  runSubscribeCommand,
  runFetchCommand,
  runStatusCommand,
  runCancelCommand,
  runSupportedCommand,
  runInspectCommand,
} = __testing;

const SELLER = 'https://seller.test/api';

function challenge(method = 'inflow', intent = 'charge'): MppChallenge {
  return {
    id: `chal-${method}-${intent}`,
    realm: 'mpp.test',
    method,
    intent,
    request: encode({ amount: '10', currency: 'USDC', methodDetails: { rail: 'balance' } }),
  };
}

function challenge402(intent = 'charge'): Response {
  return new Response(null, {
    status: 402,
    headers: { 'WWW-Authenticate': renderChallengeHeader(challenge('inflow', intent)) },
  });
}

function makeClient(overrides: Partial<MppClient> = {}): MppClient {
  return {
    createTransaction: vi.fn(),
    getTransaction: vi.fn(),
    getConfig: vi.fn(),
    getSupported: vi.fn(),
    ...overrides,
  } as unknown as MppClient;
}

function authed(
  client: MppClient,
  cancelApproval = vi.fn(() => Promise.resolve(undefined)),
): { inflow: Inflow; storage: AuthStorage } {
  const storage = new MemoryStorage({
    access_token: 'a',
    refresh_token: 'r',
    token_type: 'Bearer',
    expires_in: 3600,
    expires_at: Date.now() + 3600 * 1000,
  });
  const inflow = new Inflow({ authStorage: storage, environment: 'sandbox', cliClientId: 'test' });
  vi.spyOn(Object.getPrototypeOf(inflow.capabilities) as ICliCapabilitiesResource, 'has').mockResolvedValue(false);
  (inflow.mpp as unknown as { cachedClient: Promise<MppClient> }).cachedClient = Promise.resolve(client);
  (inflow.mpp as unknown as { cachedMethod: { cancelApproval: typeof cancelApproval } }).cachedMethod = {
    cancelApproval,
  };
  return { inflow, storage };
}

function agentCtx<A, O>(args: A, options: O) {
  return {
    agent: true,
    formatExplicit: true,
    args,
    options,
    error: vi.fn((_err: { code: string; message: string }): never => {
      throw new Error(`c.error: ${_err.code}`);
    }),
  };
}

function agentCtxReturningError<A, O>(args: A, options: O) {
  return {
    agent: true,
    formatExplicit: true,
    args,
    options,
    error: vi.fn(
      (err: { code: string; message: string }): never => ({ code: err.code, message: err.message }) as never,
    ),
  };
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

async function drainWithReturn<T>(gen: AsyncGenerator<T, unknown>): Promise<{ values: T[]; returnValue: unknown }> {
  const values: T[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { values, returnValue: next.value };
    values.push(next.value);
  }
}

afterEach(() => vi.restoreAllMocks());

describe('mpp agent runners', () => {
  it.each([undefined, 'Merchant Legal Name'])(
    'forwards CARD merchant details and the selected instrument through the command: %s',
    async (merchantName) => {
      const offered: MppChallenge = {
        ...challenge('card'),
        request: encode({
          amount: '100',
          currency: 'usd',
          recipient: 'acct_test',
          methodDetails: {
            acceptedNetworks: ['visa'],
            merchantName: 'Example Store',
            encryptionJwk: { kty: 'RSA', alg: 'RSA-OAEP-256', use: 'enc', kid: 'test', n: 'AQAB', e: 'AQAB' },
          },
        }),
      };
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(offered) } }),
        );
      const createTransaction = vi.fn<MppClient['createTransaction']>().mockResolvedValue({
        state: 'pending',
        transactionId: 'tx-card',
        approvalId: 'approval-card',
      });
      const { inflow, storage } = authed(makeClient({ createTransaction }));
      const instrumentId = '00000000-0000-4000-8000-000000000001';
      const context = agentCtx(
        { url: SELLER },
        payOptions.parse({
          instrumentId,
          merchantName,
          merchantUrl: 'https://merchant.test',
          merchantCountry: 'US',
          paymentMethod: 'card',
          intent: 'charge',
          currency: 'usd',
        }),
      );
      await drain(runPayCommand(context, inflow, storage, 'https://app'));
      expect(createTransaction).toHaveBeenCalledOnce();
      expect(createTransaction.mock.calls[0]?.[0]).toMatchObject({
        challenge: offered,
        options: {
          instrumentId,
          merchant: {
            name: merchantName ?? 'Example Store',
            url: 'https://merchant.test',
            countryCode: 'US',
          },
        },
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { merchantName: 'Seller', paymentMethod: 'inflow' },
    { merchantUrl: 'https://merchant.test', rail: 'balance' },
    { merchantCountry: 'US', intent: 'subscription' },
    { instrumentId: '00000000-0000-4000-8000-000000000001', rail: 'balance' },
  ])('rejects incompatible payment choices before contacting the seller: %j', async (options) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const createTransaction = vi.fn();
    const client = makeClient({ createTransaction });
    const { inflow, storage } = authed(client);
    const context = agentCtxReturningError({ url: SELLER }, payOptions.parse(options));
    const result = await drainWithReturn(runPayCommand(context, inflow, storage, 'https://app'));
    expect(result.returnValue).toMatchObject({ code: 'INVALID_PAYMENT_OPTIONS' });
    expect(fetch).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it.each([
    { binary: false, destination: 'inline' },
    { binary: true, destination: 'inline' },
    { binary: false, destination: 'hidden' },
    { binary: true, destination: 'hidden' },
    { binary: false, destination: 'file' },
    { binary: true, destination: 'file' },
  ])(
    'delivers an unpaid response without creating a payment: $destination binary=$binary',
    async ({ binary, destination }) => {
      const directory = await mkdtemp(join(tmpdir(), 'inflow-body-test-'));
      const outputFile = join(directory, 'response.bin');
      const bytes = binary ? new Uint8Array([0, 255, 128, 1]) : new TextEncoder().encode('Seller content');
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(bytes, {
          headers: { 'Content-Type': binary ? 'application/octet-stream' : 'text/plain' },
        }),
      );
      const { inflow, storage } = authed(makeClient());
      const context = agentCtx(
        { url: 'https://seller.test/api' },
        payOptions.parse({
          showBody: destination !== 'hidden',
          ...(destination === 'file' ? { outputFile } : {}),
        }),
      );
      try {
        const frames = await drain(runPayCommand(context, inflow, storage, 'https://platform.test'));
        const result = frames.at(-1);
        expect(result).toMatchObject({ outcome: 'no-payment-required', status: 200, body_size_bytes: bytes.length });
        if (destination === 'file') {
          expect(result).toHaveProperty('output_saved_to', outputFile);
          expect(await readFile(outputFile)).toEqual(Buffer.from(bytes));
        } else expect(result).not.toHaveProperty('output_saved_to');
        if (destination === 'inline') {
          expect(result).toHaveProperty(
            binary ? 'body_base64' : 'body',
            binary ? Buffer.from(bytes).toString('base64') : 'Seller content',
          );
          expect(result).not.toHaveProperty(binary ? 'body' : 'body_base64');
        } else {
          expect(result).not.toHaveProperty('body');
          expect(result).not.toHaveProperty('body_base64');
        }
        expect(fetch).toHaveBeenCalledOnce();
        expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('selects a subscription by its advertised option and preserves its terms in pending output', async () => {
    const offers = ['day', 'month'].map((periodUnit) => ({
      ...challenge('inflow', 'subscription'),
      id: `subscription-${periodUnit}`,
      request: encode({
        amount: '10',
        currency: 'USDC',
        methodDetails: { rail: 'balance' },
        periodCount: 1,
        periodUnit,
        subscriptionExpires: '2999-01-01T00:00:00Z',
        externalId: `${periodUnit}-plan`,
      }),
    }));
    const selected = offers[1];
    if (selected === undefined) throw new Error('Missing test offer');
    const option = subscriptionOptionFingerprint(selected);
    if (option === undefined) throw new Error('Missing subscription option');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, {
        status: 402,
        headers: { 'WWW-Authenticate': offers.map(renderChallengeHeader).join(', ') },
      }),
    );
    const createTransaction = vi.fn<MppClient['createTransaction']>().mockResolvedValue({
      state: 'pending',
      transactionId: 'sub-1',
      approvalId: 'approval-1',
      retryAfterSeconds: 5,
    });
    const { inflow, storage } = authed(makeClient({ createTransaction }));
    const context = agentCtx(
      { url: SELLER },
      {
        ...payOptions.parse({}),
        optionId: option.optionId,
        paymentMethod: 'inflow',
        currency: 'USDC',
        rail: 'balance',
      },
    );
    const frames = await drain(runSubscribeCommand(context, inflow, storage, 'https://app'));
    expect(createTransaction).toHaveBeenCalledOnce();
    expect(createTransaction.mock.calls[0]?.[0].challenge).toEqual(selected);
    expect(frames.at(-1)).toMatchObject({
      state: 'pending',
      transaction_id: 'sub-1',
      retry_after_seconds: 5,
      challenge: {
        id: 'subscription-month',
        period_count: 1,
        period_unit: 'month',
        subscription_expires: '2999-01-01T00:00:00Z',
        external_id: 'month-plan',
        option_id: option.optionId,
        option_fingerprint: option.fingerprint,
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(['USDC', 'EUR'])('applies all inspection filters for currency %s without purchasing', async (currency) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(challenge402());
    const ctx = agentCtx(
      { url: SELLER },
      { method: 'GET', header: [], paymentMethod: 'inflow', intent: 'charge', currency, rail: 'balance' },
    );
    if (currency === 'USDC') {
      expect(await runInspectCommand(ctx)).toMatchObject({
        outcome: 'challenges',
        challenges: [{ method: 'inflow', intent: 'charge', currency: 'USDC', rail: 'balance' }],
      });
    } else {
      await expect(runInspectCommand(ctx)).rejects.toThrow('NO_FILTERED_MATCH');
    }
    expect(fetch).toHaveBeenCalledOnce();
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Accept-Payment')).toContain('inflow/charge');
  });

  it.each(['pay', 'fetch'] as const)('rejects malformed %s headers before any network request', async (command) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { inflow, storage } = authed(makeClient());
    if (command === 'pay') {
      const ctx = agentCtx({ url: 'https://seller.test/api' }, payOptions.parse({ header: ['missing-colon'] }));
      await expect(drain(runPayCommand(ctx, inflow, storage, 'https://platform.test'))).rejects.toThrow(
        'INVALID_HEADER',
      );
      expect(ctx.error).toHaveBeenCalledOnce();
    } else {
      const ctx = agentCtx(
        { transactionId: 'tx-1', resourceUrl: 'https://seller.test/api' },
        fetchOptions.parse({ header: ['missing-colon'] }),
      );
      await expect(drain(runFetchCommand(ctx, inflow, storage))).rejects.toThrow('INVALID_HEADER');
      expect(ctx.error).toHaveBeenCalledOnce();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: 'about:blank', title: 'Declined', status: 402, detail: 'Insufficient balance' }, 'Insufficient balance'],
    [undefined, 'MPP transaction failed.'],
  ] as const)('preserves the terminal failure and selects its user-facing message: %j', async (problem, message) => {
    const response = { transactionId: 'tx-1', state: 'failed' as const, ...(problem === undefined ? {} : { problem }) };
    const getTransaction = vi.fn<MppClient['getTransaction']>().mockResolvedValue(response);
    const createTransaction = vi.fn<MppClient['createTransaction']>();
    const client = makeClient({ getTransaction, createTransaction });
    const { inflow, storage } = authed(client);
    const ctx = agentCtxReturningError({ transactionId: 'tx-1' }, { interval: 0.01, maxAttempts: 5, timeout: 60 });
    const result = await drainWithReturn(runStatusCommand(ctx, inflow, storage));
    expect(result.values).toEqual([
      { transaction_id: 'tx-1', state: 'failed', ...(problem === undefined ? {} : { problem }) },
    ]);
    expect(ctx.error).toHaveBeenCalledOnce();
    expect(ctx.error).toHaveBeenCalledWith({ code: 'PAYMENT_FAILED', message });
    expect(getTransaction).toHaveBeenCalledOnce();
    expect(getTransaction).toHaveBeenCalledWith('tx-1');
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it('returns the latest pending snapshot and a retryable timeout without creating a payment', async () => {
    const getTransaction = vi.fn<MppClient['getTransaction']>().mockResolvedValue({
      transactionId: 'tx-1',
      state: 'pending',
      approvalId: 'ap-1',
      retryAfterSeconds: 5,
    });
    const createTransaction = vi.fn<MppClient['createTransaction']>();
    const client = makeClient({ getTransaction, createTransaction });
    const { inflow, storage } = authed(client);
    const ctx = agentCtxReturningError({ transactionId: 'tx-1' }, { interval: 0.01, maxAttempts: 1, timeout: 60 });
    const result = await drainWithReturn(runStatusCommand(ctx, inflow, storage));
    expect(result.values).toEqual([
      {
        transaction_id: 'tx-1',
        state: 'pending',
        approval_id: 'ap-1',
        retry_after_seconds: 5,
      },
    ]);
    expect(ctx.error).toHaveBeenCalledOnce();
    expect(ctx.error).toHaveBeenCalledWith({
      code: 'POLLING_TIMEOUT',
      message: 'Polling timed out before the transaction reached a ready state.',
      retryable: true,
    });
    expect(getTransaction).toHaveBeenCalledOnce();
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it('reports a polling failure after a pending snapshot without retrying or creating another transaction', async () => {
    const getTransaction = vi
      .fn<MppClient['getTransaction']>()
      .mockResolvedValueOnce({ transactionId: 'tx-1', state: 'pending' })
      .mockRejectedValueOnce(new Error('Connection interrupted'));
    const createTransaction = vi.fn<MppClient['createTransaction']>();
    const client = makeClient({ getTransaction, createTransaction });
    const { inflow, storage } = authed(client);
    const ctx = agentCtxReturningError({ transactionId: 'tx-1' }, { interval: 0.001, maxAttempts: 5, timeout: 60 });
    const result = await drainWithReturn(runStatusCommand(ctx, inflow, storage));
    expect(result.values).toEqual([{ transaction_id: 'tx-1', state: 'pending' }]);
    expect(ctx.error).toHaveBeenCalledOnce();
    expect(ctx.error).toHaveBeenCalledWith({ code: 'PAYMENT_FAILED', message: 'Connection interrupted' });
    expect(getTransaction).toHaveBeenCalledTimes(2);
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it('dispatches parsed MPP commands without leaking stored credentials or requesting a second payment', async () => {
    const getTransaction = vi.fn<MppClient['getTransaction']>(() =>
      Promise.resolve({ transactionId: 'tx-1', state: 'ready', credential: 'CRED' }),
    );
    const createTransaction = vi.fn<MppClient['createTransaction']>();
    const cancelApproval = vi.fn(() => Promise.resolve());
    const { inflow, storage } = authed(
      makeClient({
        getTransaction,
        createTransaction,
        getSupported: vi.fn<MppClient['getSupported']>(() => Promise.resolve({ kinds: [] })),
      }),
      cancelApproval,
    );
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('public content')));
    const cli = createMppCli(inflow, storage, 'https://app');
    const execute = async (args: string[]) => {
      const chunks: string[] = [];
      const exit = vi.fn();
      await cli.serve([...args, '--format', 'json'], {
        exit,
        stdout: (chunk) => {
          chunks.push(chunk);
        },
      });
      const output = chunks.join('');
      expect(exit, output).not.toHaveBeenCalled();
      return output;
    };
    expect(await execute(['supported'])).toContain('"kinds": []');
    expect(await execute(['decode', renderChallengeHeader(challenge())])).toContain('chal-inflow-charge');
    expect(await execute(['inspect', SELLER])).toContain('no-payment-required');
    expect(await execute(['pay', SELLER])).toContain('no-payment-required');
    expect(await execute(['subscribe', SELLER])).toContain('no-payment-required');
    expect(await execute(['status', 'tx-1'])).toContain('"state": "ready"');
    const output = await execute(['fetch', 'tx-1', SELLER]);
    expect(output).toContain('public content');
    expect(output).not.toContain('CRED');
    expect(await execute(['cancel', 'ap-1'])).toContain('"cancelled": true');
    expect(cancelApproval).toHaveBeenCalledWith('ap-1');
    expect(createTransaction).not.toHaveBeenCalled();
    expect(getTransaction).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([input]) => new Request(input).url)).toEqual([
      'https://seller.test/.well-known/aep',
      SELLER,
      SELLER,
      SELLER,
      SELLER,
    ]);
  });

  it('passes merchant flags from the command into CARD transaction options', async () => {
    const offered = {
      ...challenge('card'),
      request: encode({
        amount: '100',
        currency: 'usd',
        recipient: 'acct_test',
        methodDetails: {
          merchantName: 'Advertised Store',
          acceptedNetworks: ['visa'],
          encryptionJwk: { kty: 'RSA', alg: 'RSA-OAEP-256', use: 'enc', kid: 'test', n: 'AQAB', e: 'AQAB' },
        },
      }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(offered) } }),
    );
    const createTransaction = vi.fn<MppClient['createTransaction']>(() =>
      Promise.resolve({ state: 'pending', transactionId: 'card-tx', approvalId: 'card-approval' }),
    );
    const { inflow, storage } = authed(makeClient({ createTransaction }));
    const ctx = agentCtx(
      { url: SELLER },
      {
        method: 'GET',
        header: [],
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: true,
        merchantName: 'Legal Store',
        merchantUrl: 'https://store.test',
        merchantCountry: 'US',
      },
    );
    const frames = await drain(runPayCommand(ctx, inflow, storage, 'https://app'));
    expect(frames.at(-1)).toMatchObject({ state: 'pending', transaction_id: 'card-tx', approval_id: 'card-approval' });
    expect(createTransaction).toHaveBeenCalledWith({
      challenge: offered,
      options: { merchant: { name: 'Legal Store', url: 'https://store.test', countryCode: 'US' } },
    });
  });
  it('redacts CARD credentials from status output', async () => {
    const credential = encode({ challenge: challenge('card'), payload: { encryptedPayload: 'secret' } });
    const { inflow, storage } = authed(
      makeClient({
        getTransaction: vi.fn(() => Promise.resolve({ state: 'ready' as const, transactionId: 'card-tx', credential })),
      }),
    );
    const frames = await drain(
      runStatusCommand(
        agentCtx({ transactionId: 'card-tx' }, { interval: 0, maxAttempts: 0, timeout: 900 }),
        inflow,
        storage,
      ),
    );
    expect(frames).toEqual([expect.objectContaining({ state: 'ready', credential: '<redacted>' })]);
    expect(JSON.stringify(frames)).not.toContain(credential);
  });
  it('runSupportedCommand returns the buyer-supported kinds', async () => {
    const supported = {
      kinds: [
        { method: 'inflow', intents: [{ intent: 'charge', rails: [{ rail: 'balance', currencies: ['USDC'] }] }] },
      ],
    };
    const { inflow, storage } = authed(makeClient({ getSupported: vi.fn(() => Promise.resolve(supported)) }));
    const ctx = { agent: true, formatExplicit: true, error: vi.fn() };
    const out = await runSupportedCommand(ctx as never, inflow, storage);
    expect(out).toEqual(supported);
  });

  it('runSupportedCommand maps server 401 responses to NOT_AUTHENTICATED', async () => {
    const { inflow, storage } = authed(
      makeClient({ getSupported: vi.fn(() => Promise.reject(new InflowApiError('Unauthorized', { status: 401 }))) }),
    );
    const ctx = agentCtxReturningError({}, {});
    const out = await runSupportedCommand(ctx, inflow, storage);
    expect(out).toMatchObject({ code: 'NOT_AUTHENTICATED' });
  });

  it('runSupportedCommand rethrows non-authentication failures', async () => {
    const failure = new Error('supported unavailable');
    const { inflow, storage } = authed(makeClient({ getSupported: vi.fn(() => Promise.reject(failure)) }));
    const ctx = agentCtxReturningError({}, {});
    await expect(runSupportedCommand(ctx, inflow, storage)).rejects.toBe(failure);
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it('runCancelCommand delegates to cancelApproval', async () => {
    const cancelApproval = vi.fn(() => Promise.resolve(undefined));
    const { inflow, storage } = authed(makeClient(), cancelApproval);
    const ctx = { agent: true, formatExplicit: true, args: { approvalId: 'ap-1' }, error: vi.fn() };
    const out = await runCancelCommand(ctx as never, inflow, storage);
    expect(cancelApproval).toHaveBeenCalledWith('ap-1');
    expect(out).toMatchObject({ approval_id: 'ap-1', cancelled: true });
  });

  it('runCancelCommand maps server 401 responses to NOT_AUTHENTICATED', async () => {
    const cancelApproval = vi.fn(() => Promise.reject(new InflowApiError('Unauthorized', { status: 401 })));
    const { inflow, storage } = authed(makeClient(), cancelApproval);
    const ctx = agentCtxReturningError({ approvalId: 'ap-1' }, {});
    const out = await runCancelCommand(ctx, inflow, storage);
    expect(out).toMatchObject({ code: 'NOT_AUTHENTICATED' });
  });

  it('runCancelCommand reports a locked vault in agent mode', async () => {
    const cancelApproval = vi.fn(() =>
      Promise.reject(new SecureStorageError('vault_locked', 'The InFlow vault is locked.')),
    );
    const { inflow, storage } = authed(makeClient(), cancelApproval);
    const ctx = agentCtxReturningError({ approvalId: 'ap-1' }, {});
    const out = await runCancelCommand(ctx, inflow, storage);
    expect(out).toMatchObject({ code: 'VAULT_LOCKED' });
  });

  it('runCancelCommand rethrows non-authentication failures', async () => {
    const failure = new Error('cancel unavailable');
    const cancelApproval = vi.fn(() => Promise.reject(failure));
    const { inflow, storage } = authed(makeClient(), cancelApproval);
    const ctx = agentCtxReturningError({ approvalId: 'ap-1' }, {});
    await expect(runCancelCommand(ctx, inflow, storage)).rejects.toBe(failure);
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it('runStatusCommand (interval 0) yields a single ready snapshot', async () => {
    const client = makeClient({
      getTransaction: vi.fn(() =>
        Promise.resolve({
          transactionId: 'tx-1',
          state: 'ready',
          credential: 'CRED',
        }),
      ) as MppClient['getTransaction'],
    });
    const { inflow, storage } = authed(client);
    const ctx = agentCtx({ transactionId: 'tx-1' }, { interval: 0, maxAttempts: 0, timeout: 900 });
    const frames = await drain(runStatusCommand(ctx as never, inflow, storage));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ transaction_id: 'tx-1', state: 'ready', credential: 'CRED' });
  });

  it('runStatusCommand (interval > 0) yields a ready terminal frame', async () => {
    const responses = [
      { transactionId: 'tx-1', state: 'pending' as const, retryAfterSeconds: 0 },
      { transactionId: 'tx-1', state: 'ready' as const, credential: 'CRED' },
    ];
    const client = makeClient({
      getTransaction: vi.fn(() => Promise.resolve(responses.shift() ?? responses[0])) as MppClient['getTransaction'],
    });
    const { inflow, storage } = authed(client);
    const ctx = agentCtx({ transactionId: 'tx-1' }, { interval: 0.01, maxAttempts: 0, timeout: 900 });
    const frames = await drain(runStatusCommand(ctx as never, inflow, storage));
    expect(frames.at(-1)).toMatchObject({ transaction_id: 'tx-1', state: 'ready', credential: 'CRED' });
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it('runStatusCommand maps server 401 responses to NOT_AUTHENTICATED', async () => {
    const client = makeClient({
      getTransaction: vi.fn(() => Promise.reject(new InflowApiError('Unauthorized', { status: 401 }))),
    });
    const { inflow, storage } = authed(client);
    const ctx = agentCtxReturningError({ transactionId: 'tx-1' }, { interval: 0, maxAttempts: 0, timeout: 900 });
    const result = await drainWithReturn(runStatusCommand(ctx as never, inflow, storage));
    expect(result.returnValue).toMatchObject({ code: 'NOT_AUTHENTICATED' });
  });

  it('runPayCommand short-circuits on a 200 probe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('FREE', { status: 200 }));
    const { inflow, storage } = authed(makeClient());
    const ctx = agentCtx(
      { url: SELLER },
      { method: 'GET', header: [], interval: 0, maxAttempts: 0, timeout: 900, showBody: true },
    );
    const frames = await drain(runPayCommand(ctx as never, inflow, storage, 'https://app'));
    expect(frames.at(-1)).toMatchObject({ outcome: 'no-payment-required', status: 200 });
  });

  it('runPayCommand drives a full pay to the paid frame', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(challenge402());
    fetchSpy.mockResolvedValueOnce(new Response('PAID', { status: 200 }));
    const client = makeClient({
      createTransaction: vi.fn(() =>
        Promise.resolve({
          state: 'ready',
          credential: 'CRED',
          transactionId: 'tx-1',
        }),
      ) as MppClient['createTransaction'],
    });
    const { inflow, storage } = authed(client);
    const ctx = agentCtx(
      { url: SELLER },
      { method: 'GET', header: [], interval: 5, maxAttempts: 0, timeout: 900, showBody: true },
    );
    const frames = await drain(runPayCommand(ctx as never, inflow, storage, 'https://app'));
    expect(frames.at(-1)).toMatchObject({ outcome: 'paid', transaction_id: 'tx-1', credential: 'CRED' });
  });

  it('runPayCommand reports an unknown outcome when the credential-bearing replay transport fails', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(challenge402())
      .mockResolvedValueOnce(challenge402())
      .mockRejectedValueOnce(new Error('connection reset'));
    const client = makeClient({
      createTransaction: vi.fn(() =>
        Promise.resolve({
          state: 'ready',
          credential: 'CRED',
          transactionId: 'tx-1',
        }),
      ) as MppClient['createTransaction'],
    });
    const { inflow, storage } = authed(client);
    const ctx = agentCtx(
      { url: SELLER },
      { method: 'GET', header: [], interval: 5, maxAttempts: 0, timeout: 900, showBody: true },
    );

    await expect(drain(runPayCommand(ctx as never, inflow, storage, 'https://app'))).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'PAYMENT_REPLAY_OUTCOME_UNKNOWN',
        message: expect.stringContaining('do not automatically replay') as string,
      }),
    );
    expect(new Headers(fetchSpy.mock.calls[2]?.[1]?.headers).get('Authorization')).toBe('Payment CRED');
  });

  it('signs the exact MPP probe and paid replay and carries probe evidence into transaction creation', async () => {
    const createTransaction = vi.fn((_body: { tapEvidenceId?: string }) =>
      Promise.resolve({ state: 'ready' as const, transactionId: 'tx-tap', credential: 'CRED' }),
    );
    const { inflow, storage } = authed(makeClient({ createTransaction }));
    vi.spyOn(Object.getPrototypeOf(inflow.capabilities) as ICliCapabilitiesResource, 'has').mockResolvedValue(true);
    const sign = vi.spyOn(inflow.tap, 'sign').mockImplementation((request) =>
      Promise.resolve({
        created: 1,
        expires: 2,
        keyid: 'key',
        nonce: request.operation,
        signature: `sig=:${request.operation}:`,
        signatureInput: `sig=("@method");keyid="key"`,
        ...(request.operation === 'mpp.inspect' ? { tapEvidenceId: '00000000-0000-0000-0000-000000000123' } : {}),
      }),
    );
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(challenge402())
      .mockResolvedValueOnce(new Response('paid', { status: 200 }));
    const ctx = agentCtx(
      { url: SELLER },
      { method: 'GET', header: [], interval: 5, maxAttempts: 0, timeout: 900, showBody: true },
    );

    const frames = await drain(runPayCommand(ctx as never, inflow, storage, 'https://api.test'));

    expect(frames.at(-1)).toMatchObject({ outcome: 'paid', transaction_id: 'tx-tap' });
    expect(createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ tapEvidenceId: '00000000-0000-0000-0000-000000000123' }),
    );
    expect(sign.mock.calls.map(([request]) => [request.operation, request.targetUrl, request.transactionId])).toEqual([
      ['mpp.inspect', SELLER, undefined],
      ['mpp.payment', SELLER, 'tx-tap'],
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init?.headers).has('Signature')).toBe(true);
    }
  });

  it('runSubscribeCommand drives a subscription challenge to a paid frame with intent subscription', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(challenge402('subscription'));
    fetchSpy.mockResolvedValueOnce(
      new Response('SUBBED', {
        status: 200,
        headers: {
          'Payment-Receipt': encode({
            method: 'inflow',
            reference: 'sub-1',
            settlement: { amount: '10', currency: 'USDC' },
            status: 'success',
            subscriptionId: 'subscription-id',
            timestamp: '2026-08-01T00:00:00Z',
          }),
        },
      }),
    );
    const client = makeClient({
      createTransaction: vi.fn(() =>
        Promise.resolve({ state: 'ready', credential: 'CRED', transactionId: 'sub-1' }),
      ) as MppClient['createTransaction'],
    });
    const { inflow, storage } = authed(client);
    // No `intent` in options: subscribe pins it internally.
    const ctx = agentCtx(
      { url: SELLER },
      { method: 'GET', header: [], interval: 5, maxAttempts: 0, timeout: 900, showBody: true },
    );
    const frames = await drain(runSubscribeCommand(ctx as never, inflow, storage, 'https://app'));
    expect(frames.at(-1)).toMatchObject({
      credential: 'CRED',
      intent: 'subscription',
      outcome: 'paid',
      transaction_id: 'sub-1',
    });
  });

  it('runSubscribeCommand pins the intent, rejecting a charge-only challenge that plain pay would accept', async () => {
    // The seller offers only a `charge` challenge; because subscribe forces --intent=subscription it filters to none.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(challenge402('charge'));
    const { inflow, storage } = authed(makeClient());
    const ctx = agentCtx(
      { url: SELLER },
      { method: 'GET', header: [], interval: 5, maxAttempts: 0, timeout: 900, showBody: true },
    );
    await expect(drain(runSubscribeCommand(ctx as never, inflow, storage, 'https://app'))).rejects.toThrow(
      'c.error: NO_FILTERED_MATCH',
    );
  });

  it.each([200, 403].flatMap((status) => [false, true].map((save) => ({ status, save }))))(
    'runFetchCommand resumes without another transaction or credential disclosure (status $status, save $save)',
    async ({ status, save }) => {
      const directory = await mkdtemp(join(tmpdir(), 'mpp-fetch-output-'));
      const outputFile = join(directory, 'response.txt');
      try {
        const fetchSpy = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValueOnce(challenge402())
          .mockResolvedValueOnce(
            new Response('DONE', {
              status,
              headers: save
                ? {
                    'Payment-Receipt': encode({
                      challengeId: 'chal-inflow-charge',
                      method: 'inflow',
                      reference: 'settlement-1',
                      status: 'success',
                      timestamp: '2026-01-01T00:00:00Z',
                      settlement: { amount: '10', currency: 'USDC' },
                    }),
                  }
                : {},
            }),
          );
        const createTransaction = vi.fn();
        const client = makeClient({
          createTransaction: createTransaction as MppClient['createTransaction'],
          getTransaction: vi.fn(() =>
            Promise.resolve({
              state: 'ready',
              credential: 'CRED',
              transactionId: 'tx-1',
            }),
          ) as MppClient['getTransaction'],
        });
        const { inflow, storage } = authed(client);
        const pending = __testing.createdFrameFromEvent(
          {
            transactionId: 'tx-1',
            state: 'pending',
            approvalId: 'ap-1',
            approvalUrl: 'https://app/approvals/ap-1',
            challenge: { id: 'chal-inflow-charge', realm: 'mpp.test', method: 'inflow', intent: 'charge' },
          },
          agentCtx({ url: SELLER }, payOptions.parse({ header: ['Authorization: caller'] })),
        );
        const next = pending['_next'] as { tool: string; input: Record<string, unknown> };
        expect(next.tool).toBe('mpp_fetch');
        const ctx = agentCtx(
          fetchArgs.parse(next.input),
          fetchOptions.parse({ ...next.input, header: ['Authorization: caller'], ...(save ? { outputFile } : {}) }),
        );

        const frames: unknown[] = [];
        const operation = (async () => {
          for await (const frame of runFetchCommand(ctx, inflow, storage)) frames.push(frame);
        })();
        if (status === 200) await operation;
        else await expect(operation).rejects.toThrow('PAYMENT_NOT_ACCEPTED');

        expect(createTransaction).not.toHaveBeenCalled();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(frames.at(-1)).toMatchObject({
          protocol: 'mpp',
          outcome: status === 200 ? 'paid' : 'seller-rejected',
          transaction_id: 'tx-1',
          requested_url: SELLER,
          ...(save ? { output_saved_to: outputFile } : { body: 'DONE' }),
        });
        expect(frames.at(-1)).not.toHaveProperty('credential');
        if (save && status === 200)
          expect(frames.at(-1)).toHaveProperty('settled', {
            amount: '10',
            currency: 'USDC',
            reference: 'settlement-1',
            status: 'success',
            timestamp: '2026-01-01T00:00:00Z',
          });
        else expect(frames.at(-1)).not.toHaveProperty('settled');
        const [, init] = fetchSpy.mock.calls.at(-1) ?? [];
        expect(new Headers(init?.headers).get('Authorization')).toBe('Payment CRED');
        if (save) {
          expect(await readFile(outputFile, 'utf8')).toBe('DONE');
          expect(frames.at(-1)).not.toHaveProperty('body');
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([0, 1])('runFetchCommand renders the human fetch path with interval %s', async (interval) => {
    const directory = await mkdtemp(join(tmpdir(), 'mpp-fetch-human-'));
    const outputFile = join(directory, 'response.txt');
    try {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(challenge402())
        .mockResolvedValueOnce(new Response('DONE', { status: 200 }));
      const client = makeClient({
        getTransaction: vi.fn(() =>
          Promise.resolve({
            state: 'ready',
            credential: 'CRED',
            transactionId: 'tx-1',
          }),
        ) as MppClient['getTransaction'],
      });
      const { inflow, storage } = authed(client);
      const ctx = {
        agent: false,
        formatExplicit: false,
        args: { transactionId: 'tx-1', resourceUrl: SELLER },
        options: { method: 'GET', header: [], interval, maxAttempts: 0, timeout: 900, showBody: true, outputFile },
        error: vi.fn(),
      };

      const result = await drainWithReturn(runFetchCommand(ctx as never, inflow, storage));

      expect(result.values).toEqual([]);
      expect(ctx.error).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(await readFile(outputFile, 'utf8')).toBe('DONE');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runFetchCommand stops terminal failures before contacting the seller', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { inflow, storage } = authed(
      makeClient({
        getTransaction: vi.fn(() =>
          Promise.resolve({ state: 'expired', transactionId: 'tx-1' }),
        ) as MppClient['getTransaction'],
      }),
    );
    const ctx = agentCtxReturningError(
      { transactionId: 'tx-1', resourceUrl: SELLER },
      { method: 'GET', header: [], interval: 0, maxAttempts: 0, timeout: 900, showBody: false },
    );

    const result = await drainWithReturn(runFetchCommand(ctx as never, inflow, storage));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.returnValue).toMatchObject({ code: 'PAYMENT_EXPIRED' });
  });

  it('runInspectCommand returns the challenges frame', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(challenge402());
    const ctx = {
      agent: true,
      formatExplicit: true,
      args: { url: SELLER },
      options: { method: 'GET', header: [] },
      error: vi.fn(),
    };
    const out = (await runInspectCommand(ctx as never)) as Record<string, unknown>;
    expect(out['outcome']).toBe('challenges');
  });

  it('runInspectCommand signs its merchant probe as MPP inspection', async () => {
    const { inflow, storage } = authed(makeClient());
    vi.spyOn(Object.getPrototypeOf(inflow.capabilities) as ICliCapabilitiesResource, 'has').mockResolvedValue(true);
    const sign = vi.spyOn(inflow.tap, 'sign').mockResolvedValue({
      created: 1,
      expires: 2,
      keyid: 'key',
      nonce: 'nonce',
      signature: 'sig=:value:',
      signatureInput: 'sig=("@method");keyid="key"',
      tapEvidenceId: '00000000-0000-0000-0000-000000000123',
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(url.includes('/.well-known/aep') ? new Response(null, { status: 404 }) : challenge402());
    });
    const ctx = agentCtx({ url: SELLER }, { method: 'GET', header: [] });

    const out = await runInspectCommand(ctx, inflow, storage);

    expect(out?.['outcome']).toBe('challenges');
    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', operation: 'mpp.inspect', targetUrl: SELLER }),
      expect.any(Object),
    );
    const sellerCall = fetch.mock.calls.find(([input]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url === SELLER;
    });
    expect(new Headers(sellerCall?.[1]?.headers).has('Signature')).toBe(true);
  });

  it('runInspectCommand returns the no-payment frame on a 2xx probe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('FREE', { status: 200 }));
    const ctx = {
      agent: true,
      formatExplicit: true,
      args: { url: SELLER },
      options: { method: 'GET', header: [] },
      error: vi.fn(),
    };
    const out = (await runInspectCommand(ctx as never)) as Record<string, unknown>;
    expect(out['outcome']).toBe('no-payment-required');
  });

  it('runInspectCommand surfaces a probe error through c.error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const ctx = {
      agent: true,
      formatExplicit: true,
      args: { url: SELLER },
      options: { method: 'GET', header: [] },
      error: vi.fn((err: { code: string }): never => {
        throw new Error(`c.error: ${err.code}`);
      }),
    };
    await expect(runInspectCommand(ctx as never)).rejects.toThrow('c.error: UNEXPECTED_PROBE_STATUS');
  });

  it('runInspectCommand surfaces malformed --header through c.error', async () => {
    const ctx = {
      agent: true,
      formatExplicit: true,
      args: { url: SELLER },
      options: { method: 'GET', header: ['bad-header'] },
      error: vi.fn((err: { code: string }): never => {
        throw new Error(`c.error: ${err.code}`);
      }),
    };
    await expect(runInspectCommand(ctx as never)).rejects.toThrow('c.error: INVALID_HEADER');
  });

  it('runPayCommand surfaces a seller-rejected replay through c.error after yielding the frame', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(challenge402());
    fetchSpy.mockResolvedValueOnce(challenge402());
    fetchSpy.mockResolvedValueOnce(new Response('nope', { status: 402 }));
    const client = makeClient({
      createTransaction: vi.fn(() =>
        Promise.resolve({
          state: 'ready',
          credential: 'CRED',
          transactionId: 'tx-1',
        }),
      ) as MppClient['createTransaction'],
    });
    const { inflow, storage } = authed(client);
    const ctx = agentCtx(
      { url: SELLER },
      { method: 'GET', header: [], interval: 5, maxAttempts: 0, timeout: 900, showBody: true },
    );
    await expect(drain(runPayCommand(ctx as never, inflow, storage, 'https://app'))).rejects.toThrow(
      'c.error: PAYMENT_NOT_ACCEPTED',
    );
  });

  it('runPayCommand surfaces a pipeline error (no supported MPP challenge) through c.error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(challenge('other')) } }),
    );
    const { inflow, storage } = authed(makeClient());
    const ctx = agentCtx(
      { url: SELLER },
      { method: 'GET', header: [], interval: 5, maxAttempts: 0, timeout: 900, showBody: true },
    );
    await expect(drain(runPayCommand(ctx as never, inflow, storage, 'https://app'))).rejects.toThrow(
      'c.error: NO_INFLOW_MATCH',
    );
  });

  it('runPayCommand returns the c.error sentinel when an awaited transaction expires', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(challenge402());
    const client = makeClient({
      createTransaction: vi.fn(() =>
        Promise.resolve({
          state: 'pending',
          transactionId: 'tx-expired',
          approvalId: 'ap-expired',
          approvalUrl: 'https://sandbox.inflowpay.ai/approvals/ap-expired/view/',
          retryAfterSeconds: 1,
        }),
      ) as MppClient['createTransaction'],
      getTransaction: vi.fn(() =>
        Promise.resolve({
          transactionId: 'tx-expired',
          state: 'expired',
        }),
      ) as MppClient['getTransaction'],
    });
    const { inflow, storage } = authed(client);
    const ctx = agentCtxReturningError(
      { url: SELLER },
      { method: 'GET', header: [], interval: 0.01, maxAttempts: 0, timeout: 900, showBody: true },
    );
    const result = await drainWithReturn(runPayCommand(ctx as never, inflow, storage, 'https://app'));
    expect(result.values).toHaveLength(1);
    expect(result.values[0]).toMatchObject({ transaction_id: 'tx-expired', approval_id: 'ap-expired' });
    expect(result.returnValue).toMatchObject({ code: 'PAYMENT_EXPIRED' });
  });

  it('runStatusCommand (interval > 0) errors PAYMENT_FAILED on a failed terminal', async () => {
    const getTransaction = vi.fn(() =>
      Promise.resolve({
        transactionId: 'tx-1',
        state: 'failed' as const,
        problem: {
          type: 'https://paymentauth.org/problems/verification-failed',
          title: 'fail',
          status: 402,
          detail: 'declined',
        },
      }),
    );
    const { inflow, storage } = authed(makeClient({ getTransaction: getTransaction }));
    const ctx = agentCtx({ transactionId: 'tx-1' }, { interval: 0.01, maxAttempts: 0, timeout: 900 });
    await expect(drain(runStatusCommand(ctx as never, inflow, storage))).rejects.toThrow('c.error: PAYMENT_FAILED');
  });

  it('runStatusCommand (interval > 0) errors PAYMENT_EXPIRED on an expired terminal', async () => {
    const getTransaction = vi.fn(() => Promise.resolve({ transactionId: 'tx-1', state: 'expired' }));
    const { inflow, storage } = authed(makeClient({ getTransaction: getTransaction as MppClient['getTransaction'] }));
    const ctx = agentCtx({ transactionId: 'tx-1' }, { interval: 0.01, maxAttempts: 0, timeout: 900 });
    await expect(drain(runStatusCommand(ctx as never, inflow, storage))).rejects.toThrow('c.error: PAYMENT_EXPIRED');
  });

  it('runStatusCommand (interval > 0) errors POLLING_TIMEOUT when max attempts are exhausted', async () => {
    const getTransaction = vi.fn(() =>
      Promise.resolve({ transactionId: 'tx-1', state: 'pending', retryAfterSeconds: 0 }),
    );
    const { inflow, storage } = authed(makeClient({ getTransaction: getTransaction as MppClient['getTransaction'] }));
    const ctx = agentCtx({ transactionId: 'tx-1' }, { interval: 0.01, maxAttempts: 2, timeout: 900 });
    await expect(drain(runStatusCommand(ctx as never, inflow, storage))).rejects.toThrow('c.error: POLLING_TIMEOUT');
  });

  it('createMppCli registers the full MPP command group', () => {
    const { inflow, storage } = authed(makeClient());
    const cli = createMppCli(inflow, storage, 'https://app');
    expect(cli).toBeDefined();
  });
});
