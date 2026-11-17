import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useCallback } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';
import { useFlowState } from '../../hooks/use-flow-state.js';

export interface CancelViewProps {
  approvalId: string;
  cancel: () => Promise<void>;
  onComplete: (cancelled: boolean) => void;
}

export const CancelView: React.FC<CancelViewProps> = ({ approvalId, cancel, onComplete }) => {
  const action = useCallback(async () => {
    await cancel();
    return true;
  }, [cancel]);
  const { finish } = useFlowExit(onComplete);
  const { status, error } = useFlowState(action, (result) => finish(result === true));

  if (status === 'loading') {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" /> Cancelling approval {approvalId}...
        </Text>
      </Box>
    );
  }

  if (status === 'error') return <Text color="red">Unable to cancel approval: {error}</Text>;

  return (
    <Box>
      <Text color="green">Cancelled approval {approvalId}.</Text>
    </Box>
  );
};
