import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useFlowState } from '../../../src/hooks/use-flow-state.js';

interface ProbeProps {
  action: () => Promise<string>;
  onComplete: (result: string | null) => void;
}

function Probe({ action, onComplete }: ProbeProps): React.ReactElement {
  const { status, data, error } = useFlowState(action, onComplete);
  return <Text>{`status=${status};data=${String(data)};error=${error}`}</Text>;
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

describe('useFlowState', () => {
  it('transitions loading -> success and calls onComplete with the result', async () => {
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(<Probe action={() => Promise.resolve('ok')} onComplete={onComplete} />);
    expect(lastFrame()).toContain('status=loading');
    await vi.waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith('ok');
    });
    expect(lastFrame()).toContain('status=success');
    expect(lastFrame()).toContain('data=ok');
    unmount();
  });

  it('transitions loading -> error and calls onComplete(null)', async () => {
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <Probe action={() => Promise.reject(new Error('boom'))} onComplete={onComplete} />,
    );
    await vi.waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith(null);
    });
    expect(lastFrame()).toContain('status=error');
    expect(lastFrame()).toContain('error=boom');
    unmount();
  });

  it('calls onComplete on a microtask, not synchronously, so the success frame commits first', async () => {
    const onComplete = vi.fn();
    const { unmount } = render(<Probe action={() => Promise.resolve('ok')} onComplete={onComplete} />);
    await vi.waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
    expect(onComplete).toHaveBeenCalledWith('ok');
    unmount();
  });
});
