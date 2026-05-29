import type { AuthStorage } from '@inflowpayai/inflow-core';
import { Inflow, MemoryStorage } from '@inflowpayai/inflow-core';
import {
  X402AdapterRoutingError,
  X402ApprovalFailedError,
  X402PaymentIdFormatError,
  type EncodedPayment,
  type InflowClient as X402InflowClient,
  type PreparedPayment,
} from '@inflowpayai/x402-buyer';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testing } from '../../../../src/commands/x402/index.js';

const { runPayCommand, runStatusCommand, runCancelCommand, runDecodeCommand, runSupportedCommand, runInspectCommand } =
  __testing;

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

function makePrepared(
  result: EncodedPayment | Error = {
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
  },
): PreparedPayment {
  return {
    transactionId: 'txn_1',
    approvalId: 'appr_1',
    awaitPayload: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
    status: () => Promise.resolve('INITIATED'),
    cancel: () => Promise.resolve(),
  };
}

function makeClient(overrides: Partial<X402InflowClient> = {}): X402InflowClient {
  const base = {
    selectInflowRequirement: vi.fn(() => ({
      scheme: 'balance',
      network: 'inflow:1',
      amount: '500',
      payTo: 'inflow:abc',
      maxTimeoutSeconds: 60,
      asset: 'USDC',
      extra: {},
    })),
    prepareInflowPayment: vi.fn(async () => makePrepared()),
    getSupported: vi.fn(async () => ({
      kinds: [{ scheme: 'balance', network: 'inflow:1', x402Version: 2 }],
    })),
    getX402Payload: vi.fn(async () => ({ status: 'INITIATED' as const })),
    cancelApproval: vi.fn(async () => undefined),
  };
  return { ...base, ...overrides } as unknown as X402InflowClient;
}

function authedResources(client: X402InflowClient): {
  inflow: Inflow;
  storage: AuthStorage;
} {
  const storage = new MemoryStorage({
    access_token: 'a',
    refresh_token: 'r',
    token_type: 'Bearer',
    expires_in: 3600,
    expires_at: Date.now() + 3600 * 1000,
  });
  const inflow = new Inflow({
    authStorage: storage,
    environment: 'sandbox',
    cliClientId: 'test',
  });
  (inflow.x402 as unknown as { cached: Promise<X402InflowClient> }).cached = Promise.resolve(client);
  return { inflow, storage };
}

interface ErrorOptions {
  code: string;
  message: string;
  retryable?: boolean;
}

type ErrorEmitter = (err: ErrorOptions) => never;

function agentContext<A, O>(
  args: A,
  options: O,
): {
  agent: boolean;
  formatExplicit: boolean;
  args: A;
  options: O;
  error: ErrorEmitter;
} {
  return {
    agent: true,
    formatExplicit: true,
    args,
    options,
    error: vi.fn<ErrorEmitter>((_err) => {
      throw new Error('c.error called');
    }),
  };
}

