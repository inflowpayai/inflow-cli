import {
  buildBodyAttachment,
  buildSettlement,
  isSuccessStatus,
  mapMppError,
  type MppPayCreated,
  type MppPayEvent,
  type MppPayPhase,
  type MppPayPipelineDeps,
  type MppPayResultNoPayment,
  type MppPayResultRejected,
  type MppPayResultSuccess,
  type MppPaySettlement,
  MPP_INVALID_402_CODE,
  MPP_NO_FILTERED_MATCH_CODE,
  MPP_NO_INFLOW_MATCH_CODE,
  MPP_PAYMENT_NOT_ACCEPTED_CODE,
  MPP_UNEXPECTED_PROBE_STATUS_CODE,
  reduceMppPay,
  runMppPayPipeline,
} from '@inflowpayai/inflow-core';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useReducer, useState } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';
import { openUrl } from '../../utils/open-url.js';

export {
  buildBodyAttachment,
  buildSettlement,
  isSuccessStatus,
  mapMppError,
  type MppPayCreated,
  type MppPayEvent,
  type MppPayPhase,
  type MppPayPipelineDeps,
  type MppPayResultNoPayment,
  type MppPayResultRejected,
  type MppPayResultSuccess,
  type MppPaySettlement,
  MPP_INVALID_402_CODE,
  MPP_NO_FILTERED_MATCH_CODE,
  MPP_NO_INFLOW_MATCH_CODE,
  MPP_PAYMENT_NOT_ACCEPTED_CODE,
  MPP_UNEXPECTED_PROBE_STATUS_CODE,
  runMppPayPipeline,
};

export interface PayViewProps {
  url: string;
  method: string;
  deps: MppPayPipelineDeps;
  onComplete: (final: MppPayPhase) => void;
  /** Best-effort cancel of the pending approval when the user presses Escape. */
  onCancel?: (approvalId: string) => Promise<unknown> | void;
}

export const PayView: React.FC<PayViewProps> = ({ url, method, deps, onComplete, onCancel }) => {
  const initial: MppPayPhase = { kind: 'probing' };
  const [phase, dispatch] = useReducer(reduceMppPay, initial);
  const [cancelling, setCancelling] = useState(false);
  const { finish, cancelThenFinish } = useFlowExit(onComplete);

  const created = phase.kind === 'created' ? phase.created : undefined;
  const approvalUrl = created?.approvalUrl;
  const approvalId = created?.approvalId;
  useInput(
    (_input, key) => {
      if (approvalUrl === undefined) return;
      if (key.return) {
        openUrl(approvalUrl);
        return;
      }
      if (key.escape && approvalId !== undefined) {
        setCancelling(true);
        cancelThenFinish(() => onCancel?.(approvalId), {
          kind: 'error',
          code: 'APPROVAL_CANCELLED',
          message: `Approval ${approvalId} cancelled.`,
        });
      }
    },
    { isActive: approvalUrl !== undefined && !cancelling },
  );

  useEffect(() => {
    // Abort the inline `pending → ready` poll when the view tears down (Escape/unmount) so the process can exit
    // promptly instead of waiting out the poll deadline.
    const controller = new AbortController();
    let cancelled = false;
    const runDeps: MppPayPipelineDeps = { ...deps, signal: controller.signal };
    void runMppPayPipeline(runDeps, (event: MppPayEvent) => {
      if (!cancelled) dispatch(event);
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [deps]);

  useEffect(() => {
    if (
      phase.kind === 'success' ||
      phase.kind === 'seller-rejected' ||
      phase.kind === 'no-payment-final' ||
      phase.kind === 'error'
    ) {
      finish(phase);
    }
  }, [phase, finish]);

  if (cancelling) {
    return (
      <Box>
        <Text color="yellow">
          <Spinner type="dots" /> Cancelling approval...
        </Text>
      </Box>
    );
  }

  if (phase.kind === 'probing') {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" /> Probing {method} {url}...
        </Text>
      </Box>
    );
  }

  if (phase.kind === 'no-payment') {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" /> Seller accepted without payment (status {String(phase.probe.status)}); finalising...
        </Text>
      </Box>
    );
  }

  if (phase.kind === 'decoded') {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" /> Fulfilling {phase.challenge.amount ?? ''} {phase.challenge.currency ?? ''}{' '}
          challenge...
        </Text>
      </Box>
    );
  }

  if (phase.kind === 'created') {
    const { created } = phase;
    if (created.state !== 'pending') {
      return (
        <Box>
          <Text color="cyan">
            <Spinner type="dots" /> Transaction {created.transactionId} ready; replaying...
          </Text>
        </Box>
      );
    }
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold>Approval required</Text>
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
          <Text>{`transaction: ${created.transactionId}`}</Text>
          {created.approvalUrl !== undefined ? (
            <>
              <Text>
                {'Open: '}
                <Text bold color="cyan">
                  {created.approvalUrl}
                </Text>
              </Text>
              <Text dimColor>Press Enter to open in browser.</Text>
              <Text dimColor>Press Escape to cancel.</Text>
            </>
          ) : null}
        </Box>
        <Box marginTop={1}>
          <Text color="cyan">
            <Spinner type="dots" /> Waiting for approval...
          </Text>
        </Box>
      </Box>
    );
  }

  if (phase.kind === 'replaying') {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" /> Replaying request with Authorization: Payment...
        </Text>
      </Box>
    );
  }

  if (phase.kind === 'success') {
    const { result } = phase;
    return (
      <Box flexDirection="column">
        <Text color="green">✓ Paid (intent {result.intent})</Text>
        <Text>{`status: ${String(result.responseStatus)}`}</Text>
        <Text>{`transaction: ${result.transactionId}`}</Text>
        {result.settled !== undefined ? (
          <Text>{`settled: ${result.settled.amount ?? '?'} ${result.settled.currency ?? ''} (ref ${result.settled.reference ?? '—'})`}</Text>
        ) : null}
        <Text>{`response size: ${String(result.bodySizeBytes)} bytes`}</Text>
        {result.outputSavedTo !== undefined ? (
          <Text>
            {'Saved to: '}
            <Text bold>{result.outputSavedTo}</Text>
          </Text>
        ) : null}
        {result.body !== undefined ? (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>response body:</Text>
            <Text>{result.body}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (phase.kind === 'seller-rejected') {
    const { result } = phase;
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Payment not accepted by seller</Text>
        <Text>{`status: ${String(result.responseStatus)}`}</Text>
        <Text>{`transaction: ${result.transactionId}`}</Text>
        <Text>{`response size: ${String(result.bodySizeBytes)} bytes`}</Text>
        {result.body !== undefined ? (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>response body:</Text>
            <Text>{result.body}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (phase.kind === 'no-payment-final') {
    const { result } = phase;
    return (
      <Box flexDirection="column">
        <Text color="green">✓ Seller accepted without payment</Text>
        <Text>{`status: ${String(result.status)}`}</Text>
        <Text>{`response size: ${String(result.bodySizeBytes)} bytes`}</Text>
        {result.outputSavedTo !== undefined ? (
          <Text>
            {'Saved to: '}
            <Text bold>{result.outputSavedTo}</Text>
          </Text>
        ) : null}
        {result.body !== undefined ? (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>response body:</Text>
            <Text>{result.body}</Text>
          </Box>
        ) : null}
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
