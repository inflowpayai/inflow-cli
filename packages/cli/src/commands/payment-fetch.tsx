import type {
  MppFetchEvent,
  MppFetchRejected,
  MppFetchSuccess,
  X402FetchEvent,
  X402FetchRejected,
  X402FetchSuccess,
} from '@inflowpayai/inflow-core';
import { Box, Text, useInput, useStdin } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useFlowExit } from '../hooks/use-flow-exit.js';
import { AuthenticationApprovalView, type AuthenticationApprovalDisplay } from './payment-authentication-approval.js';

export type PaymentFetchResult = MppFetchSuccess | MppFetchRejected | X402FetchSuccess | X402FetchRejected;

export type PaymentFetchPhase =
  | { kind: 'waiting' }
  | { kind: 'replaying' }
  | { kind: 'completed'; result: MppFetchSuccess | X402FetchSuccess }
  | { kind: 'rejected'; result: MppFetchRejected | X402FetchRejected }
  | { kind: 'cancelled' }
  | { kind: 'error'; code: string; message: string; retryable?: boolean };

export interface PaymentFetchViewProps {
  protocol: 'MPP' | 'x402';
  transactionId: string;
  url: string;
  method: string;
  paymentHeader: string;
  events: (signal: AbortSignal) => AsyncIterable<MppFetchEvent | X402FetchEvent>;
  onComplete: (final: PaymentFetchPhase) => void;
  authenticationApproval?: AuthenticationApprovalDisplay | undefined;
}

function settlementLine(result: MppFetchSuccess | X402FetchSuccess): string | undefined {
  if (result.settled === undefined) return undefined;
  if (result.protocol === 'mpp')
    return `settled: ${result.settled.status ?? 'success'} (ref ${result.settled.reference ?? '—'})`;
  if (result.settled.transaction !== undefined) return `settled: ${result.settled.transaction}`;
  if (result.settled.network !== undefined) return `settled: ${result.settled.network}`;
  return undefined;
}

function bodyBlock(result: PaymentFetchResult): React.ReactElement | null {
  if (result.body === undefined) return null;
  return (
    <Box marginTop={1} flexDirection="column">
      <Text dimColor>response body:</Text>
      <Text>{result.body}</Text>
    </Box>
  );
}

function savedLine(result: PaymentFetchResult): React.ReactElement | null {
  if (result.outputSavedTo === undefined) return null;
  return (
    <Text>
      {'Saved to: '}
      <Text bold>{result.outputSavedTo}</Text>
    </Text>
  );
}

export const PaymentFetchView: React.FC<PaymentFetchViewProps> = ({
  protocol,
  transactionId,
  url,
  method,
  paymentHeader,
  events,
  onComplete,
  authenticationApproval,
}) => {
  const [phase, setPhase] = useState<PaymentFetchPhase>({ kind: 'waiting' });
  const cancelledRef = useRef(false);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const { finish } = useFlowExit(onComplete);
  const { isRawModeSupported } = useStdin();

  useInput(
    (_input, key) => {
      if (key.escape) {
        cancelledRef.current = true;
        controllerRef.current?.abort();
        finish({ kind: 'cancelled' });
      }
    },
    { isActive: isRawModeSupported === true && authenticationApproval === undefined && phase.kind === 'waiting' },
  );

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    cancelledRef.current = false;
    void (async () => {
      try {
        for await (const event of events(controller.signal)) {
          if (cancelledRef.current) return;
          if (event.type === 'replaying') {
            setPhase({ kind: 'replaying' });
            continue;
          }
          if (event.type === 'replayed') {
            setPhase({ kind: 'completed', result: event.result });
            return;
          }
          if (event.type === 'rejected') {
            setPhase({ kind: 'rejected', result: event.result });
            return;
          }
          if (event.type === 'errored') {
            setPhase({
              kind: 'error',
              code: event.code,
              message: event.message,
              ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
            });
            return;
          }
        }
      } catch (err) {
        if (!cancelledRef.current) {
          setPhase({
            kind: 'error',
            code: 'PAYMENT_FETCH_FAILED',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelledRef.current = true;
      controller.abort();
      controllerRef.current = undefined;
    };
  }, [events]);

  useEffect(() => {
    if (phase.kind !== 'waiting' && phase.kind !== 'replaying') finish(phase);
  }, [phase, finish]);

  if (phase.kind === 'waiting') {
    if (authenticationApproval !== undefined) {
      return <AuthenticationApprovalView approval={authenticationApproval} />;
    }
    return (
      <Box flexDirection="column">
        <Text color="cyan">
          <Spinner type="dots" /> Waiting for {protocol} payment {transactionId}...
        </Text>
        <Text dimColor>Press Escape to stop waiting.</Text>
      </Box>
    );
  }

  if (phase.kind === 'replaying') {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" /> Fetching {method} {url} with {paymentHeader}...
        </Text>
      </Box>
    );
  }

  if (phase.kind === 'cancelled') return <Text dimColor>Stopped waiting for payment.</Text>;

  if (phase.kind === 'completed') {
    const { result } = phase;
    const settled = settlementLine(result);
    return (
      <Box flexDirection="column">
        <Text color="green">✓ Paid and fetched seller resource</Text>
        <Text>{`transaction: ${result.transactionId}`}</Text>
        <Text>{`status: ${String(result.responseStatus)}`}</Text>
        {result.responseContentType !== undefined ? <Text>{`content type: ${result.responseContentType}`}</Text> : null}
        {settled !== undefined ? <Text>{settled}</Text> : null}
        <Text>{`response size: ${String(result.bodySizeBytes)} bytes`}</Text>
        {savedLine(result)}
        {bodyBlock(result)}
      </Box>
    );
  }

  if (phase.kind === 'rejected') {
    const { result } = phase;
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Seller rejected the payment replay</Text>
        <Text>{`transaction: ${result.transactionId}`}</Text>
        <Text>{`status: ${String(result.responseStatus)}`}</Text>
        {result.responseContentType !== undefined ? <Text>{`content type: ${result.responseContentType}`}</Text> : null}
        <Text>{`response size: ${String(result.bodySizeBytes)} bytes`}</Text>
        {savedLine(result)}
        {bodyBlock(result)}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="red">✗ {phase.code}</Text>
      <Text color="red">{phase.message}</Text>
    </Box>
  );
};