function agentContextNoOptions<A>(args: A): {
  agent: boolean;
  formatExplicit: boolean;
  args: A;
  error: ErrorEmitter;
} {
  return {
    agent: true,
    formatExplicit: true,
    args,
    error: vi.fn<ErrorEmitter>((_err) => {
      throw new Error('c.error called');
    }),
  };
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runPayCommand (agent mode)', () => {
  it('yields the no-payment frame when the seller returns 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: [],
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: true,
      },
    );
    const { inflow, storage } = authedResources(makeClient());
    const yields = await drain(runPayCommand(ctx, inflow, storage, 'https://api.inflowpay.ai'));
    expect(yields).toHaveLength(1);
    const f = yields[0] as { outcome: string; status: number; body?: string };
    expect(f.outcome).toBe('no-payment-required');
    expect(f.status).toBe(200);
    expect(f.body).toBe('hello');
  });

  it('emits a NOT_AUTHENTICATED error when storage is empty and no api key is set', async () => {
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: [],
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      },
    );
    const storage = new MemoryStorage();
    const inflow = new Inflow({
      authStorage: storage,
      environment: 'sandbox',
      cliClientId: 'test',
    });
    await expect(drain(runPayCommand(ctx, inflow, storage, 'https://api.inflowpay.ai'))).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_AUTHENTICATED' }));
  });

  it('yields an initial pay payload when interval=0 (deferred polling mode)', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: [],
        interval: 0,
        maxAttempts: 60,
        timeout: 900,
        showBody: false,
      },
    );
    const { inflow, storage } = authedResources(makeClient());
    const yields = await drain(runPayCommand(ctx, inflow, storage, 'https://api.inflowpay.ai'));
    expect(yields).toHaveLength(1);
    const payload = yields[0] as { transaction_id: string; approval_id: string; _next?: { command: string } };
    expect(payload.transaction_id).toBe('txn_1');
    expect(payload.approval_id).toBe('appr_1');
    expect(payload._next?.command).toContain('x402 status txn_1');
  });

  it('completes the full pay flow (probe → prepare → await → replay) when interval > 0', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response('ok-body', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: [],
        interval: 1,
        maxAttempts: 0,
        timeout: 900,
        showBody: true,
      },
    );
    const { inflow, storage } = authedResources(makeClient());
    const yields = await drain(runPayCommand(ctx, inflow, storage, 'https://api.inflowpay.ai'));
    expect(yields).toHaveLength(2);
    const final = yields[1] as { outcome: string; body?: string; response_status: number };
    expect(final.outcome).toBe('paid');
    expect(final.body).toBe('ok-body');
    expect(final.response_status).toBe(200);
  });

  it('routes X402PaymentIdFormatError to INVALID_PAYMENT_ID via c.error', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const client = makeClient({
      prepareInflowPayment: vi.fn(async () => {
        throw new X402PaymentIdFormatError('bad-id');
      }),
    });
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: [],
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      },
    );
    const { inflow, storage } = authedResources(client);
    await expect(drain(runPayCommand(ctx, inflow, storage, 'https://api.inflowpay.ai'))).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_PAYMENT_ID' }));
  });

  it('routes a --scheme that excludes every accept entry to NO_FILTERED_MATCH', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const selectSpy = vi.fn(() => ({
      scheme: 'balance' as const,
      network: 'inflow:1',
      amount: '500',
      payTo: 'inflow:abc',
      maxTimeoutSeconds: 60,
      asset: 'USDC',
      extra: {},
    }));
    const client = makeClient({ selectInflowRequirement: selectSpy });
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: [],
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
        scheme: 'paymaster',
      },
    );
    const { inflow, storage } = authedResources(client);
    await expect(drain(runPayCommand(ctx, inflow, storage, 'https://api.inflowpay.ai'))).rejects.toThrow();
    expect(selectSpy).not.toHaveBeenCalled();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'NO_FILTERED_MATCH' }));
  });

  it('passes a filter-narrowed accepts list to selectInflowRequirement', async () => {
    const decoded: PaymentRequired = {
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
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: '500',
          payTo: '0xabc',
          maxTimeoutSeconds: 60,
          asset: 'USDC',
          extra: {},
        },
      ],
    };
    const header = encodePaymentRequiredHeader(decoded);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const selectSpy = vi.fn((_decoded: PaymentRequired) => ({
      scheme: 'exact' as const,
      network: 'eip155:84532',
      amount: '500',
      payTo: '0xabc',
      maxTimeoutSeconds: 60,
      asset: 'USDC',
      extra: {},
    }));
    const client = makeClient({ selectInflowRequirement: selectSpy });
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: [],
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
        scheme: 'exact',
        network: 'eip155:84532',
      },
    );
    const { inflow, storage } = authedResources(client);
    const yields = await drain(runPayCommand(ctx, inflow, storage, 'https://api.inflowpay.ai'));
    expect(selectSpy).toHaveBeenCalledTimes(1);
    const arg = selectSpy.mock.calls[0]?.[0];
    expect(arg?.accepts).toHaveLength(1);
    expect(arg?.accepts[0]?.scheme).toBe('exact');
    expect(arg?.accepts[0]?.network).toBe('eip155:84532');
    const initial = yields[0] as { scheme?: string; network?: string };
    expect(initial.scheme).toBe('exact');
    expect(initial.network).toBe('eip155:84532');
  });

  it('routes a null selectInflowRequirement to NO_INFLOW_MATCH', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const client = makeClient({
      selectInflowRequirement: vi.fn(() => null),
    });
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: [],
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      },
    );
    const { inflow, storage } = authedResources(client);
    await expect(drain(runPayCommand(ctx, inflow, storage, 'https://api.inflowpay.ai'))).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'NO_INFLOW_MATCH' }));
  });

  it('routes X402AdapterRoutingError from prepareInflowPayment to NO_INFLOW_MATCH', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const client = makeClient({
      prepareInflowPayment: vi.fn(async () => {
        throw new X402AdapterRoutingError('balance', 'inflow:1');
      }),
    });
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: [],
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      },
    );
    const { inflow, storage } = authedResources(client);
    await expect(drain(runPayCommand(ctx, inflow, storage, 'https://api.inflowpay.ai'))).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'NO_INFLOW_MATCH' }));
  });

  it('routes awaitPayload rejection to APPROVAL_FAILED', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const client = makeClient({
      prepareInflowPayment: vi.fn(async () => makePrepared(new X402ApprovalFailedError('appr_1', 'DECLINED'))),
    });
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: [],
        interval: 1,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      },
    );
    const { inflow, storage } = authedResources(client);
    const collected: unknown[] = [];
    await expect(
      (async () => {
        for await (const v of runPayCommand(ctx, inflow, storage, 'https://api.inflowpay.ai')) {
          collected.push(v);
        }
      })(),
    ).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'APPROVAL_FAILED' }));
    expect(collected.length).toBeGreaterThanOrEqual(1);
  });

  it('emits INVALID_HEADER when --header is malformed', async () => {
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: ['bad-header'],
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      },
    );
    const { inflow, storage } = authedResources(makeClient());
    await expect(drain(runPayCommand(ctx, inflow, storage, 'https://api.inflowpay.ai'))).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_HEADER' }));
  });

  it('emits INVALID_402 when the seller returns 402 without a PAYMENT-REQUIRED header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('payment required', { status: 402 }));
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: [],
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      },
    );
    const { inflow, storage } = authedResources(makeClient());
    await expect(drain(runPayCommand(ctx, inflow, storage, 'https://api.inflowpay.ai'))).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_402' }));
  });

  it('emits DECODE_FAILED when the PAYMENT-REQUIRED header is not decodable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': 'not-base64-!!!' },
      }),
    );
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: [],
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      },
    );
    const { inflow, storage } = authedResources(makeClient());
    await expect(drain(runPayCommand(ctx, inflow, storage, 'https://api.inflowpay.ai'))).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'DECODE_FAILED' }));
  });

  it('forwards --data and Content-Type to the seller probe', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'POST',
        data: '{"x":1}',
        header: ['X-Test: yes'],
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      },
    );
    const { inflow, storage } = authedResources(makeClient());
    await drain(runPayCommand(ctx, inflow, storage, 'https://api.inflowpay.ai'));
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect((init as RequestInit | undefined)?.body).toBe('{"x":1}');
  });

  it('yields replay-rejected frame and emits PAYMENT_NOT_ACCEPTED when the seller returns 402 on replay', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    fetchSpy.mockResolvedValueOnce(new Response('still payment required', { status: 402 }));
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: [],
        interval: 1,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      },
    );
    const { inflow, storage } = authedResources(makeClient());
    const collected: unknown[] = [];
    await expect(
      (async () => {
        for await (const v of runPayCommand(ctx, inflow, storage, 'https://api.inflowpay.ai')) {
          collected.push(v);
        }
      })(),
    ).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'PAYMENT_NOT_ACCEPTED' }));
    expect(collected).toHaveLength(2);
    const final = collected[1] as {
      outcome: string;
      transaction_id: string;
      approval_id: string;
      approval_url: string;
      response_status: number;
    };
    expect(final.outcome).toBe('replay-rejected');
    expect(final.response_status).toBe(402);
    expect(final.transaction_id).toBe('txn_1');
    expect(final.approval_id).toBe('appr_1');
    expect(final.approval_url).toBe('https://sandbox.inflowpay.ai/approvals/appr_1/view/');
  });

  it('emits UNEXPECTED_PROBE_STATUS when the probe returns 404 (not 2xx, not 402)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: [],
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      },
    );
    const { inflow, storage } = authedResources(makeClient());
    await expect(drain(runPayCommand(ctx, inflow, storage, 'https://api.inflowpay.ai'))).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNEXPECTED_PROBE_STATUS' }));
  });
});

