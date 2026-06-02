import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANCEL_GRACE_MS, runBestEffortCancel } from '../../../src/utils/best-effort-cancel.js';

describe('runBestEffortCancel', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs done once after the cancel resolves (fast path)', async () => {
    const done = vi.fn();
    const cancel = vi.fn(() => Promise.resolve());
    runBestEffortCancel(cancel, done);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('runs done after the grace window even if the cancel has not settled (slow-endpoint path)', async () => {
    const done = vi.fn();
    // Cancel that has not settled yet — mimics a cancel POST stalling toward the SDK's 30s request timeout.
    runBestEffortCancel(() => new Promise<void>(() => undefined), done);
    await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS - 1);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('only runs done once even when the cancel later settles after the timeout', async () => {
    const done = vi.fn();
    let resolveCancel: (() => void) | undefined;
    runBestEffortCancel(() => new Promise<void>((r) => (resolveCancel = r)), done);
    await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS);
    expect(done).toHaveBeenCalledTimes(1);
    resolveCancel?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected cancel and still runs done', async () => {
    const done = vi.fn();
    runBestEffortCancel(() => Promise.reject(new Error('network down')), done);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('runs done when no cancel callback is provided', async () => {
    const done = vi.fn();
    runBestEffortCancel(undefined, done);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
