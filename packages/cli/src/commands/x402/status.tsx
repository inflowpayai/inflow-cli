import {
  classifyPayloadResponse,
  reduceX402Status,
  runX402Status,
  TERMINAL_FAILURE_STATUSES,
  type X402StatusPhase,
} from '@inflowpayai/inflow-core';
import type { X402PayloadResponse } from '@inflowpayai/x402-buyer';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useReducer } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';

export { classifyPayloadResponse, TERMINAL_FAILURE_STATUSES };

export interface X402StatusProps {
  transactionId: string;
  fetchOnce: () => Promise<X402PayloadResponse>;
  interval: number;
  maxAttempts: number;
  timeout: number;
  onComplete: (final: X402StatusPhase) => void;
}

export const X402StatusView: React.FC<X402StatusProps> = ({
  transactionId,
  fetchOnce,
  interval,
  maxAttempts,
  timeout,
  onComplete,
}) => {
  const initial: X402StatusPhase = { kind: 'polling' };
  const [phase, dispatch] = useReducer(reduceX402Status, initial);
  const { finish } = useFlowExit(onComplete);

  useEffect(() => {
    const run = runX402Status({ fetchOnce, interval, maxAttempts, timeout });
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
    if (phase.kind === 'signed' || phase.kind === 'failed' || phase.kind === 'timeout' || phase.kind === 'error') {
      finish(phase);
    }
  }, [phase, finish]);

  if (phase.kind === 'polling') {
    const statusText = phase.latest?.status ?? 'pending';
    return (
      <Box flexDirection="column">
        <Text color="cyan">
          <Spinner type="dots" /> Polling transaction {transactionId} (status: {statusText})...
        </Text>
      </Box>
    );
  }

  if (phase.kind === 'signed') {
    const encoded = phase.response.encodedPayload ?? '';
    const preview = encoded.length > 32 ? `${encoded.slice(0, 32)}...` : encoded;
    return (
      <Box flexDirection="column">
        <Text color="green">✓ Signed</Text>
        <Text>{`status: ${phase.response.status}`}</Text>
        <Text>{`encodedPayload: ${preview}`}</Text>
      </Box>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Approval did not settle</Text>
        <Text color="red">{`status: ${phase.response.status}`}</Text>
      </Box>
    );
  }

  if (phase.kind === 'timeout') {
    return (
      <Box flexDirection="column">
        <Text color="yellow">Polling timed out before the transaction reached a signed state.</Text>
        {phase.response !== undefined ? <Text>{`last status: ${phase.response.status}`}</Text> : null}
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
