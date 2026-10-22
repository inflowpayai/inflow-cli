import type { MppTransactionResponse } from '@inflowpayai/mpp';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MppStatusView } from '../../../../src/commands/mpp/status.js';

function view(fetchOnce: () => Promise<MppTransactionResponse>, interval = 0) {
  return render(
    <MppStatusView
      transactionId="tx-1"
      fetchOnce={fetchOnce}
      interval={interval}
      maxAttempts={0}
      timeout={900}
      onComplete={vi.fn()}
    />,
  );
}

describe('MppStatusView', () => {
  it('ignores a status response that arrives after the view is disposed', async () => {
    let complete: ((response: MppTransactionResponse) => void) | undefined;
    const pending = new Promise<MppTransactionResponse>((resolve) => {
      complete = resolve;
    });
    const fetchOnce = vi.fn(() => pending);
    const onComplete = vi.fn();
    const result = render(
      <MppStatusView
        transactionId="tx-1"
        fetchOnce={fetchOnce}
        interval={0}
        maxAttempts={0}
        timeout={900}
        onComplete={onComplete}
      />,
    );
    await vi.waitFor(() => expect(fetchOnce).toHaveBeenCalledOnce());
    result.unmount();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (complete === undefined) throw new Error('Missing response resolver');
    complete({ transactionId: 'tx-1', state: 'ready', credential: 'private-credential' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onComplete).not.toHaveBeenCalled();
    expect(fetchOnce).toHaveBeenCalledOnce();
    expect(result.frames.join('')).not.toContain('private-credential');
  });

  it('shows the credential expiry without revealing the credential', async () => {
    const result = view(() =>
      Promise.resolve({
        transactionId: 'tx-1',
        state: 'ready',
        credential: 'private-credential',
        expires: '2027-01-01T00:00:00Z',
      }),
    );
    await vi.waitFor(() => expect(result.lastFrame()).toContain('expires: 2027-01-01T00:00:00Z'));
    expect(result.lastFrame()).not.toContain('private-credential');
    result.unmount();
  });

  it('reports failure even when the server supplies no problem detail', async () => {
    const result = view(() => Promise.resolve({ transactionId: 'tx-1', state: 'failed' }));
    await vi.waitFor(() => expect(result.lastFrame()).toContain('Transaction failed'));
    expect(result.lastFrame()).not.toContain('undefined');
    result.unmount();
  });

  it('shows the polling spinner before the first result resolves', async () => {
    const { lastFrame, unmount } = view(() => new Promise<MppTransactionResponse>(() => {}), 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame() ?? '').toContain('Polling transaction tx-1');
    unmount();
  });

  it('stops polling on Escape', async () => {
    const onComplete = vi.fn();
    const pending = vi.fn(() => Promise.resolve({ transactionId: 'tx-1', state: 'pending' as const }));
    const result = render(
      <MppStatusView
        transactionId="tx-1"
        fetchOnce={pending}
        interval={5}
        maxAttempts={0}
        timeout={900}
        onComplete={onComplete}
      />,
    );
    await vi.waitFor(() => expect(result.lastFrame()).toContain('Press Escape to stop waiting'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    result.stdin.write('\u001b');
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith({ kind: 'cancelled' }));
    result.unmount();
  });

  it('renders Ready without credential material', async () => {
    const { lastFrame, unmount } = view(() =>
      Promise.resolve({ transactionId: 'tx-1', state: 'ready', credential: 'c'.repeat(64) }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toContain('Ready');
    expect(lastFrame()).toContain('Payment credential available');
    expect(lastFrame()).not.toContain('cccc');
    unmount();
  });

  it('renders the failed state with the problem detail', async () => {
    const { lastFrame, unmount } = view(() =>
      Promise.resolve({
        transactionId: 'tx-1',
        state: 'failed',
        problem: {
          type: 'https://paymentauth.org/problems/verification-failed',
          title: 'fail',
          status: 402,
          detail: 'declined',
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('failed');
    expect(frame).toContain('declined');
    unmount();
  });

  it('renders the expired state', async () => {
    const { lastFrame, unmount } = view(() => Promise.resolve({ transactionId: 'tx-1', state: 'expired' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toContain('expired before it was ready');
    unmount();
  });

  it('renders the timeout state with the last polled state when max attempts are exhausted', async () => {
    const { lastFrame, unmount } = render(
      <MppStatusView
        transactionId="tx-1"
        fetchOnce={() => Promise.resolve({ transactionId: 'tx-1', state: 'pending', retryAfterSeconds: 0 })}
        interval={0.01}
        maxAttempts={2}
        timeout={900}
        onComplete={vi.fn()}
      />,
    );
    await new Promise((r) => setTimeout(r, 80));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('timed out');
    expect(frame).toContain('last state: pending');
    unmount();
  });

  it('renders the error state when fetchOnce throws', async () => {
    const { lastFrame, unmount } = view(() => Promise.reject(new Error('network down')));
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Polling failed');
    expect(frame).toContain('network down');
    unmount();
  });
});
