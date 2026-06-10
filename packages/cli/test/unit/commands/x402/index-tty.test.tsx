import type { AuthStorage } from '@inflowpayai/inflow-core';
import { Inflow, MemoryStorage } from '@inflowpayai/inflow-core';
import type {
  EncodedPayment,
  InflowClient as X402InflowClient,
  PreparedPayment,
  X402PayloadResponse,
} from '@inflowpayai/x402-buyer';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { __testing, createX402Cli } from '../../../../src/commands/x402/index.js';

const { runPayCommand, runStatusCommand, runCancelCommand, runSupportedCommand, runInspectCommand } = __testing;

function makePaymentRequired(): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: 'https://seller/api', mimeType: 'application/json' },
    accepts: [
      {
        scheme: 'balance',
        network: 'inflow:1',
        amount: '500',
        payTo: 'inflow:abc',
        maxTimeoutSeconds: 60,
        asset: 'USDC',
        extra: {},
      },
    ],
  };
}

const encodedPayment: EncodedPayment = {
  encodedPayload: 'enc',
  paymentPayload: {
    x402Version: 2,
    accepted: {
      scheme: 'balance',
      network: 'inflow:1',
      amount: '500',
      payTo: 'inflow:abc',
      maxTimeoutSeconds: 60,
      asset: 'USDC',
      extra: {},
    },
    payload: {},
  },
  transactionId: 'txn_1',
};

function makePrepared(): PreparedPayment {
  return {
    transactionId: 'txn_1',
    approvalId: 'appr_1',
    awaitPayload: () => Promise.resolve(encodedPayment),
    status: () => Promise.resolve('INITIATED'),
    cancel: () => Promise.resolve(),
  };
}

function makeClient(overrides: Partial<X402InflowClient> = {}): X402InflowClient {
  const base = {
    selectInflowRequirement: vi.fn(() =>
      Promise.resolve({
        scheme: 'balance',
        network: 'inflow:1',
        amount: '500',
        payTo: 'inflow:abc',
        maxTimeoutSeconds: 60,
        asset: 'USDC',
        extra: {},
      }),
    ),
    prepareInflowPayment: vi.fn(() => Promise.resolve(makePrepared())),
    getSupported: vi.fn(() =>
      Promise.resolve({
        kinds: [{ scheme: 'balance', network: 'inflow:1', x402Version: 2 }],
      }),
    ),
    getX402Payload: vi.fn(() => Promise.resolve<X402PayloadResponse>({ status: 'INITIATED' })),
    cancelApproval: vi.fn(() => Promise.resolve(undefined)),
  };
  return { ...base, ...overrides } as unknown as X402InflowClient;
}

