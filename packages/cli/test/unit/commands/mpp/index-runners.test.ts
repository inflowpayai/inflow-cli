import type { AuthStorage, ICliCapabilitiesResource } from '@inflowpayai/inflow-core';
import { Inflow, InflowApiError, MemoryStorage } from '@inflowpayai/inflow-core';
import { encode, type MppChallenge, type MppClient, renderChallengeHeader } from '@inflowpayai/mpp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testing, createMppCli } from '../../../../src/commands/mpp/index.js';

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

  it('runFetchCommand fetches a ready transaction without creating a transaction or exposing the credential', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(challenge402())
      .mockResolvedValueOnce(new Response('DONE', { status: 200 }));
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
    const ctx = agentCtx(
      { transactionId: 'tx-1', resourceUrl: SELLER },
      { method: 'GET', header: ['Authorization: caller'], interval: 0, maxAttempts: 0, timeout: 900, showBody: true },
    );

    const frames = await drain(runFetchCommand(ctx as never, inflow, storage));

    expect(createTransaction).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(frames.at(-1)).toMatchObject({
      protocol: 'mpp',
      outcome: 'paid',
      transaction_id: 'tx-1',
      requested_url: SELLER,
      body: 'DONE',
    });
    expect(frames.at(-1)).not.toHaveProperty('credential');
    const [, init] = fetchSpy.mock.calls.at(-1) ?? [];
    expect(new Headers(init?.headers).get('Authorization')).toBe('Payment CRED');
  });

  it('runFetchCommand renders the human fetch path for ready transactions', async () => {
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
      options: { method: 'GET', header: [], interval: 0, maxAttempts: 0, timeout: 900, showBody: true },
      error: vi.fn(),
    };

    const result = await drainWithReturn(runFetchCommand(ctx as never, inflow, storage));

    expect(result.values).toEqual([]);
    expect(ctx.error).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
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