describe('runStatusCommand (agent mode)', () => {
  it('yields a single status frame when interval=0 (snapshot mode)', async () => {
    const client = makeClient({
      getX402Payload: vi.fn(async () => ({ status: 'INITIATED' })),
    });
    const ctx = agentContext(
      { transactionId: 'txn_1' },
      {
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
      },
    );
    const { inflow, storage } = authedResources(client);
    const yields = await drain(runStatusCommand(ctx, inflow, storage));
    expect(yields).toHaveLength(1);
    expect(yields[0]).toMatchObject({ transaction_id: 'txn_1', status: 'INITIATED' });
  });

  it('emits POLLING_TIMEOUT when polling exhausts max_attempts', async () => {
    const client = makeClient({
      getX402Payload: vi.fn(async () => ({ status: 'INITIATED' })),
    });
    const ctx = agentContext(
      { transactionId: 'txn_x' },
      {
        interval: 0.01,
        maxAttempts: 1,
        timeout: 60,
      },
    );
    const { inflow, storage } = authedResources(client);
    await expect(drain(runStatusCommand(ctx, inflow, storage))).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'POLLING_TIMEOUT' }));
  });

  it('emits APPROVAL_FAILED when the final status is a terminal failure with no payload', async () => {
    const client = makeClient({
      getX402Payload: vi.fn(async () => ({ status: 'DECLINED' })),
    });
    const ctx = agentContext(
      { transactionId: 'txn_x' },
      {
        interval: 0.01,
        maxAttempts: 5,
        timeout: 60,
      },
    );
    const { inflow, storage } = authedResources(client);
    await expect(drain(runStatusCommand(ctx, inflow, storage))).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'APPROVAL_FAILED' }));
  });

  it('completes successfully when the transaction reaches a signed state', async () => {
    const responses = [
      { status: 'INITIATED' },
      {
        status: 'APPROVED',
        encodedPayload: 'enc',
        paymentPayload: {
          x402Version: 2,
          accepted: {
            scheme: 'balance',
            network: 'inflow:1',
            amount: '0',
            payTo: '',
            maxTimeoutSeconds: 0,
            asset: '',
            extra: {},
          },
          payload: {},
        },
      },
    ];
    const client = makeClient({
      getX402Payload: vi.fn(async () => responses.shift() ?? { status: 'INITIATED' }),
    });
    const ctx = agentContext(
      { transactionId: 'txn_x' },
      {
        interval: 0.01,
        maxAttempts: 0,
        timeout: 60,
      },
    );
    const { inflow, storage } = authedResources(client);
    const yields = await drain(runStatusCommand(ctx, inflow, storage));
    expect(yields.length).toBeGreaterThanOrEqual(1);
    expect(ctx.error).not.toHaveBeenCalled();
  });
});

