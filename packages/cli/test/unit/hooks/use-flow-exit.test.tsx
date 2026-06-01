import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFlowExit } from '../../../src/hooks/use-flow-exit.js';
import { CANCEL_GRACE_MS } from '../../../src/utils/best-effort-cancel.js';

afterEach(() => vi.useRealTimers());

// Drives the hook from inside a real Ink render so `useApp().exit()` is wired the same way it is in production.
const Harness: React.FC<{
  onComplete: (label: string) => void;
  run: (api: ReturnType<typeof useFlowExit<[string]>>) => void;
}> = ({ onComplete, run }) => {
  const api = useFlowExit(onComplete);
  useEffect(() => run(api), [api, run]);
  return <Text>running</Text>;
};

describe('useFlowExit', () => {
  it('finish runs onComplete with its args', async () => {
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} run={({ finish }) => finish('done')} />);
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith('done'));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('finish is idempotent — a re-fired terminal effect cannot double-complete', async () => {
    const onComplete = vi.fn();
    render(
      <Harness
        onComplete={onComplete}
        run={({ finish }) => {
          finish('first');
          finish('second');
        }}
      />,
    );
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('first');
  });

  it('cancelThenFinish fires the cancel and then finishes', async () => {
    const onComplete = vi.fn();
    const cancel = vi.fn(() => Promise.resolve());
    render(<Harness onComplete={onComplete} run={({ cancelThenFinish }) => cancelThenFinish(cancel, 'cancelled')} />);
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith('cancelled'));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancelThenFinish still finishes within the grace window when the cancel never settles', async () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    // Cancel that never resolves — finish must still run once the grace timer elapses.
    render(
      <Harness
        onComplete={onComplete}
        run={({ cancelThenFinish }) => cancelThenFinish(() => new Promise<void>(() => undefined), 'cancelled')}
      />,
    );
    await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS - 1);
    expect(onComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(onComplete).toHaveBeenCalledWith('cancelled');
  });
});
