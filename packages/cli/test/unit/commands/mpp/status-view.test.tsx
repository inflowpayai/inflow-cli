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
  it('shows the polling spinner before the first result resolves', async () => {
    const { lastFrame, unmount } = view(() => new Promise<MppTransactionResponse>(() => {}), 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame() ?? '').toContain('Polling transaction tx-1');
    unmount();
  });

  it('renders Ready with a truncated credential preview', async () => {
    const { lastFrame, unmount } = view(() =>
      Promise.resolve({ transactionId: 'tx-1', state: 'ready', credential: 'c'.repeat(64) }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toContain('Ready');
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
