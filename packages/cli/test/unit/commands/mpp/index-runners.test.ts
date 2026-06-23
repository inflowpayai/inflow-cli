import type { AuthStorage } from '@inflowpayai/inflow-core';
import { Inflow, MemoryStorage } from '@inflowpayai/inflow-core';
import { encode, type MppChallenge, type MppClient, renderChallengeHeader } from '@inflowpayai/mpp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testing, createMppCli } from '../../../../src/commands/mpp/index.js';

const { runPayCommand, runStatusCommand, runCancelCommand, runSupportedCommand, runInspectCommand } = __testing;

const SELLER = 'https://seller.test/api';

function challenge(method = 'inflow'): MppChallenge {
  return {
    id: `chal-${method}`,
    realm: 'mpp.test',
    method,
    intent: 'charge',
    request: encode({ amount: '10', currency: 'USDC', methodDetails: { rail: 'balance' } }),
  };
}

function challenge402(): Response {
  return new Response(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) } });
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
  cancelApproval = vi.fn(async () => undefined),
): { inflow: Inflow; storage: AuthStorage } {
  const storage = new MemoryStorage({
    access_token: 'a',
    refresh_token: 'r',
    token_type: 'Bearer',
    expires_in: 3600,
    expires_at: Date.now() + 3600 * 1000,
  });
  const inflow = new Inflow({ authStorage: storage, environment: 'sandbox', cliClientId: 'test' });
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
  while (true) {
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
    const { inflow, storage } = authed(
      makeClient({ getSupported: vi.fn(async () => supported) as MppClient['getSupported'] }),
    );
    const ctx = { agent: true, formatExplicit: true, error: vi.fn() };
    const out = await runSupportedCommand(ctx as never, inflow, storage);
    expect(out).toEqual(supported);
  });

  it('runCancelCommand delegates to cancelApproval', async () => {
    const cancelApproval = vi.fn(async () => undefined);
    const { inflow, storage } = authed(makeClient(), cancelApproval);
    const ctx = { agent: true, formatExplicit: true, args: { approvalId: 'ap-1' }, error: vi.fn() };
    const out = await runCancelCommand(ctx as never, inflow, storage);
    expect(cancelApproval).toHaveBeenCalledWith('ap-1');
    expect(out).toMatchObject({ approval_id: 'ap-1', cancelled: true });
  });

  it('runStatusCommand (interval 0) yields a single ready snapshot', async () => {
    const client = makeClient({
      getTransaction: vi.fn(async () => ({
        transactionId: 'tx-1',
        state: 'ready',
        credential: 'CRED',
      })) as MppClient['getTransaction'],
    });
    const { inflow, storage } = authed(client);
    const ctx = agentCtx({ transactionId: 'tx-1' }, { interval: 0, maxAttempts: 0, timeout: 900 });
    const frames = await drain(runStatusCommand(ctx as never, inflow, storage));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ transaction_id: 'tx-1', state: 'ready', credential: 'CRED' });
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
      createTransaction: vi.fn(async () => ({
        state: 'ready',
        credential: 'CRED',
        transactionId: 'tx-1',
      })) as MppClient['createTransaction'],
    });
    const { inflow, storage } = authed(client);
    const ctx = agentCtx(
      { url: SELLER },
      { method: 'GET', header: [], interval: 5, maxAttempts: 0, timeout: 900, showBody: true },
    );
    const frames = await drain(runPayCommand(ctx as never, inflow, storage, 'https://app'));
    expect(frames.at(-1)).toMatchObject({ outcome: 'paid', transaction_id: 'tx-1', credential: 'CRED' });
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
    expect(out.outcome).toBe('challenges');
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
    expect(out.outcome).toBe('no-payment-required');
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
    fetchSpy.mockResolvedValueOnce(new Response('nope', { status: 402 }));
    const client = makeClient({
      createTransaction: vi.fn(async () => ({
        state: 'ready',
        credential: 'CRED',
        transactionId: 'tx-1',
      })) as MppClient['createTransaction'],
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
      createTransaction: vi.fn(async () => ({
        state: 'pending',
        transactionId: 'tx-expired',
        approvalId: 'ap-expired',
        approvalUrl: 'https://sandbox.inflowpay.ai/approvals/ap-expired/view/',
        retryAfterSeconds: 1,
      })) as MppClient['createTransaction'],
      getTransaction: vi.fn(async () => ({
        transactionId: 'tx-expired',
        state: 'expired',
      })) as MppClient['getTransaction'],
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
    const getTransaction = vi.fn(async () => ({
      transactionId: 'tx-1',
      state: 'failed' as const,
      problem: {
        type: 'https://paymentauth.org/problems/verification-failed',
        title: 'fail',
        status: 402,
        detail: 'declined',
      },
    }));
    const { inflow, storage } = authed(makeClient({ getTransaction: getTransaction as MppClient['getTransaction'] }));
    const ctx = agentCtx({ transactionId: 'tx-1' }, { interval: 0.01, maxAttempts: 0, timeout: 900 });
    await expect(drain(runStatusCommand(ctx as never, inflow, storage))).rejects.toThrow('c.error: PAYMENT_FAILED');
  });

  it('runStatusCommand (interval > 0) errors PAYMENT_EXPIRED on an expired terminal', async () => {
    const getTransaction = vi.fn(async () => ({ transactionId: 'tx-1', state: 'expired' }));
    const { inflow, storage } = authed(makeClient({ getTransaction: getTransaction as MppClient['getTransaction'] }));
    const ctx = agentCtx({ transactionId: 'tx-1' }, { interval: 0.01, maxAttempts: 0, timeout: 900 });
    await expect(drain(runStatusCommand(ctx as never, inflow, storage))).rejects.toThrow('c.error: PAYMENT_EXPIRED');
  });

  it('runStatusCommand (interval > 0) errors POLLING_TIMEOUT when max attempts are exhausted', async () => {
    const getTransaction = vi.fn(async () => ({ transactionId: 'tx-1', state: 'pending', retryAfterSeconds: 0 }));
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
