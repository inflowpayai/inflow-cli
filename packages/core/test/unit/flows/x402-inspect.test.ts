import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PaymentInspectionBlockedError,
  reduceX402Inspect,
  runInspectPipeline,
  type InspectEvent,
} from '../../../src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reduceX402Inspect', () => {
  it('errored -> error with code + message', () => {
    expect(reduceX402Inspect({ kind: 'probing' }, { type: 'errored', code: 'X', message: 'oops' })).toEqual({
      kind: 'error',
      code: 'X',
      message: 'oops',
    });
  });

  it('blocked -> blocked with non-secret AEP metadata', () => {
    const blocked = {
      method: 'GET',
      url: 'https://seller/api',
      message: 'AEP authentication is required before payment terms can be inspected.',
      source: 'openapi' as const,
      serviceDid: 'did:web:seller',
      serviceUrl: 'https://seller',
    };
    expect(reduceX402Inspect({ kind: 'probing' }, { type: 'blocked', result: blocked })).toEqual({
      kind: 'blocked',
      result: blocked,
    });
  });
});

describe('runInspectPipeline', () => {
  function captureEmits(): { events: InspectEvent[]; emit: (e: InspectEvent) => void } {
    const events: InspectEvent[] = [];
    return { events, emit: (e) => events.push(e) };
  }

  it('emits no-payment when the seller responds 2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const { events, emit } = captureEmits();
    await runInspectPipeline({ url: 'https://seller/api', probeOptions: { method: 'GET', headers: {} } }, emit);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('no-payment');
  });

  it('emits errored with UNEXPECTED_PROBE_STATUS when the seller returns neither 2xx nor 402', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('teapot', { status: 418 }));
    const { events, emit } = captureEmits();
    await runInspectPipeline({ url: 'https://seller/api', probeOptions: { method: 'GET', headers: {} } }, emit);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.type).toBe('errored');
    if (ev?.type === 'errored') {
      expect(ev.code).toBe('UNEXPECTED_PROBE_STATUS');
    }
  });

  it('emits errored with INSPECT_FAILED when sellerProbe throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const { events, emit } = captureEmits();
    await runInspectPipeline({ url: 'https://seller/api', probeOptions: { method: 'GET', headers: {} } }, emit);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.type).toBe('errored');
    if (ev?.type === 'errored') {
      expect(ev.code).toBe('INSPECT_FAILED');
    }
  });

  it('emits blocked when AEP authentication is required before x402 inspection', async () => {
    const { events, emit } = captureEmits();
    await runInspectPipeline(
      {
        url: 'https://seller/api',
        probeOptions: { method: 'GET', headers: {} },
        probe: () =>
          Promise.reject(
            new PaymentInspectionBlockedError({
              method: 'GET',
              url: 'https://seller/api',
              message: 'AEP authentication is required before payment terms can be inspected.',
              source: 'challenge',
              serviceDid: 'did:web:seller',
              serviceUrl: 'https://seller',
            }),
          ),
      },
      emit,
    );
    expect(events).toEqual([
      {
        type: 'blocked',
        result: {
          method: 'GET',
          url: 'https://seller/api',
          message: 'AEP authentication is required before payment terms can be inspected.',
          source: 'challenge',
          serviceDid: 'did:web:seller',
          serviceUrl: 'https://seller',
        },
      },
    ]);
  });

  it('emits errored with INVALID_402 when 402 lacks a PAYMENT-REQUIRED header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('payment required', { status: 402 }));
    const { events, emit } = captureEmits();
    await runInspectPipeline({ url: 'https://seller/api', probeOptions: { method: 'GET', headers: {} } }, emit);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.type).toBe('errored');
    if (ev?.type === 'errored') {
      expect(ev.code).toBe('INVALID_402');
    }
  });
});
