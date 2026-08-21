import { type MppStatusPhase, reduceMppStatus, runMppStatus, TERMINAL_STATES } from '@inflowpayai/inflow-core';
import type { MppTransactionResponse } from '@inflowpayai/mpp';
import { Box, Text, useInput, useStdin } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useReducer, useRef } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';

export { TERMINAL_STATES };

export type MppStatusViewPhase = MppStatusPhase | { kind: 'cancelled' };

export interface MppStatusProps {
  transactionId: string;
  fetchOnce: () => Promise<MppTransactionResponse>;
  interval: number;
  maxAttempts: number;
  timeout: number;
  onComplete: (final: MppStatusViewPhase) => void;
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
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const { finish } = useFlowExit(onComplete);
  const { isRawModeSupported } = useStdin();

  useInput(
    (_input, key) => {
      if (key.escape) {
        controllerRef.current?.abort();
        finish({ kind: 'cancelled' });
      }
    },
    { isActive: isRawModeSupported === true && phase.kind === 'polling' },
  );

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    const run = runMppStatus({ fetchOnce, interval, maxAttempts, timeout, signal: controller.signal });
    const state = { cancelled: false };
    void (async () => {
      for await (const event of run.events) {
        if (state.cancelled) return;
        dispatch(event);
      }
    })();
    return () => {
      state.cancelled = true;
      controller.abort();
      controllerRef.current = undefined;
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
        <Text dimColor>Press Escape to stop waiting.</Text>
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
        {phase.response.problem !== undefined ? <Text color="red">{phase.response.problem.detail}</Text> : null}
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
