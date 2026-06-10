import type { X402PayloadResponse } from '@inflowpayai/x402-buyer';
import { describe, expect, it, vi } from 'vitest';
import { reduceX402Status, runX402Status, type X402StatusEvent } from '../../../src/flows/x402-status.js';

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iterable) out.push(v);
  return out;
}

const pending = { status: 'INITIATED' } as unknown as X402PayloadResponse;
const signed = { status: 'SIGNED', encodedPayload: 'ep', paymentPayload: 'pp' } as unknown as X402PayloadResponse;

describe('reduceX402Status — remaining transitions', () => {
  it('failed transitions to the failed phase carrying the response', () => {
    const response = { status: 'DECLINED' } as unknown as X402PayloadResponse;
    expect(reduceX402Status({ kind: 'polling' }, { type: 'failed', response })).toEqual({ kind: 'failed', response });
  });

  it('timedOut with a response keeps the last snapshot on the timeout phase', () => {
    expect(reduceX402Status({ kind: 'polling' }, { type: 'timedOut', response: pending })).toEqual({
      kind: 'timeout',
      response: pending,
    });
  });

  it('returns the prior state for an unrecognised event (default branch)', () => {
    const prior = { kind: 'polling' } as const;
    expect(reduceX402Status(prior, { type: 'bogus' } as never)).toBe(prior);
  });
});

describe('runX402Status — polling paths', () => {
  it('yields a snapshot for the pending tick, dedups the repeat, then settles', async () => {
    const fetchOnce = vi
      .fn<() => Promise<X402PayloadResponse>>()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(signed);
    const events = await drain(runX402Status({ fetchOnce, interval: 0.01, maxAttempts: 10, timeout: 30 }).events);
    expect(events.map((e) => e.type)).toEqual(['snapshot', 'settled']);
    const settledEvent = events.at(-1) as X402StatusEvent;
    if (settledEvent.type === 'settled') {
      expect(settledEvent.response).toBe(signed);
    }
    expect(fetchOnce).toHaveBeenCalledTimes(3);
  });

  it('emits timedOut carrying the last pending response when maxAttempts is exhausted', async () => {
    const fetchOnce = vi.fn<() => Promise<X402PayloadResponse>>().mockResolvedValue(pending);
    const events = await drain(runX402Status({ fetchOnce, interval: 0.01, maxAttempts: 2, timeout: 30 }).events);
    expect(events.map((e) => e.type)).toEqual(['snapshot', 'timedOut']);
    const terminal = events.at(-1) as X402StatusEvent;
    if (terminal.type === 'timedOut') {
      expect(terminal.response).toBe(pending);
    }
  });
});
