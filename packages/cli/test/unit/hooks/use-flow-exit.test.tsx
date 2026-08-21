import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useFlowExit } from '../../../src/hooks/use-flow-exit.js';

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
});
