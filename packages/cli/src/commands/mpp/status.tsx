import { type MppStatusPhase, reduceMppStatus, runMppStatus, TERMINAL_STATES } from '@inflowpayai/inflow-core';
import type { MppTransactionResponse } from '@inflowpayai/mpp';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useReducer } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';

export { TERMINAL_STATES };

export interface MppStatusProps {
  transactionId: string;
  fetchOnce: () => Promise<MppTransactionResponse>;
  interval: number;
  maxAttempts: number;
  timeout: number;
  onComplete: (final: MppStatusPhase) => void;
}

export const MppStatusView: React.FC<MppStatusProps> = ({
  transactionId,
  fetchOnce,
  interval,
  maxAttempts,
  timeout,
  onComplete,
}) => {
  const initial: MppStatusPhase = { kind: 'polling' };
  const [phase, dispatch] = useReducer(reduceMppStatus, initial);
  const { finish } = useFlowExit(onComplete);

  useEffect(() => {
    const run = runMppStatus({ fetchOnce, interval, maxAttempts, timeout });
    let cancelled = false;
    void (async () => {
      for await (const event of run.events) {
        if (cancelled) return;
        dispatch(event);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchOnce, interval, maxAttempts, timeout]);

  useEffect(() => {
    if (
      phase.kind === 'ready' ||
      phase.kind === 'failed' ||
      phase.kind === 'expired' ||
      phase.kind === 'timeout' ||
      phase.kind === 'error'
    ) {
      finish(phase);
    }
  }, [phase, finish]);

  if (phase.kind === 'polling') {
    const stateText = phase.latest?.state ?? 'pending';
    return (
      <Box flexDirection="column">
        <Text color="cyan">
          <Spinner type="dots" /> Polling transaction {transactionId} (state: {stateText})...
        </Text>
      </Box>
    );
  }

  if (phase.kind === 'ready') {
    const credential = phase.response.credential ?? '';
    const preview = credential.length > 32 ? `${credential.slice(0, 32)}...` : credential;
    return (
      <Box flexDirection="column">
        <Text color="green">✓ Ready</Text>
        <Text>{`credential: ${preview}`}</Text>
        {phase.response.expires !== undefined ? <Text dimColor>{`expires: ${phase.response.expires}`}</Text> : null}
      </Box>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Transaction failed</Text>
        {phase.response.problem !== undefined ? (
          <Text color="red">{phase.response.problem.detail ?? phase.response.problem.title}</Text>
        ) : null}
      </Box>
    );
  }

  if (phase.kind === 'expired') {
    return (
      <Box flexDirection="column">
        <Text color="yellow">Transaction expired before it was ready.</Text>
      </Box>
    );
  }

  if (phase.kind === 'timeout') {
    return (
      <Box flexDirection="column">
        <Text color="yellow">Polling timed out before the transaction reached a ready state.</Text>
        {phase.response !== undefined ? <Text>{`last state: ${phase.response.state}`}</Text> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="red">✗ Polling failed</Text>
      <Text color="red">{phase.message}</Text>
    </Box>
  );
};