describe('runCancelCommand', () => {
  it('returns the best-effort cancel envelope in agent mode', async () => {
    const cancelApproval = vi.fn(async () => undefined);
    const client = makeClient({ cancelApproval });
    const ctx = agentContextNoOptions({ approvalId: 'appr_1' });
    const { inflow, storage } = authedResources(client);
    const result = await runCancelCommand(ctx, inflow, storage);
    expect(result).toEqual({
      approval_id: 'appr_1',
      cancelled: true,
      note: expect.any(String),
    });
    expect(cancelApproval).toHaveBeenCalledWith('appr_1');
  });

  it('short-circuits via c.error when not authenticated', async () => {
    const storage = new MemoryStorage();
    const inflow = new Inflow({
      authStorage: storage,
      environment: 'sandbox',
      cliClientId: 'test',
    });
    const ctx = agentContextNoOptions({ approvalId: 'appr_1' });
    await expect(runCancelCommand(ctx, inflow, storage)).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_AUTHENTICATED' }));
  });
});

describe('runDecodeCommand', () => {
  it('returns the decoded header in agent mode', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    const ctx = agentContextNoOptions({ header });
    const decoded = await runDecodeCommand(ctx);
    expect(decoded?.x402Version).toBe(2);
    expect(decoded?.resource.url).toBe('https://seller/api');
  });

  it('emits DECODE_FAILED when the header is malformed', async () => {
    const ctx = agentContextNoOptions({ header: 'not-base64-!!!' });
    await expect(runDecodeCommand(ctx)).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'DECODE_FAILED' }));
  });
});

