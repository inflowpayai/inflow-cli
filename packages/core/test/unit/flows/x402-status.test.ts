import type { X402PayloadResponse } from '@inflowpayai/x402-buyer';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyPayloadResponse,
  reduceX402Status,
  runX402Status,
  TERMINAL_FAILURE_STATUSES,
} from '../../../src/flows/x402-status.js';

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iterable) out.push(v);
  return out;
}

describe('classifyPayloadResponse', () => {
  it('classifies as signed when both payloads are present', () => {
    expect(
      classifyPayloadResponse({
        status: 'SIGNED',
        encodedPayload: 'ep',
        paymentPayload: 'pp',
      } as unknown as X402PayloadResponse),
    ).toBe('signed');
  });

  it('classifies terminal failure statuses as failed', () => {
    for (const status of TERMINAL_FAILURE_STATUSES) {
      expect(classifyPayloadResponse({ status })).toBe('failed');
    }
  });

  it('classifies everything else as pending', () => {
    expect(classifyPayloadResponse({ status: 'INITIATED' })).toBe('pending');
    expect(classifyPayloadResponse({ status: 'AWAITING_SIGNATURE' })).toBe('pending');
  });
});

describe('reduceX402Status', () => {
  it('snapshot updates the latest poll value', () => {
    const response = { status: 'INITIATED' } as unknown as X402PayloadResponse;
    expect(reduceX402Status({ kind: 'polling' }, { type: 'snapshot', response })).toEqual({
      kind: 'polling',
      latest: response,
    });
  });

  it('settled transitions to signed', () => {
    const response = { status: 'SIGNED' } as unknown as X402PayloadResponse;
    expect(reduceX402Status({ kind: 'polling' }, { type: 'settled', response })).toEqual({
      kind: 'signed',
      response,
    });
  });

  it('timedOut without response yields a bare timeout', () => {
    expect(reduceX402Status({ kind: 'polling' }, { type: 'timedOut' })).toEqual({ kind: 'timeout' });
  });

  it('crashed surfaces the message', () => {
    expect(reduceX402Status({ kind: 'polling' }, { type: 'crashed', message: 'boom' })).toEqual({
      kind: 'error',
      message: 'boom',
    });
  });
});

describe('runX402Status', () => {
  it('emits settled when a signed payload arrives', async () => {
    const signed = {
      status: 'SIGNED',
      encodedPayload: 'ep',
      paymentPayload: 'pp',
    } as unknown as X402PayloadResponse;
    const fetchOnce = vi.fn().mockResolvedValue(signed);
    const events = await drain(runX402Status({ fetchOnce, interval: 0.01, maxAttempts: 5, timeout: 30 }).events);
    expect(events.map((e) => e.type)).toEqual(['settled']);
  });

  it('emits failed when the server reaches a terminal failure status', async () => {
    const declined = { status: 'DECLINED' } as unknown as X402PayloadResponse;
    const fetchOnce = vi.fn().mockResolvedValue(declined);
    const events = await drain(runX402Status({ fetchOnce, interval: 0.01, maxAttempts: 5, timeout: 30 }).events);
    expect(events.map((e) => e.type)).toEqual(['failed']);
  });

  it('emits crashed when fetchOnce throws', async () => {
    const fetchOnce = vi.fn().mockRejectedValue(new Error('boom'));
    const events = await drain(runX402Status({ fetchOnce, interval: 0.01, maxAttempts: 5, timeout: 30 }).events);
    expect(events).toEqual([{ type: 'crashed', message: 'boom' }]);
  });
});
