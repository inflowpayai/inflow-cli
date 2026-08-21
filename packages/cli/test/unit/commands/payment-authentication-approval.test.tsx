import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { AuthenticationApprovalView } from '../../../src/commands/payment-authentication-approval.js';

describe('AuthenticationApprovalView', () => {
  it('keeps waiting and permits a retry when remote cancellation fails', async () => {
    const cancel = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    const view = render(
      <AuthenticationApprovalView
        approval={{
          approvalId: 'approval-1',
          approvalUrl: 'https://app.example/approvals/approval-1/view/',
          cancel,
        }}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    view.stdin.write('\u001b');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Unable to cancel approval'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    view.stdin.write('\u001b');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
    view.unmount();
  });
});
