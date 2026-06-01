import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useCallback } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';
import { useFlowState } from '../../hooks/use-flow-state.js';

export interface CancelViewProps {
  approvalId: string;
  cancel: () => Promise<void>;
  onComplete: () => void;
}

export const CancelView: React.FC<CancelViewProps> = ({ approvalId, cancel, onComplete }) => {
  const action = useCallback(() => cancel(), [cancel]);
  const { finish } = useFlowExit(onComplete);
  const { status } = useFlowState(action, finish);

  if (status === 'loading') {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" /> Cancelling approval {approvalId}...
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color="green">✓ Cancelled approval {approvalId} (best-effort)</Text>
    </Box>
  );
};
