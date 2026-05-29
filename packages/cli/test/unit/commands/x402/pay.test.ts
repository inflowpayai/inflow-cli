import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  X402AdapterRoutingError,
  X402ApprovalCancelledError,
  X402ApprovalFailedError,
  X402ApprovalTimeoutError,
  X402PaymentIdFormatError,
  type EncodedPayment,
  type InflowClient as X402InflowClient,
  type PreparedPayment,
} from '@inflowpayai/x402-buyer';
import type { PaymentRequirements } from '@inflowpayai/x402';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildNoFilteredMatchMessage,
  filterAccepts,
  INVALID_402_CODE,
  mapSdkError,
  NO_FILTERED_MATCH_CODE,
  NO_INFLOW_MATCH_CODE,
  PAYMENT_NOT_ACCEPTED_CODE,
  runPayPipeline,
  UNEXPECTED_PROBE_STATUS_CODE,
} from '../../../../src/commands/x402/pay.js';

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

function makeMultiAcceptPaymentRequired(): PaymentRequired {
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
      {
        scheme: 'exact',
        network: 'eip155:84532',
        amount: '500',
        payTo: '0xabc',
        maxTimeoutSeconds: 60,
        asset: 'USDC',
        extra: {},
      },
      {
        scheme: 'exact',
        network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        amount: '500',
        payTo: 'sol-payto',
        maxTimeoutSeconds: 60,
        asset: 'USDC',
        extra: {},
      },
    ],
  };
}

function makeRequirement(): PaymentRequirements {
  return {
    scheme: 'balance',
    network: 'inflow:1',
    amount: '500',
    payTo: 'inflow:abc',
    maxTimeoutSeconds: 60,
    asset: 'USDC',
    extra: {},
  };
}

function makePrepared(
  encoded: EncodedPayment | Error = {
    encodedPayload: 'encoded-payload-value',
    paymentPayload: {
      x402Version: 2,
      accepted: makeRequirement(),
      payload: {},
    },
    transactionId: 'txn_1',
  },
): PreparedPayment {
  return {
    transactionId: 'txn_1',
    approvalId: 'appr_1',
    awaitPayload: () => (encoded instanceof Error ? Promise.reject(encoded) : Promise.resolve(encoded)),
    status: () => Promise.resolve('INITIATED'),
    cancel: () => Promise.resolve(),
  };
}

function makeClient(overrides: Partial<X402InflowClient> = {}): X402InflowClient {
  const base = {
    selectInflowRequirement: vi.fn(() => makeRequirement()),
    prepareInflowPayment: vi.fn(async () => makePrepared()),
    getSupported: vi.fn(async () => ({ kinds: [{ scheme: 'balance', network: 'inflow:1', x402Version: 2 }] })),
    getX402Payload: vi.fn(async () => ({ status: 'INITIATED' })),
    cancelApproval: vi.fn(async () => undefined),
  };
  return { ...base, ...overrides } as unknown as X402InflowClient;
}

function captureEvents(): {
  emit: (event: unknown) => void;
  events: unknown[];
} {
  const events: unknown[] = [];
  return {
    emit: (event: unknown) => events.push(event),
    events,
  };
}

describe('mapSdkError', () => {
  it('maps X402ApprovalCancelledError to APPROVAL_CANCELLED', () => {
    const mapped = mapSdkError(new X402ApprovalCancelledError('appr_1'));
    expect(mapped.code).toBe('APPROVAL_CANCELLED');
  });

  it('maps X402ApprovalFailedError to APPROVAL_FAILED', () => {
    const mapped = mapSdkError(new X402ApprovalFailedError('appr_1', 'DECLINED'));
    expect(mapped.code).toBe('APPROVAL_FAILED');
  });

  it('maps X402ApprovalTimeoutError to APPROVAL_TIMEOUT', () => {
    const mapped = mapSdkError(new X402ApprovalTimeoutError('appr_1', 5000));
    expect(mapped.code).toBe('APPROVAL_TIMEOUT');
  });

  it('maps X402PaymentIdFormatError to INVALID_PAYMENT_ID', () => {
    const mapped = mapSdkError(new X402PaymentIdFormatError('bad'));
    expect(mapped.code).toBe('INVALID_PAYMENT_ID');
  });

  it('maps X402AdapterRoutingError to NO_INFLOW_MATCH', () => {
    const mapped = mapSdkError(new X402AdapterRoutingError('balance', 'inflow:1'));
    expect(mapped.code).toBe(NO_INFLOW_MATCH_CODE);
  });

  it('falls through to PAY_FAILED for unknown errors', () => {
    const mapped = mapSdkError(new Error('boom'));
    expect(mapped.code).toBe('PAY_FAILED');
    expect(mapped.message).toBe('boom');
  });
});

