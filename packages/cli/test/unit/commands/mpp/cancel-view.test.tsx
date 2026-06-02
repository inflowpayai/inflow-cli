import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CancelView } from '../../../../src/commands/mpp/cancel.js';

describe('CancelView', () => {
  it('shows the cancelling spinner then the cancelled confirmation', async () => {
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <CancelView approvalId="ap-9" cancel={async () => undefined} onComplete={onComplete} />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toContain('ap-9');
    expect(lastFrame() ?? '').toContain('Cancelled');
    unmount();
  });
});
