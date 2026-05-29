import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CancelView } from '../../../../src/commands/x402/cancel.js';

describe('CancelView', () => {
  it('renders a best-effort confirmation after cancel resolves', async () => {
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <CancelView approvalId="appr_123" cancel={() => Promise.resolve()} onComplete={onComplete} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Cancelled approval appr_123');
    expect(frame).toContain('best-effort');
    unmount();
  });

  it('still surfaces the confirmation when the underlying cancel rejects (fire-and-forget)', async () => {
    const onComplete = vi.fn();
    const cancel = vi.fn(() => Promise.reject(new Error('server 500')));
    const { lastFrame, unmount } = render(<CancelView approvalId="appr_500" cancel={cancel} onComplete={onComplete} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cancel).toHaveBeenCalledTimes(1);
    unmount();
  });
});