function authedResources(client: X402InflowClient): { inflow: Inflow; storage: AuthStorage } {
  const storage = new MemoryStorage({
    access_token: 'a',
    refresh_token: 'r',
    token_type: 'Bearer',
    expires_in: 3600,
    expires_at: Date.now() + 3600 * 1000,
  });
  const inflow = new Inflow({ authStorage: storage, environment: 'sandbox', cliClientId: 'test' });
  (inflow.x402 as unknown as { cached: Promise<X402InflowClient> }).cached = Promise.resolve(client);
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

function agentCtx<A, O>(args: A, options: O) {
  return {
    agent: true,
    formatExplicit: true,
    args,
    options,
    error: vi.fn((err: { code: string; message: string }): never => {
      throw new Error(`c.error: ${err.code}: ${err.message}`);
    }),
  };
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

const PAY_OPTIONS = { method: 'GET', header: [], interval: 5, maxAttempts: 0, timeout: 900, showBody: true };

// PayView activates `useInput` during the awaiting-approval phase; Ink throws unless stdin claims raw-mode support.
// Mirror a real TTY by stubbing `isTTY` / `setRawMode` on the shared stdin for the duration of this file.
const stdinAsTty = process.stdin as unknown as {
  isTTY?: boolean | undefined;
  setRawMode?: ((mode: boolean) => unknown) | undefined;
};
let originalIsTTY: boolean | undefined;
let originalSetRawMode: ((mode: boolean) => unknown) | undefined;

beforeAll(() => {
  originalIsTTY = stdinAsTty.isTTY;
  originalSetRawMode = stdinAsTty.setRawMode;
  stdinAsTty.isTTY = true;
  stdinAsTty.setRawMode = () => process.stdin;
});

afterAll(() => {
  stdinAsTty.isTTY = originalIsTTY;
  stdinAsTty.setRawMode = originalSetRawMode;
});

afterEach(() => vi.restoreAllMocks());

describe('x402 TTY runners (renderInkUntilExit paths)', () => {
  it('runPayCommand renders to completion on a successful pay and never calls c.error', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response('payment required', { status: 402, headers: { 'PAYMENT-REQUIRED': header } }),
    );
    fetchSpy.mockResolvedValueOnce(new Response('ok-body', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const { inflow, storage } = authedResources(makeClient());
    const ctx = ttyCtx({ url: 'https://seller/api' }, PAY_OPTIONS);
    const yields = await drain(runPayCommand(ctx as never, inflow, storage, 'https://api.inflowpay.ai'));
    expect(yields).toHaveLength(0);
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it('runPayCommand calls c.error with PAYMENT_NOT_ACCEPTED when the seller rejects the replay', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response('payment required', { status: 402, headers: { 'PAYMENT-REQUIRED': header } }),
    );
    fetchSpy.mockResolvedValueOnce(new Response('still payment required', { status: 402 }));
    const { inflow, storage } = authedResources(makeClient());
    const ctx = ttyCtx({ url: 'https://seller/api' }, PAY_OPTIONS);
    await expect(drain(runPayCommand(ctx as never, inflow, storage, 'https://api.inflowpay.ai'))).rejects.toThrow(
      'c.error: PAYMENT_NOT_ACCEPTED',
    );
    expect(ctx.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Seller rejected the signed payment with status 402') as string,
      }),
    );
  });

  it('runPayCommand forwards a pipeline error phase to c.error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const { inflow, storage } = authedResources(makeClient());
    const ctx = ttyCtx({ url: 'https://seller/api' }, PAY_OPTIONS);
    await expect(drain(runPayCommand(ctx as never, inflow, storage, 'https://api.inflowpay.ai'))).rejects.toThrow(
      'c.error: UNEXPECTED_PROBE_STATUS',
    );
  });

  it('runStatusCommand renders the status view to completion on a signed payload', async () => {
    const getX402Payload = vi.fn(() =>
      Promise.resolve<X402PayloadResponse>({
        status: 'APPROVED',
        encodedPayload: 'enc',
        paymentPayload: encodedPayment.paymentPayload,
      }),
    );
    const client = makeClient({ getX402Payload });
    const { inflow, storage } = authedResources(client);
    const ctx = ttyCtx({ transactionId: 'txn_1' }, { interval: 0.01, maxAttempts: 0, timeout: 60 });
    const yields = await drain(runStatusCommand(ctx as never, inflow, storage));
    expect(yields).toHaveLength(0);
    expect(getX402Payload).toHaveBeenCalledWith('txn_1');
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it('runCancelCommand renders the cancel view and returns the best-effort envelope', async () => {
    const cancelApproval = vi.fn(() => Promise.resolve(undefined));
    const { inflow, storage } = authedResources(makeClient({ cancelApproval }));
    const ctx = ttyCtx({ approvalId: 'appr_1' }, {});
    const result = await runCancelCommand(ctx, inflow, storage);
    expect(result).toEqual({
      approval_id: 'appr_1',
      cancelled: true,
      note: 'best-effort; server-side state not verified',
    });
    expect(cancelApproval).toHaveBeenCalledWith('appr_1');
  });

  it('runSupportedCommand renders the supported view and returns undefined', async () => {
    const getSupported = vi.fn(() =>
      Promise.resolve({
        kinds: [{ scheme: 'balance', network: 'inflow:1', x402Version: 2 }],
      }),
    );
    const { inflow, storage } = authedResources(makeClient({ getSupported }));
    const ctx = ttyCtx({}, {});
    const result = await runSupportedCommand(ctx, inflow, storage);
    expect(result).toBeUndefined();
    expect(getSupported).toHaveBeenCalled();
  });

  it('runInspectCommand renders the inspect view to completion on a 402 probe', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', { status: 402, headers: { 'PAYMENT-REQUIRED': header } }),
    );
    const ctx = ttyCtx({ url: 'https://seller/api' }, { method: 'GET', header: [] });
    const result = await runInspectCommand(ctx);
    expect(result).toBeUndefined();
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it('runInspectCommand forwards an inspect error phase to c.error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const ctx = ttyCtx({ url: 'https://seller/api' }, { method: 'GET', header: [] });
    await expect(runInspectCommand(ctx as never)).rejects.toThrow('c.error: UNEXPECTED_PROBE_STATUS');
  });
});

describe('runStatusCommand (agent-mode polling details)', () => {
  it('dedupes consecutive identical pending frames via isEqual before the signed terminal', async () => {
    const responses: X402PayloadResponse[] = [
      { status: 'INITIATED' },
      { status: 'INITIATED' },
      {
        status: 'APPROVED',
        encodedPayload: 'enc',
        paymentPayload: encodedPayment.paymentPayload,
      },
    ];
    const client = makeClient({
      getX402Payload: vi.fn(() => Promise.resolve<X402PayloadResponse>(responses.shift() ?? { status: 'INITIATED' })),
    });
    const { inflow, storage } = authedResources(client);
    const ctx = agentCtx({ transactionId: 'txn_1' }, { interval: 0.01, maxAttempts: 0, timeout: 60 });
    const yields = await drain(runStatusCommand(ctx as never, inflow, storage));
    // The duplicate INITIATED frame is suppressed; only the first pending frame and the terminal frame surface.
    expect(yields).toHaveLength(2);
    expect(yields[0]).toMatchObject({ transaction_id: 'txn_1', status: 'INITIATED' });
    expect(yields[1]).toMatchObject({ transaction_id: 'txn_1', status: 'APPROVED' });
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it('emits the timeout-flavoured POLLING_TIMEOUT message when the deadline elapses', async () => {
    const client = makeClient({
      getX402Payload: vi.fn(() => Promise.resolve<X402PayloadResponse>({ status: 'INITIATED' })),
    });
    const { inflow, storage } = authedResources(client);
    const ctx = agentCtx({ transactionId: 'txn_1' }, { interval: 0.01, maxAttempts: 0, timeout: 0.02 });
    await expect(drain(runStatusCommand(ctx as never, inflow, storage))).rejects.toThrow(
      'Polling timed out before the transaction reached a signed state.',
    );
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'POLLING_TIMEOUT', retryable: true }));
  });
});

describe('createX402Cli', () => {
  it('registers the full x402 command group under the x402 namespace', () => {
    const { inflow, storage } = authedResources(makeClient());
    const cli = createX402Cli(inflow, storage, 'https://app.inflowpay.ai');
    expect(cli).toBeDefined();
    expect(cli.name).toBe('x402');
    expect(cli.description).toContain('x402 payment commands');
  });
});