describe('runSupportedCommand', () => {
  it('returns the buyer-side supported envelope in agent mode', async () => {
    const ctx = agentContextNoOptions({});
    const { inflow, storage } = authedResources(makeClient());
    const result = await runSupportedCommand(ctx, inflow, storage);
    expect(result?.kinds?.[0]?.scheme).toBe('balance');
  });

  it('short-circuits via c.error when not authenticated', async () => {
    const storage = new MemoryStorage();
    const inflow = new Inflow({
      authStorage: storage,
      environment: 'sandbox',
      cliClientId: 'test',
    });
    const ctx = agentContextNoOptions({});
    await expect(runSupportedCommand(ctx, inflow, storage)).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_AUTHENTICATED' }));
  });
});

describe('runInspectCommand (agent mode)', () => {
  it('yields an accepts frame on a 402 probe', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: [],
      },
    );
    const result = await runInspectCommand(ctx);
    expect(result?.outcome).toBe('accepts');
    expect(result?.resource).toBe('https://seller/api');
    const accepts = result?.accepts as Array<Record<string, unknown>>;
    expect(accepts).toHaveLength(1);
    expect(accepts[0]?.scheme).toBe('balance');
    expect(accepts[0]?.network).toBe('inflow:1');
    expect(accepts[0]?.pay_to).toBe('inflow:abc');
    expect(accepts[0]?.max_timeout_seconds).toBe(60);
  });

  it('yields a no-payment-required frame on a 2xx probe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('hello', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const ctx = agentContext({ url: 'https://seller/api' }, { method: 'GET', header: [] });
    const result = await runInspectCommand(ctx);
    expect(result?.outcome).toBe('no-payment-required');
    expect(result?.status).toBe(200);
    expect(result?.content_type).toBe('text/plain');
    expect(result?.body_size_bytes).toBe(5);
    expect('body' in (result ?? {})).toBe(false);
  });

  it('narrows the accepts frame via --scheme / --network', async () => {
    const decoded: PaymentRequired = {
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
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: '500',
          payTo: '0xabc',
          maxTimeoutSeconds: 60,
          asset: 'USDC',
          extra: { name: 'USD Coin' },
        },
      ],
    };
    const header = encodePaymentRequiredHeader(decoded);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const ctx = agentContext(
      { url: 'https://seller/api' },
      {
        method: 'GET',
        header: [],
        scheme: 'exact',
        network: 'eip155:84532',
      },
    );
    const result = await runInspectCommand(ctx);
    const rows = result?.accepts as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scheme).toBe('exact');
    expect(rows[0]?.extra).toEqual({ name: 'USD Coin' });
  });

  it('routes a NO_FILTERED_MATCH filter to c.error', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const ctx = agentContext({ url: 'https://seller/api' }, { method: 'GET', header: [], scheme: 'paymaster' });
    await expect(runInspectCommand(ctx)).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'NO_FILTERED_MATCH' }));
  });

  it('routes a non-2xx / non-402 probe to UNEXPECTED_PROBE_STATUS', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 503 }));
    const ctx = agentContext({ url: 'https://seller/api' }, { method: 'GET', header: [] });
    await expect(runInspectCommand(ctx)).rejects.toThrow();
    expect(ctx.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNEXPECTED_PROBE_STATUS' }));
  });

  it('does not require an authenticated session (read-only command)', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const ctx = agentContext({ url: 'https://seller/api' }, { method: 'GET', header: [] });
    const result = await runInspectCommand(ctx);
    expect(result?.outcome).toBe('accepts');
    expect(ctx.error).not.toHaveBeenCalled();
  });
});
