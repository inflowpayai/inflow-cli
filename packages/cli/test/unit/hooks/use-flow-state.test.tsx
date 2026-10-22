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

describe('useFlowState', () => {
  it.each(['resolve', 'reject'] as const)('ignores a late %s after unmount', async (outcome) => {
    let settle: () => void = () => {
      throw new Error('Action not started');
    };
    const action = vi.fn(
      () =>
        new Promise<string>((resolve, reject) => {
          settle = () => (outcome === 'resolve' ? resolve('late') : reject(new Error('late failure')));
        }),
    );
    const onComplete = vi.fn();
    const view = render(<Probe action={action} onComplete={onComplete} />);
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    view.unmount();
    await new Promise((resolve) => setImmediate(resolve));
    settle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('reports a non-Error rejection without losing completion', async () => {
    const onComplete = vi.fn();
    const action = vi.fn<() => Promise<string>>().mockRejectedValue('offline');
    const view = render(<Probe action={action} onComplete={onComplete} />);
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith(null));
    expect(view.lastFrame()).toContain('error=offline');
    expect(onComplete).toHaveBeenCalledOnce();
    view.unmount();
  });

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