describe('runPayPipeline', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('short-circuits on a 200 response (no payment required)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const { emit, events } = captureEvents();
    await runPayPipeline(
      {
        client: makeClient(),
        apiBaseUrl: 'https://api.inflowpay.ai',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: { timeoutMs: 900_000 },
        showBody: false,
      },
      emit,
    );
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1] as { type: string };
    expect(last.type).toBe('short-circuited');
  });

  it('emits INVALID_402 when 402 is missing the PAYMENT-REQUIRED header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('payment required', { status: 402 }));
    const { emit, events } = captureEvents();
    await runPayPipeline(
      {
        client: makeClient(),
        apiBaseUrl: 'https://api.inflowpay.ai',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: { timeoutMs: 900_000 },
        showBody: false,
      },
      emit,
    );
    const errored = events.find(
      (e): e is { type: 'errored'; code: string; message: string } => (e as { type?: string }).type === 'errored',
    );
    expect(errored?.code).toBe(INVALID_402_CODE);
  });

  it('emits NO_INFLOW_MATCH when the SDK returns null for selectInflowRequirement', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const client = makeClient({
      selectInflowRequirement: vi.fn(() => null),
    } as Partial<X402InflowClient>);
    const { emit, events } = captureEvents();
    await runPayPipeline(
      {
        client,
        apiBaseUrl: 'https://api.inflowpay.ai',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: { timeoutMs: 900_000 },
        showBody: false,
      },
      emit,
    );
    const errored = events.find(
      (e): e is { type: 'errored'; code: string; message: string } => (e as { type?: string }).type === 'errored',
    );
    expect(errored?.code).toBe(NO_INFLOW_MATCH_CODE);
  });

  it('completes a happy-path pay: probe → prepare → awaitPayload → replay', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response('paid-body', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { emit, events } = captureEvents();
    await runPayPipeline(
      {
        client: makeClient(),
        apiBaseUrl: 'https://api.inflowpay.ai',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: { timeoutMs: 900_000 },
        showBody: true,
      },
      emit,
    );
    const replayed = events.find(
      (e): e is { type: 'replayed'; result: { outcome: string; body?: string } } =>
        (e as { type?: string }).type === 'replayed',
    );
    expect(replayed?.result.outcome).toBe('paid');
    expect(replayed?.result.body).toBe('paid-body');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('emits APPROVAL_FAILED when awaitPayload rejects with X402ApprovalFailedError', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const client = makeClient({
      prepareInflowPayment: vi.fn(async () => makePrepared(new X402ApprovalFailedError('appr_1', 'DECLINED'))),
    } as Partial<X402InflowClient>);
    const { emit, events } = captureEvents();
    await runPayPipeline(
      {
        client,
        apiBaseUrl: 'https://api.inflowpay.ai',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: { timeoutMs: 900_000 },
        showBody: false,
      },
      emit,
    );
    const errored = events.find(
      (e): e is { type: 'errored'; code: string; message: string } => (e as { type?: string }).type === 'errored',
    );
    expect(errored?.code).toBe('APPROVAL_FAILED');
  });

  it('emits "rejected" (not "replayed") when the replayed request comes back 402', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    fetchSpy.mockResolvedValueOnce(new Response('still payment required', { status: 402 }));
    const { emit, events } = captureEvents();
    await runPayPipeline(
      {
        client: makeClient(),
        apiBaseUrl: 'https://api.inflowpay.ai',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: { timeoutMs: 900_000 },
        showBody: false,
      },
      emit,
    );
    const rejected = events.find(
      (e): e is { type: 'rejected'; result: Record<string, unknown> } => (e as { type?: string }).type === 'rejected',
    );
    expect(rejected).toBeDefined();
    expect(rejected?.result.outcome).toBe('replay-rejected');
    expect(rejected?.result.responseStatus).toBe(402);
    expect(rejected?.result.transactionId).toBe('txn_1');
    expect(rejected?.result.approvalId).toBe('appr_1');
    expect(rejected?.result.approvalUrl).toBe('https://app.inflowpay.ai/approvals/appr_1/view/');
    const replayed = events.find((e) => (e as { type?: string }).type === 'replayed');
    expect(replayed).toBeUndefined();
  });

  it('emits "rejected" for a 5xx replay response too (not just 402)', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    fetchSpy.mockResolvedValueOnce(new Response('server error', { status: 503 }));
    const { emit, events } = captureEvents();
    await runPayPipeline(
      {
        client: makeClient(),
        apiBaseUrl: 'https://api.inflowpay.ai',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: { timeoutMs: 900_000 },
        showBody: false,
      },
      emit,
    );
    const rejected = events.find(
      (e): e is { type: 'rejected'; result: Record<string, unknown> } => (e as { type?: string }).type === 'rejected',
    );
    expect(rejected?.result.responseStatus).toBe(503);
  });

  it('emits UNEXPECTED_PROBE_STATUS (not "short-circuited") when the probe returns a non-2xx, non-402 status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const { emit, events } = captureEvents();
    await runPayPipeline(
      {
        client: makeClient(),
        apiBaseUrl: 'https://api.inflowpay.ai',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: { timeoutMs: 900_000 },
        showBody: false,
      },
      emit,
    );
    const errored = events.find(
      (e): e is { type: 'errored'; code: string; message: string } => (e as { type?: string }).type === 'errored',
    );
    expect(errored?.code).toBe(UNEXPECTED_PROBE_STATUS_CODE);
    expect(errored?.message).toContain('404');
    const shortCircuited = events.find((e) => (e as { type?: string }).type === 'short-circuited');
    expect(shortCircuited).toBeUndefined();
  });

  it('still short-circuits cleanly on a real 2xx no-payment response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const { emit, events } = captureEvents();
    await runPayPipeline(
      {
        client: makeClient(),
        apiBaseUrl: 'https://api.inflowpay.ai',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: { timeoutMs: 900_000 },
        showBody: false,
      },
      emit,
    );
    const last = events[events.length - 1] as { type: string };
    expect(last.type).toBe('short-circuited');
    expect(PAYMENT_NOT_ACCEPTED_CODE).toBe('PAYMENT_NOT_ACCEPTED');
  });

  it('--output-file writes the response bytes to disk and sets outputSavedTo on the success result', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'inflow-pay-save-'));
    const target = join(tmp, 'article.pdf');
    try {
      const header = encodePaymentRequiredHeader(makePaymentRequired());
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      fetchSpy.mockResolvedValueOnce(
        new Response('payment required', {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': header },
        }),
      );
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
      fetchSpy.mockResolvedValueOnce(
        new Response(pdfBytes, {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        }),
      );
      const { emit, events } = captureEvents();
      await runPayPipeline(
        {
          client: makeClient(),
          apiBaseUrl: 'https://api.inflowpay.ai',
          probeOptions: { method: 'GET', headers: {} },
          url: 'https://seller/api',
          signOptions: { timeoutMs: 900_000 },
          showBody: true,
          outputFile: target,
        },
        emit,
      );
      const replayed = events.find(
        (
          e,
        ): e is {
          type: 'replayed';
          result: {
            outcome: string;
            outputSavedTo?: string;
            body?: string;
            bodyBase64?: string;
            bodySizeBytes: number;
          };
        } => (e as { type?: string }).type === 'replayed',
      );
      expect(replayed?.result.outcome).toBe('paid');
      expect(replayed?.result.outputSavedTo).toBe(target);
      expect(replayed?.result.body).toBeUndefined();
      expect(replayed?.result.bodyBase64).toBeUndefined();
      expect(replayed?.result.bodySizeBytes).toBe(pdfBytes.byteLength);
      const written = readFileSync(target);
      expect(Array.from(written)).toEqual(Array.from(pdfBytes));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('default showBody=true includes body inline when --output-file is not set', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response('{"hello":"world"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { emit, events } = captureEvents();
    await runPayPipeline(
      {
        client: makeClient(),
        apiBaseUrl: 'https://api.inflowpay.ai',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: { timeoutMs: 900_000 },
        showBody: true,
      },
      emit,
    );
    const replayed = events.find(
      (
        e,
      ): e is {
        type: 'replayed';
        result: { body?: string; bodyBase64?: string; outputSavedTo?: string };
      } => (e as { type?: string }).type === 'replayed',
    );
    expect(replayed?.result.body).toBe('{"hello":"world"}');
    expect(replayed?.result.bodyBase64).toBeUndefined();
    expect(replayed?.result.outputSavedTo).toBeUndefined();
  });
});

