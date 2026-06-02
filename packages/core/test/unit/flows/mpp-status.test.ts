import type { MppTransactionResponse } from '@inflowpayai/mpp';
import { describe, expect, it, vi } from 'vitest';
import { classifyTransaction, reduceMppStatus, runMppStatus, TERMINAL_STATES } from '../../../src/flows/mpp-status.js';

function tx(
  partial: Partial<MppTransactionResponse> & { state: MppTransactionResponse['state'] },
): MppTransactionResponse {
  return { transactionId: 'tx-1', ...partial };
}

async function drain<E>(iterable: AsyncIterable<E>): Promise<E[]> {
  const out: E[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe('classifyTransaction / TERMINAL_STATES', () => {
  it('returns the server state verbatim', () => {
    expect(classifyTransaction(tx({ state: 'ready' }))).toBe('ready');
    expect(classifyTransaction(tx({ state: 'pending' }))).toBe('pending');
  });

  it('treats every non-pending state as terminal', () => {
    expect(TERMINAL_STATES.has('ready')).toBe(true);
    expect(TERMINAL_STATES.has('failed')).toBe(true);
    expect(TERMINAL_STATES.has('expired')).toBe(true);
    expect(TERMINAL_STATES.has('pending')).toBe(false);
  });
});

describe('reduceMppStatus', () => {
  it('snapshot updates the latest poll value', () => {
    const next = reduceMppStatus({ kind: 'polling' }, { type: 'snapshot', response: tx({ state: 'pending' }) });
    expect(next).toEqual({ kind: 'polling', latest: tx({ state: 'pending' }) });
  });

  it('ready transitions to ready', () => {
    const next = reduceMppStatus({ kind: 'polling' }, { type: 'ready', response: tx({ state: 'ready' }) });
    expect(next.kind).toBe('ready');
  });

  it('failed transitions to failed and carries the response', () => {
    const next = reduceMppStatus({ kind: 'polling' }, { type: 'failed', response: tx({ state: 'failed' }) });
    expect(next).toEqual({ kind: 'failed', response: tx({ state: 'failed' }) });
  });

  it('expired transitions to expired and carries the response', () => {
    const next = reduceMppStatus({ kind: 'polling' }, { type: 'expired', response: tx({ state: 'expired' }) });
    expect(next).toEqual({ kind: 'expired', response: tx({ state: 'expired' }) });
  });

  it('timedOut without response yields a bare timeout', () => {
    expect(reduceMppStatus({ kind: 'polling' }, { type: 'timedOut' })).toEqual({ kind: 'timeout' });
  });

  it('timedOut with a response carries the last snapshot into the timeout frame', () => {
    const next = reduceMppStatus({ kind: 'polling' }, { type: 'timedOut', response: tx({ state: 'pending' }) });
    expect(next).toEqual({ kind: 'timeout', response: tx({ state: 'pending' }) });
  });

  it('returns the prior state for an unrecognised event (default branch)', () => {
    const prior = { kind: 'polling' } as const;
    expect(reduceMppStatus(prior, { type: 'bogus' } as never)).toBe(prior);
  });

  it('crashed surfaces the message', () => {
    expect(reduceMppStatus({ kind: 'polling' }, { type: 'crashed', message: 'boom' })).toEqual({
      kind: 'error',
      message: 'boom',
    });
  });
});

describe('runMppStatus', () => {
  it('emits ready when a ready transaction arrives', async () => {
    const fetchOnce = vi.fn().mockResolvedValue(tx({ state: 'ready', credential: 'cred-b64' }));
    const events = await drain(runMppStatus({ fetchOnce, interval: 0.01, maxAttempts: 5, timeout: 30 }).events);
    expect(events.at(-1)).toEqual({ type: 'ready', response: tx({ state: 'ready', credential: 'cred-b64' }) });
  });

  it('emits failed when the transaction fails', async () => {
    const fetchOnce = vi.fn().mockResolvedValue(tx({ state: 'failed' }));
    const events = await drain(runMppStatus({ fetchOnce, interval: 0.01, maxAttempts: 5, timeout: 30 }).events);
    expect(events.at(-1)?.type).toBe('failed');
  });

  it('emits expired when the transaction expires', async () => {
    const fetchOnce = vi.fn().mockResolvedValue(tx({ state: 'expired' }));
    const events = await drain(runMppStatus({ fetchOnce, interval: 0.01, maxAttempts: 5, timeout: 30 }).events);
    expect(events.at(-1)?.type).toBe('expired');
  });

  it('emits a snapshot then ready across a pending → ready transition', async () => {
    const fetchOnce = vi
      .fn()
      .mockResolvedValueOnce(tx({ state: 'pending', retryAfterSeconds: 0 }))
      .mockResolvedValue(tx({ state: 'ready', credential: 'cred-b64' }));
    const events = await drain(runMppStatus({ fetchOnce, interval: 0.01, maxAttempts: 5, timeout: 30 }).events);
    expect(events.map((e) => e.type)).toEqual(['snapshot', 'ready']);
  });

  it('emits crashed when fetchOnce throws', async () => {
    const fetchOnce = vi.fn().mockRejectedValue(new Error('boom'));
    const events = await drain(runMppStatus({ fetchOnce, interval: 0.01, maxAttempts: 5, timeout: 30 }).events);
    expect(events.at(-1)).toEqual({ type: 'crashed', message: 'boom' });
  });

  it('emits timedOut with the last response when the poll exhausts max attempts on a stuck pending', async () => {
    const fetchOnce = vi.fn().mockResolvedValue(tx({ state: 'pending', retryAfterSeconds: 0 }));
    const events = await drain(runMppStatus({ fetchOnce, interval: 0.01, maxAttempts: 2, timeout: 30 }).events);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('timedOut');
    if (terminal?.type === 'timedOut')
      expect(terminal.response).toEqual(tx({ state: 'pending', retryAfterSeconds: 0 }));
  });

  it('stringifies a non-Error rejection in the crashed message', async () => {
    const fetchOnce = vi.fn().mockRejectedValue('plain-string-failure');
    const events = await drain(runMppStatus({ fetchOnce, interval: 0.01, maxAttempts: 5, timeout: 30 }).events);
    expect(events.at(-1)).toEqual({ type: 'crashed', message: 'plain-string-failure' });
  });
});
