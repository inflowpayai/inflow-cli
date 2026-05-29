import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAcceptsFrame,
  buildNoPaymentFrame,
  type InspectResultAccepts,
  type InspectResultNoPayment,
  runInspectPipeline,
} from '../../../../src/commands/x402/inspect.js';
import {
  INVALID_402_CODE,
  NO_FILTERED_MATCH_CODE,
  UNEXPECTED_PROBE_STATUS_CODE,
} from '../../../../src/commands/x402/pay.js';

function makeSingleAcceptHeader(): string {
  return encodePaymentRequiredHeader({
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
  });
}

function makeMultiAcceptHeader(): string {
  return encodePaymentRequiredHeader({
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
        extra: {
          name: 'USD Coin',
          version: '2',
          assetTransferMethod: 'eip3009',
        },
      },
    ],
  });
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runInspectPipeline', () => {
  it('emits an accepts event with decoded rows on a 402 probe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': makeMultiAcceptHeader() },
      }),
    );
    const { emit, events } = captureEvents();
    await runInspectPipeline(
      {
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
      },
      emit,
    );
    const event = events.find(
      (e): e is { type: 'accepts'; result: InspectResultAccepts } => (e as { type?: string }).type === 'accepts',
    );
    expect(event?.result.outcome).toBe('accepts');
    expect(event?.result.accepts).toHaveLength(2);
    expect(event?.result.x402Version).toBe(2);
    expect(event?.result.resource).toBe('https://seller/api');
    const second = event?.result.accepts[1];
    expect(second?.extra).toEqual({
      name: 'USD Coin',
      version: '2',
      assetTransferMethod: 'eip3009',
    });
  });

  it('emits a no-payment event on a 2xx probe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('hello', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const { emit, events } = captureEvents();
    await runInspectPipeline(
      {
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
      },
      emit,
    );
    const event = events.find(
      (e): e is { type: 'no-payment'; result: InspectResultNoPayment } =>
        (e as { type?: string }).type === 'no-payment',
    );
    expect(event?.result.outcome).toBe('no-payment-required');
    expect(event?.result.status).toBe(200);
    expect(event?.result.contentType).toBe('text/plain');
    expect(event?.result.bodySizeBytes).toBe('hello'.length);
  });

  it('emits UNEXPECTED_PROBE_STATUS on a non-2xx / non-402 probe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('server error', { status: 503 }));
    const { emit, events } = captureEvents();
    await runInspectPipeline(
      {
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
      },
      emit,
    );
    const errored = events.find(
      (e): e is { type: 'errored'; code: string; message: string } => (e as { type?: string }).type === 'errored',
    );
    expect(errored?.code).toBe(UNEXPECTED_PROBE_STATUS_CODE);
    expect(errored?.message).toContain('503');
  });

  it('emits INVALID_402 when 402 is missing the PAYMENT-REQUIRED header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 402 }));
    const { emit, events } = captureEvents();
    await runInspectPipeline(
      {
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
      },
      emit,
    );
    const errored = events.find(
      (e): e is { type: 'errored'; code: string; message: string } => (e as { type?: string }).type === 'errored',
    );
    expect(errored?.code).toBe(INVALID_402_CODE);
  });

  it('emits DECODE_FAILED on a malformed PAYMENT-REQUIRED header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': 'not-base64-at-all-just-text!!!' },
      }),
    );
    const { emit, events } = captureEvents();
    await runInspectPipeline(
      {
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
      },
      emit,
    );
    const errored = events.find(
      (e): e is { type: 'errored'; code: string; message: string } => (e as { type?: string }).type === 'errored',
    );
    expect(errored?.code).toBe('DECODE_FAILED');
  });

  it('narrows accepts to the --scheme / --network filter', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': makeMultiAcceptHeader() },
      }),
    );
    const { emit, events } = captureEvents();
    await runInspectPipeline(
      {
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        schemeFilter: 'exact',
        networkFilter: 'eip155:84532',
      },
      emit,
    );
    const event = events.find(
      (e): e is { type: 'accepts'; result: InspectResultAccepts } => (e as { type?: string }).type === 'accepts',
    );
    expect(event?.result.accepts).toHaveLength(1);
    expect(event?.result.accepts[0]?.scheme).toBe('exact');
    expect(event?.result.accepts[0]?.network).toBe('eip155:84532');
  });

  it('emits NO_FILTERED_MATCH when the filter empties the accepts list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': makeSingleAcceptHeader() },
      }),
    );
    const { emit, events } = captureEvents();
    await runInspectPipeline(
      {
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        schemeFilter: 'paymaster',
      },
      emit,
    );
    const errored = events.find(
      (e): e is { type: 'errored'; code: string; message: string } => (e as { type?: string }).type === 'errored',
    );
    expect(errored?.code).toBe(NO_FILTERED_MATCH_CODE);
    expect(errored?.message).toContain('--scheme=paymaster');
    expect(errored?.message).toContain('balance/inflow:1');
  });

  it('translates a fetch rejection into INSPECT_FAILED', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network down'));
    const { emit, events } = captureEvents();
    await runInspectPipeline(
      {
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
      },
      emit,
    );
    const errored = events.find(
      (e): e is { type: 'errored'; code: string; message: string } => (e as { type?: string }).type === 'errored',
    );
    expect(errored?.code).toBe('INSPECT_FAILED');
    expect(errored?.message).toContain('network down');
  });
});

