import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useMemo, useState } from 'react';
import { openUrl } from '../utils/open-url.js';

export interface AuthenticationApprovalDisplay {
  approvalId: string;
  approvalUrl: string;
  cancel: () => Promise<void> | void;
}

export interface AuthenticationApprovalController {
  clearPendingApproval(): void;
  showPendingApproval(approval: AuthenticationApprovalDisplay): boolean;
}

export function useAuthenticationApprovalDisplay(): {
  approvalDisplay: AuthenticationApprovalController;
  authenticationApproval: AuthenticationApprovalDisplay | undefined;
} {
  const [authenticationApproval, setAuthenticationApproval] = useState<AuthenticationApprovalDisplay | undefined>();
  const approvalDisplay = useMemo<AuthenticationApprovalController>(
    () => ({
      clearPendingApproval: () => setAuthenticationApproval(undefined),
      showPendingApproval: (approval) => {
        setAuthenticationApproval(approval);
        return true;
      },
    }),
    [],
  );
  return { approvalDisplay, authenticationApproval };
}

interface AuthenticationApprovalViewProps {
  approval: AuthenticationApprovalDisplay;
}

export const AuthenticationApprovalView: React.FC<AuthenticationApprovalViewProps> = ({ approval }) => {
  const [cancelling, setCancelling] = useState(false);
  const [cancellationFailed, setCancellationFailed] = useState(false);
  useInput(
    (_input, key) => {
      if (key.return) {
        openUrl(approval.approvalUrl);
        return;
      }
      if (key.escape) {
        setCancelling(true);
        setCancellationFailed(false);
        void Promise.resolve(approval.cancel()).catch(() => {
          setCancelling(false);
          setCancellationFailed(true);
        });
      }
    },
    { isActive: !cancelling },
  );

  if (cancelling) {
    return (
      <Text color="yellow">
        <Spinner type="dots" /> Cancelling authentication approval...
      </Text>
    );
  }

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Text bold>Authentication approval required</Text>
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
        <Text>{`approval: ${approval.approvalId}`}</Text>
        <Text>
          {'Open: '}
          <Text bold color="cyan">
            {approval.approvalUrl}
          </Text>
        </Text>
        <Text dimColor>Press Enter to open in browser.</Text>
        <Text dimColor>Press Escape to cancel.</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="cyan">
          <Spinner type="dots" /> Waiting for authentication approval...
        </Text>
      </Box>
      {cancellationFailed && <Text color="red">Unable to cancel approval. Press Escape to retry.</Text>}
    </Box>
  );
};
