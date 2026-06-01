import type { AuthStorage } from '@inflowpayai/inflow-core';
import { Inflow, MemoryStorage } from '@inflowpayai/inflow-core';
import { encode, type MppChallenge, type MppClient, renderChallengeHeader } from '@inflowpayai/mpp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testing } from '../../../../src/commands/mpp/index.js';

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

function challenge402(method = 'inflow'): Response {
  return new Response(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(challenge(method)) } });
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

function authed(client: MppClient): { inflow: Inflow; storage: AuthStorage } {
  const storage = new MemoryStorage({
    access_token: 'a',
    refresh_token: 'r',
    token_type: 'Bearer',
    expires_in: 3600,
    expires_at: Date.now() + 3600 * 1000,
  });
  const inflow = new Inflow({ authStorage: storage, environment: 'sandbox', cliClientId: 'test' });
  (inflow.mpp as unknown as { cachedClient: Promise<MppClient> }).cachedClient = Promise.resolve(client);
  (inflow.mpp as unknown as { cachedMethod: { cancelApproval: () => Promise<void> } }).cachedMethod = {
    cancelApproval: vi.fn(async () => undefined),
  };
  return { inflow, storage };
}

function ttyCtx<A, O>(args: A, options: O) {
  return {
    agent: false,
    formatExplicit: false,
    args,
    options,
    error: vi.fn((err: { code: string; message: string }): never => {
      throw new Error(`c.error: ${err.code}`);
    }),
  };
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe('mpp TTY runners (renderInkUntilExit paths)', () => {
  it('runPayCommand renders to completion on a successful pay and never calls c.error', async () => {
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
    const ctx = ttyCtx(
      { url: SELLER },
      { method: 'GET', header: [], interval: 5, maxAttempts: 0, timeout: 900, showBody: true },
    );
    await drain(runPayCommand(ctx as never, inflow, storage, 'https://app'));
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it('runPayCommand calls c.error when the seller rejects the credential', async () => {
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
    const ctx = ttyCtx(
      { url: SELLER },
      { method: 'GET', header: [], interval: 5, maxAttempts: 0, timeout: 900, showBody: true },
    );
    await expect(drain(runPayCommand(ctx as never, inflow, storage, 'https://app'))).rejects.toThrow(
      'c.error: PAYMENT_NOT_ACCEPTED',
    );
  });

  it('runPayCommand calls c.error when the pipeline errors (no inflow challenge)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(challenge402('other'));
    const { inflow, storage } = authed(makeClient());
    const ctx = ttyCtx(
      { url: SELLER },
      { method: 'GET', header: [], interval: 5, maxAttempts: 0, timeout: 900, showBody: true },
    );
    await expect(drain(runPayCommand(ctx as never, inflow, storage, 'https://app'))).rejects.toThrow(
      'c.error: NO_INFLOW_MATCH',
    );
  });

  it('runStatusCommand renders the status view to completion', async () => {
    const client = makeClient({
      getTransaction: vi.fn(async () => ({
        transactionId: 'tx-1',
        state: 'ready',
        credential: 'CRED',
      })) as MppClient['getTransaction'],
    });
    const { inflow, storage } = authed(client);
    const ctx = ttyCtx({ transactionId: 'tx-1' }, { interval: 0, maxAttempts: 0, timeout: 900 });
    await drain(runStatusCommand(ctx as never, inflow, storage));
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it('runCancelCommand renders the cancel view and returns the best-effort frame', async () => {
    const { inflow, storage } = authed(makeClient());
    const ctx = ttyCtx({ approvalId: 'ap-1' }, {});
    const out = await runCancelCommand(ctx as never, inflow, storage);
    expect(out).toMatchObject({ approval_id: 'ap-1', cancelled: true });
  });

  it('runSupportedCommand renders the supported view and returns undefined', async () => {
    const client = makeClient({
      getSupported: vi.fn(async () => ({
        kinds: [
          { method: 'inflow', intents: [{ intent: 'charge', rails: [{ rail: 'balance', currencies: ['USDC'] }] }] },
        ],
      })) as MppClient['getSupported'],
    });
    const { inflow, storage } = authed(client);
    const ctx = ttyCtx({}, {});
    const out = await runSupportedCommand(ctx as never, inflow, storage);
    expect(out).toBeUndefined();
  });

  it('runInspectCommand renders the inspect view and returns undefined on a 2xx probe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('FREE', { status: 200 }));
    const ctx = ttyCtx({ url: SELLER }, { method: 'GET', header: [] });
    const out = await runInspectCommand(ctx as never);
    expect(out).toBeUndefined();
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it('runInspectCommand calls c.error when the inspect view ends in an error phase', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const ctx = ttyCtx({ url: SELLER }, { method: 'GET', header: [] });
    await expect(runInspectCommand(ctx as never)).rejects.toThrow('c.error: UNEXPECTED_PROBE_STATUS');
  });
});
