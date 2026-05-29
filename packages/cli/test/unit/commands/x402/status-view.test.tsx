import type { X402PayloadResponse } from '@inflowpayai/x402-buyer';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { X402StatusView } from '../../../../src/commands/x402/status.js';

const longPayload = 'a'.repeat(64);

function signedResponse(): X402PayloadResponse {
  return {
    status: 'APPROVED',
    encodedPayload: longPayload,
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
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('X402StatusView', () => {
  it('renders the polling spinner with the txn id and initial status', async () => {
    const fetchOnce = vi.fn(
      () =>
        new Promise<X402PayloadResponse>(() => {
          /* never resolves */
        }),
    );
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <X402StatusView
        transactionId="txn_abc"
        fetchOnce={fetchOnce}
        interval={5}
        maxAttempts={0}
        timeout={900}
        onComplete={onComplete}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('Polling transaction txn_abc');
    expect(lastFrame()).toContain('pending');
    unmount();
  });

  it('transitions to "Signed" once fetchOnce returns an encoded payload, truncating long previews', async () => {
    const fetchOnce = vi.fn(() => Promise.resolve(signedResponse()));
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <X402StatusView
        transactionId="txn_abc"
        fetchOnce={fetchOnce}
        interval={5}
        maxAttempts={0}
        timeout={900}
        onComplete={onComplete}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Signed');
    });
    expect(lastFrame()).toContain('status: APPROVED');
    expect(lastFrame()).toContain(`${longPayload.slice(0, 32)}...`);
    unmount();
  });

  it('renders the failed terminal frame on DECLINED', async () => {
    const fetchOnce = vi.fn(() => Promise.resolve({ status: 'DECLINED' } as X402PayloadResponse));
    const { lastFrame, unmount } = render(
      <X402StatusView
        transactionId="txn_x"
        fetchOnce={fetchOnce}
        interval={5}
        maxAttempts={0}
        timeout={900}
        onComplete={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Approval did not settle');
    });
    expect(lastFrame()).toContain('status: DECLINED');
    unmount();
  });

  it('renders the timeout frame when interval is positive but maxAttempts=1 forces a max_attempts exit', async () => {
    let calls = 0;
    const fetchOnce = vi.fn(() => {
      calls += 1;
      return Promise.resolve({ status: 'PROCESSING' } as X402PayloadResponse);
    });
    const { lastFrame, unmount } = render(
      <X402StatusView
        transactionId="txn_to"
        fetchOnce={fetchOnce}
        interval={0.01}
        maxAttempts={1}
        timeout={900}
        onComplete={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Polling timed out');
    });
    expect(lastFrame()).toContain('last status: PROCESSING');
    expect(calls).toBeGreaterThanOrEqual(1);
    unmount();
  });

  it('renders the error frame when fetchOnce throws', async () => {
    const fetchOnce = vi.fn(() => Promise.reject(new Error('boom')));
    const { lastFrame, unmount } = render(
      <X402StatusView
        transactionId="txn_e"
        fetchOnce={fetchOnce}
        interval={5}
        maxAttempts={0}
        timeout={900}
        onComplete={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Polling failed');
    });
    expect(lastFrame()).toContain('boom');
    unmount();
  });

  it('renders the error frame with a string fallback when fetchOnce throws a non-Error', async () => {
    const fetchOnce = vi.fn(() => Promise.reject('bare-string-failure'));
    const { lastFrame, unmount } = render(
      <X402StatusView
        transactionId="txn_e2"
        fetchOnce={fetchOnce}
        interval={5}
        maxAttempts={0}
        timeout={900}
        onComplete={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Polling failed');
    });
    expect(lastFrame()).toContain('bare-string-failure');
    unmount();
  });

  it('calls onComplete once after the terminal linger', async () => {
    vi.useFakeTimers();
    const fetchOnce = vi.fn(() => Promise.resolve(signedResponse()));
    const onComplete = vi.fn();
    const { unmount } = render(
      <X402StatusView
        transactionId="txn_done"
        fetchOnce={fetchOnce}
        interval={5}
        maxAttempts={0}
        timeout={900}
        onComplete={onComplete}
      />,
    );
    await vi.runAllTimersAsync();
    expect(onComplete).toHaveBeenCalled();
    const arg = onComplete.mock.calls[0]?.[0] as { kind: string };
    expect(arg.kind).toBe('signed');
    unmount();
  });

  it('updates the latest snapshot in the polling phase as new statuses arrive', async () => {
    const responses: X402PayloadResponse[] = [{ status: 'INITIATED' }, { status: 'PROCESSING' }, signedResponse()];
    const fetchOnce = vi.fn(() => Promise.resolve(responses.shift() ?? signedResponse()));
    const { lastFrame, unmount } = render(
      <X402StatusView
        transactionId="txn_poll"
        fetchOnce={fetchOnce}
        interval={0.01}
        maxAttempts={0}
        timeout={900}
        onComplete={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Signed');
    });
    unmount();
  });
});