describe('buildAcceptsFrame', () => {
  it('snake-cases field names and preserves extra verbatim', () => {
    const result: InspectResultAccepts = {
      outcome: 'accepts',
      url: 'https://seller/api',
      method: 'GET',
      resource: 'https://seller/api',
      x402Version: 2,
      accepts: [
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
    const frame = buildAcceptsFrame(result);
    expect(frame.outcome).toBe('accepts');
    expect(frame.x402_version).toBe(2);
    expect(frame.method).toBe('GET');
    const rows = frame.accepts as Array<Record<string, unknown>>;
    expect(rows[0]?.pay_to).toBe('0xabc');
    expect(rows[0]?.max_timeout_seconds).toBe(60);
    expect(rows[0]?.extra).toEqual({ name: 'USD Coin' });
  });

  it('omits the row-level extra key when undefined (no `extra: undefined`)', () => {
    const result: InspectResultAccepts = {
      outcome: 'accepts',
      url: 'https://seller/api',
      method: 'GET',
      resource: 'https://seller/api',
      x402Version: 2,
      accepts: [
        {
          scheme: 'balance',
          network: 'inflow:1',
          amount: '500',
          payTo: 'inflow:abc',
          maxTimeoutSeconds: 60,
          asset: 'USDC',
        },
      ],
    };
    const frame = buildAcceptsFrame(result);
    const rows = frame.accepts as Array<Record<string, unknown>>;
    expect(rows[0]).toBeDefined();
    expect('extra' in (rows[0] ?? {})).toBe(false);
  });

  it('includes extensions only when present in the source result', () => {
    const base: InspectResultAccepts = {
      outcome: 'accepts',
      url: 'https://seller/api',
      method: 'GET',
      resource: 'https://seller/api',
      x402Version: 2,
      accepts: [],
    };
    expect('extensions' in buildAcceptsFrame(base)).toBe(false);

    const withExt: InspectResultAccepts = {
      ...base,
      extensions: { 'payment-identifier': { required: true } },
    };
    const frame = buildAcceptsFrame(withExt);
    expect(frame.extensions).toEqual({
      'payment-identifier': { required: true },
    });
  });
});

describe('buildNoPaymentFrame', () => {
  it('builds a body-less frame with status, content_type and size', () => {
    const result: InspectResultNoPayment = {
      outcome: 'no-payment-required',
      url: 'https://seller/api',
      method: 'GET',
      status: 200,
      contentType: 'application/json',
      bodySizeBytes: 17,
    };
    const frame = buildNoPaymentFrame(result);
    expect(frame.outcome).toBe('no-payment-required');
    expect(frame.status).toBe(200);
    expect(frame.content_type).toBe('application/json');
    expect(frame.body_size_bytes).toBe(17);
    expect('body' in frame).toBe(false);
    expect('body_base64' in frame).toBe(false);
    expect('output_saved_to' in frame).toBe(false);
  });

  it('omits content_type when the seller did not send one', () => {
    const result: InspectResultNoPayment = {
      outcome: 'no-payment-required',
      url: 'https://seller/api',
      method: 'GET',
      status: 204,
      contentType: undefined,
      bodySizeBytes: 0,
    };
    const frame = buildNoPaymentFrame(result);
    expect('content_type' in frame).toBe(false);
  });
});

void ({} as PaymentRequired | undefined);
