import { Text, useApp } from 'ink';
import React, { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { renderInkUntilExit } from '../../../src/utils/render-ink-until-exit.js';

interface SelfExitProps {
  onMount: () => void;
}

function SelfExit({ onMount }: SelfExitProps): React.ReactElement {
  const { exit } = useApp();
  useEffect(() => {
    onMount();
    queueMicrotask(() => {
      exit();
    });
  }, [exit, onMount]);
  return <Text>x</Text>;
}

describe('renderInkUntilExit', () => {
  it('resolves void after the Ink component exits', async () => {
    let mounted = false;
    await renderInkUntilExit(<SelfExit onMount={() => (mounted = true)} />);
    expect(mounted).toBe(true);
  });

  it('returns the getResult() value when provided', async () => {
    let captured: string | null = null;
    const result = await renderInkUntilExit(
      <SelfExit onMount={() => (captured = 'done')} />,
      () => captured ?? 'unset',
    );
    expect(result).toBe('done');
  });
});