describe('filterAccepts', () => {
  it('returns the input unchanged when no filter is set', () => {
    const decoded = makeMultiAcceptPaymentRequired();
    const out = filterAccepts(decoded, {});
    expect(out).toBe(decoded);
  });

  it('filters by scheme alone, keeping every matching network', () => {
    const decoded = makeMultiAcceptPaymentRequired();
    const out = filterAccepts(decoded, { scheme: 'exact' });
    expect(out.accepts.map((a) => `${a.scheme}/${a.network}`)).toEqual([
      'exact/eip155:84532',
      'exact/solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    ]);
  });

  it('filters by network alone', () => {
    const decoded = makeMultiAcceptPaymentRequired();
    const out = filterAccepts(decoded, { network: 'inflow:1' });
    expect(out.accepts.map((a) => `${a.scheme}/${a.network}`)).toEqual(['balance/inflow:1']);
  });

  it('AND-combines scheme and network for a single-pair filter', () => {
    const decoded = makeMultiAcceptPaymentRequired();
    const out = filterAccepts(decoded, { scheme: 'exact', network: 'eip155:84532' });
    expect(out.accepts).toHaveLength(1);
    expect(out.accepts[0]?.scheme).toBe('exact');
    expect(out.accepts[0]?.network).toBe('eip155:84532');
  });

  it('returns empty accepts when no entry matches', () => {
    const decoded = makeMultiAcceptPaymentRequired();
    const out = filterAccepts(decoded, { scheme: 'balance', network: 'eip155:84532' });
    expect(out.accepts).toEqual([]);
  });

  it('preserves non-accepts fields when filtering', () => {
    const decoded = makeMultiAcceptPaymentRequired();
    const out = filterAccepts(decoded, { scheme: 'exact' });
    expect(out.x402Version).toBe(decoded.x402Version);
    expect(out.resource).toBe(decoded.resource);
  });

  it('filters by asset alone', () => {
    const decoded = makeMultiAcceptPaymentRequired();
    // Override one entry's asset so filtering is discriminating.
    decoded.accepts[1] = { ...decoded.accepts[1], asset: '0xUSDC' } as (typeof decoded.accepts)[number];
    const out = filterAccepts(decoded, { asset: '0xUSDC' });
    expect(out.accepts).toHaveLength(1);
    expect(out.accepts[0]?.asset).toBe('0xUSDC');
  });

  it('filters by assetName (extra.name) alone', () => {
    const decoded = makeMultiAcceptPaymentRequired();
    decoded.accepts[1] = {
      ...decoded.accepts[1],
      extra: { name: 'USDC' },
    } as (typeof decoded.accepts)[number];
    decoded.accepts[2] = {
      ...decoded.accepts[2],
      extra: { name: 'PYUSD' },
    } as (typeof decoded.accepts)[number];
    const out = filterAccepts(decoded, { assetName: 'USDC' });
    expect(out.accepts).toHaveLength(1);
    expect(out.accepts[0]?.network).toBe('eip155:84532');
  });

  it('AND-combines all four filters', () => {
    const decoded = makeMultiAcceptPaymentRequired();
    decoded.accepts[1] = {
      ...decoded.accepts[1],
      asset: '0xUSDC',
      extra: { name: 'USDC' },
    } as (typeof decoded.accepts)[number];
    const out = filterAccepts(decoded, {
      scheme: 'exact',
      network: 'eip155:84532',
      asset: '0xUSDC',
      assetName: 'USDC',
    });
    expect(out.accepts).toHaveLength(1);
    expect(out.accepts[0]?.scheme).toBe('exact');
  });
});

describe('buildNoFilteredMatchMessage', () => {
  it("lists the seller's available pairs so the user can fix the flag", () => {
    const msg = buildNoFilteredMatchMessage(makeMultiAcceptPaymentRequired(), {
      scheme: 'balance',
      network: 'eip155:84532',
    });
    expect(msg).toContain('--scheme=balance');
    expect(msg).toContain('--network=eip155:84532');
    expect(msg).toContain('balance/inflow:1');
    expect(msg).toContain('exact/eip155:84532');
  });

  it('includes --asset and --asset-name in the filter description when set', () => {
    const decoded = makeMultiAcceptPaymentRequired();
    decoded.accepts[0] = {
      ...decoded.accepts[0],
      asset: '0xUSDC',
      extra: { name: 'USDC' },
    } as (typeof decoded.accepts)[number];
    const msg = buildNoFilteredMatchMessage(decoded, { asset: '0xMISSING', assetName: 'PYUSD' });
    expect(msg).toContain('--asset=0xMISSING');
    expect(msg).toContain('--asset-name=PYUSD');
    expect(msg).toContain('asset=0xUSDC');
    expect(msg).toContain('name=USDC');
  });

  it('says "(none)" when the seller has no accepts entries', () => {
    const decoded: PaymentRequired = {
      ...makePaymentRequired(),
      accepts: [],
    };
    const msg = buildNoFilteredMatchMessage(decoded, { scheme: 'balance' });
    expect(msg).toContain('(none)');
  });
});

describe('runPayPipeline with --scheme / --network / --asset / --asset-name filters', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes to the selected scheme/network pair when filter narrows accepts', async () => {
    const header = encodePaymentRequiredHeader(makeMultiAcceptPaymentRequired());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    fetchSpy.mockResolvedValueOnce(new Response('paid-body', { status: 200 }));
    const selectSpy = vi.fn((_decoded: PaymentRequired) => makeRequirement());
    const client = makeClient({
      selectInflowRequirement: selectSpy,
    } as Partial<X402InflowClient>);
    const { emit, events } = captureEvents();
    await runPayPipeline(
      {
        client,
        apiBaseUrl: 'https://api.inflowpay.ai',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: { timeoutMs: 900_000 },
        showBody: false,
        schemeFilter: 'exact',
        networkFilter: 'eip155:84532',
      },
      emit,
    );
    expect(selectSpy).toHaveBeenCalledTimes(1);
    const arg = selectSpy.mock.calls[0]?.[0];
    expect(arg?.accepts).toHaveLength(1);
    expect(arg?.accepts[0]?.scheme).toBe('exact');
    expect(arg?.accepts[0]?.network).toBe('eip155:84532');
    const replayed = events.find((e) => (e as { type?: string }).type === 'replayed');
    expect(replayed).toBeDefined();
  });

  it('emits NO_FILTERED_MATCH when --scheme excludes every accept entry', async () => {
    const header = encodePaymentRequiredHeader(makeMultiAcceptPaymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const selectSpy = vi.fn((_decoded: PaymentRequired) => makeRequirement());
    const client = makeClient({
      selectInflowRequirement: selectSpy,
    } as Partial<X402InflowClient>);
    const { emit, events } = captureEvents();
    await runPayPipeline(
      {
        client,
        apiBaseUrl: 'https://api.inflowpay.ai',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: { timeoutMs: 900_000 },
        showBody: false,
        schemeFilter: 'paymaster',
      },
      emit,
    );
    expect(selectSpy).not.toHaveBeenCalled();
    const errored = events.find(
      (e): e is { type: 'errored'; code: string; message: string } => (e as { type?: string }).type === 'errored',
    );
    expect(errored?.code).toBe(NO_FILTERED_MATCH_CODE);
    expect(errored?.message).toContain('--scheme=paymaster');
    expect(errored?.message).toContain('balance/inflow:1');
  });

  it('emits NO_FILTERED_MATCH when --network excludes every accept entry', async () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const { emit, events } = captureEvents();
    await runPayPipeline(
      {
        client: makeClient(),
        apiBaseUrl: 'https://api.inflowpay.ai',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: { timeoutMs: 900_000 },
        showBody: false,
        networkFilter: 'eip155:1',
      },
      emit,
    );
    const errored = events.find(
      (e): e is { type: 'errored'; code: string; message: string } => (e as { type?: string }).type === 'errored',
    );
    expect(errored?.code).toBe(NO_FILTERED_MATCH_CODE);
    expect(errored?.message).toContain('--network=eip155:1');
  });

  it('emits NO_FILTERED_MATCH when --asset excludes every accept entry', async () => {
    const decoded = makeMultiAcceptPaymentRequired();
    const header = encodePaymentRequiredHeader(decoded);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const selectSpy = vi.fn((_decoded: PaymentRequired) => makeRequirement());
    const client = makeClient({
      selectInflowRequirement: selectSpy,
    } as Partial<X402InflowClient>);
    const { emit, events } = captureEvents();
    await runPayPipeline(
      {
        client,
        apiBaseUrl: 'https://api.inflowpay.ai',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: { timeoutMs: 900_000 },
        showBody: false,
        assetFilter: '0xMISSING',
      },
      emit,
    );
    expect(selectSpy).not.toHaveBeenCalled();
    const errored = events.find(
      (e): e is { type: 'errored'; code: string; message: string } => (e as { type?: string }).type === 'errored',
    );
    expect(errored?.code).toBe(NO_FILTERED_MATCH_CODE);
    expect(errored?.message).toContain('--asset=0xMISSING');
  });

  it('emits NO_FILTERED_MATCH when --asset-name excludes every accept entry', async () => {
    const decoded = makeMultiAcceptPaymentRequired();
    decoded.accepts[0] = {
      ...decoded.accepts[0],
      extra: { name: 'USDC' },
    } as (typeof decoded.accepts)[number];
    const header = encodePaymentRequiredHeader(decoded);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const selectSpy = vi.fn((_decoded: PaymentRequired) => makeRequirement());
    const client = makeClient({
      selectInflowRequirement: selectSpy,
    } as Partial<X402InflowClient>);
    const { emit, events } = captureEvents();
    await runPayPipeline(
      {
        client,
        apiBaseUrl: 'https://api.inflowpay.ai',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: { timeoutMs: 900_000 },
        showBody: false,
        assetNameFilter: 'PYUSD',
      },
      emit,
    );
    expect(selectSpy).not.toHaveBeenCalled();
    const errored = events.find(
      (e): e is { type: 'errored'; code: string; message: string } => (e as { type?: string }).type === 'errored',
    );
    expect(errored?.code).toBe(NO_FILTERED_MATCH_CODE);
    expect(errored?.message).toContain('--asset-name=PYUSD');
  });

  it('falls through to NO_INFLOW_MATCH when filter has matches but selector returns null', async () => {
    const header = encodePaymentRequiredHeader(makeMultiAcceptPaymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const client = makeClient({
      selectInflowRequirement: vi.fn(() => null),
    } as Partial<X402InflowClient>);
    const { emit, events } = captureEvents();
    await runPayPipeline(
      {
        client,
        apiBaseUrl: 'https://api.inflowpay.ai',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: { timeoutMs: 900_000 },
        showBody: false,
        schemeFilter: 'exact',
        networkFilter: 'eip155:84532',
      },
      emit,
    );
    const errored = events.find(
      (e): e is { type: 'errored'; code: string; message: string } => (e as { type?: string }).type === 'errored',
    );
    expect(errored?.code).toBe(NO_INFLOW_MATCH_CODE);
  });
});
