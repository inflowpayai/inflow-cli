import { render } from 'ink-testing-library';
import { Text, useInput } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthenticationApprovalView,
  useAuthenticationApprovalDisplay,
} from '../../../src/commands/payment-authentication-approval.js';

function DisplayProbe({ cancel }: { cancel: () => Promise<void> }) {
  const { approvalDisplay, authenticationApproval } = useAuthenticationApprovalDisplay();
  useInput((input) => {
    if (input === 's')
      approvalDisplay.showPendingApproval({
        approvalId: 'approval-1',
        approvalUrl: 'https://app.example/approval',
        cancel,
      });
    if (input === 'c') approvalDisplay.clearPendingApproval();
  });
  return authenticationApproval === undefined ? (
    <Text>Payment progress</Text>
  ) : (
    <AuthenticationApprovalView approval={authenticationApproval} />
  );
}

describe('AuthenticationApprovalView', () => {
  it('shows and clears authentication approval without invoking payment cancellation', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const view = render(<DisplayProbe cancel={cancel} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(view.lastFrame()).toContain('Payment progress');
    view.stdin.write('s');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Authentication approval required'));
    view.stdin.write('c');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Payment progress'));
    expect(cancel).not.toHaveBeenCalled();
    view.unmount();
  });

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
