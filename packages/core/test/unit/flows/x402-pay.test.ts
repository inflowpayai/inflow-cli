import {
  X402AdapterRoutingError,
  X402ApprovalCancelledError,
  X402ApprovalFailedError,
  X402ApprovalTimeoutError,
  X402PaymentIdFormatError,
} from '@inflowpayai/x402-buyer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildBodyAttachment,
  mapSdkError,
  reducePay,
  runPayPipeline,
  type PayEvent,
} from '../../../src/flows/x402-pay.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reducePay', () => {
  it('errored -> error phase carrying code + message', () => {
    expect(reducePay({ kind: 'probing' }, { type: 'errored', code: 'X', message: 'oops' })).toEqual({
      kind: 'error',
      code: 'X',
      message: 'oops',
    });
  });

  it('short-circuited -> no-payment-final', () => {
    const result = {
      outcome: 'no-payment-required' as const,
      url: 'https://seller/api',
      method: 'GET',
      status: 200,
      contentType: 'text/plain',
      bodySizeBytes: 5,
    };
    expect(reducePay({ kind: 'probing' }, { type: 'short-circuited', result })).toEqual({
      kind: 'no-payment-final',
      result,
    });
  });
});

describe('mapSdkError', () => {
  it('classifies X402PaymentIdFormatError as INVALID_PAYMENT_ID', () => {
    const err = new X402PaymentIdFormatError('bad');
    expect(mapSdkError(err)).toEqual({ code: 'INVALID_PAYMENT_ID', message: err.message });
  });

  it('classifies X402ApprovalCancelledError as APPROVAL_CANCELLED', () => {
    const err = new X402ApprovalCancelledError('appr_1');
    expect(mapSdkError(err)).toEqual({ code: 'APPROVAL_CANCELLED', message: err.message });
  });

  it('classifies X402ApprovalFailedError as APPROVAL_FAILED', () => {
    const err = new X402ApprovalFailedError('appr_1', 'DECLINED');
    expect(mapSdkError(err)).toEqual({ code: 'APPROVAL_FAILED', message: err.message });
  });

  it('classifies X402ApprovalTimeoutError as APPROVAL_TIMEOUT', () => {
    const err = new X402ApprovalTimeoutError('appr_1', 1000);
    expect(mapSdkError(err)).toEqual({ code: 'APPROVAL_TIMEOUT', message: err.message });
  });

  it('classifies X402AdapterRoutingError as NO_INFLOW_MATCH with the canned message', () => {
    const err = new X402AdapterRoutingError('exact', 'base');
    const out = mapSdkError(err);
    expect(out.code).toBe('NO_INFLOW_MATCH');
    expect(out.message).toContain('Seller does not accept InFlow-signed payments');
  });

  it('falls through to PAYMENT_FAILED for unrecognised errors', () => {
    expect(mapSdkError(new Error('something'))).toEqual({ code: 'PAYMENT_FAILED', message: 'something' });
  });

  it('surfaces an SDK API error with the server code and a message free of endpoint/status/request-id', () => {
    // Shape of the `@inflowpayai/x402` InflowApiError: a string `code` + `endpoint`, and a `.message` that the SDK
    // composes as `[<requestId>] <endpoint>: <httpStatus> <code> — <serverMessage>`.
    const apiError = Object.assign(
      new Error(
        '[req_abc] /v1/transactions/x402: 400 INSUFFICIENT_FUNDS — Insufficient funds for x402 payment requirements.',
      ),
      { code: 'INSUFFICIENT_FUNDS', endpoint: '/v1/transactions/x402', httpStatus: 400 },
    );
    const out = mapSdkError(apiError);
    expect(out.code).toBe('INSUFFICIENT_FUNDS');
    expect(out.message).toBe('Insufficient funds for x402 payment requirements.');
    expect(out.message).not.toContain('/v1/transactions/x402');
    expect(out.message).not.toContain('400');
    expect(out.message).not.toContain('req_abc');
  });
});

describe('buildBodyAttachment', () => {
  it('returns only the byte size when showBody is false and outputFile is unset', async () => {
    const out = await buildBodyAttachment(new TextEncoder().encode('hello'), false, undefined);
    expect(out).toEqual({ bodySizeBytes: 5 });
  });

  it('includes the utf-8 body when showBody=true and the bytes decode cleanly', async () => {
    const out = await buildBodyAttachment(new TextEncoder().encode('hello'), true, undefined);
    expect(out.body).toBe('hello');
    expect(out.bodyBase64).toBeUndefined();
  });

  it('emits base64 when bytes are not valid utf-8', async () => {
    const out = await buildBodyAttachment(new Uint8Array([0xff, 0xfe, 0xfd]), true, undefined);
    expect(out.bodyBase64).toBeDefined();
    expect(out.body).toBeUndefined();
  });
});

describe('runPayPipeline', () => {
  function captureEmits(): { events: PayEvent[]; emit: (e: PayEvent) => void } {
    const events: PayEvent[] = [];
    return { events, emit: (e) => events.push(e) };
  }

  function fakeClient(): unknown {
    return {
      selectInflowRequirement: vi.fn().mockReturnValue(null),
      prepareInflowPayment: vi.fn(),
      getX402Payload: vi.fn(),
      cancelApproval: vi.fn(),
      getSupported: vi.fn(),
    };
  }

  it('emits short-circuited when the seller returns 2xx without payment', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const { events, emit } = captureEmits();
    await runPayPipeline(
      {
        client: fakeClient() as never,
        apiBaseUrl: 'https://api.test',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: {},
        showBody: true,
      },
      emit,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('short-circuited');
  });

  it('emits errored with UNEXPECTED_PROBE_STATUS for non-2xx-non-402 probes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('teapot', { status: 418 }));
    const { events, emit } = captureEmits();
    await runPayPipeline(
      {
        client: fakeClient() as never,
        apiBaseUrl: 'https://api.test',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: {},
        showBody: false,
      },
      emit,
    );
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.type).toBe('errored');
    if (ev?.type === 'errored') {
      expect(ev.code).toBe('UNEXPECTED_PROBE_STATUS');
    }
  });

  it('emits errored with INVALID_402 when 402 lacks a PAYMENT-REQUIRED header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('payment required', { status: 402 }));
    const { events, emit } = captureEmits();
    await runPayPipeline(
      {
        client: fakeClient() as never,
        apiBaseUrl: 'https://api.test',
        probeOptions: { method: 'GET', headers: {} },
        url: 'https://seller/api',
        signOptions: {},
        showBody: false,
      },
      emit,
    );
    const ev = events[events.length - 1];
    expect(ev?.type).toBe('errored');
    if (ev?.type === 'errored') {
      expect(ev.code).toBe('INVALID_402');
    }
  });
});
