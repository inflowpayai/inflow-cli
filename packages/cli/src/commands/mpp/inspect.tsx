import {
  type DecodedChallenge,
  type MppInspectPhase,
  type MppInspectPipelineDeps,
  type MppInspectResultChallenges,
  type MppInspectResultNoPayment,
  reduceMppInspect,
  runMppInspectPipeline,
} from '@inflowpayai/inflow-core';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useReducer } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';
import { Table, type TableColumn } from '../../utils/table.js';

export {
  type MppInspectPhase,
  type MppInspectPipelineDeps,
  type MppInspectResultChallenges,
  type MppInspectResultNoPayment,
  reduceMppInspect,
  runMppInspectPipeline,
};

function orDash(value: string | undefined): string {
  return value === undefined || value === '' ? '—' : value;
}

const COLUMNS: ReadonlyArray<TableColumn<DecodedChallenge>> = [
  { header: 'Method', cell: (c) => c.method },
  { header: 'Intent', cell: (c) => c.intent },
  { header: 'Amount', cell: (c) => orDash(c.amount) },
  { header: 'Currency', cell: (c) => orDash(c.currency) },
  { header: 'Rail', cell: (c) => orDash(c.rail) },
  { header: 'Expires', cell: (c) => orDash(c.expires) },
];

export interface InspectViewProps {
  url: string;
  method: string;
  deps: MppInspectPipelineDeps;
  onComplete: (final: MppInspectPhase) => void;
}

export const InspectView: React.FC<InspectViewProps> = ({ url, method, deps, onComplete }) => {
  const initial: MppInspectPhase = { kind: 'probing' };
  const [phase, dispatch] = useReducer(reduceMppInspect, initial);
  const { finish } = useFlowExit(onComplete);

  useEffect(() => {
    let cancelled = false;
    void runMppInspectPipeline(deps, (event) => {
      if (!cancelled) dispatch(event);
    });
    return () => {
      cancelled = true;
    };
  }, [deps]);

  useEffect(() => {
    if (phase.kind === 'challenges' || phase.kind === 'no-payment' || phase.kind === 'error') {
      finish(phase);
    }
  }, [phase, finish]);

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
    const { result } = phase;
    return (
      <Box flexDirection="column">
        <Text color="green">✓ Seller accepted without payment</Text>
        <Text>{`status: ${String(result.status)}`}</Text>
        {result.contentType !== undefined ? <Text>{`content-type: ${result.contentType}`}</Text> : null}
        <Text>{`response size: ${String(result.bodySizeBytes)} bytes`}</Text>
        <Text dimColor>Use `mpp pay` to fetch the body.</Text>
      </Box>
    );
  }

  if (phase.kind === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ {phase.code}</Text>
        <Text color="red">{phase.message}</Text>
      </Box>
    );
  }

  const { result } = phase;
  const count = result.challenges.length;

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>WWW-Authenticate: Payment</Text>
        {' for '}
        <Text color="cyan">{result.url}</Text>
        {'  ·  '}
        <Text dimColor>{`realm ${result.realm}`}</Text>
        {'  ·  '}
        <Text dimColor>{`${String(count)} challenge${count === 1 ? '' : 's'}`}</Text>
      </Text>
      <Box marginTop={1}>
        <Table columns={COLUMNS} rows={[...result.challenges]} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Use --format json to see challenge ids and digests.</Text>
      </Box>
    </Box>
  );
};

function challengeToFrame(challenge: DecodedChallenge): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: challenge.id,
    realm: challenge.realm,
    method: challenge.method,
    intent: challenge.intent,
  };
  if (challenge.amount !== undefined) row.amount = challenge.amount;
  if (challenge.currency !== undefined) row.currency = challenge.currency;
  if (challenge.recipient !== undefined) row.recipient = challenge.recipient;
  if (challenge.rail !== undefined) row.rail = challenge.rail;
  if (challenge.instrumentId !== undefined) row.instrument_id = challenge.instrumentId;
  if (challenge.expires !== undefined) row.expires = challenge.expires;
  if (challenge.description !== undefined) row.description = challenge.description;
  if (challenge.digest !== undefined) row.digest = challenge.digest;
  return row;
}

export function buildChallengesFrame(result: MppInspectResultChallenges): Record<string, unknown> {
  return {
    outcome: 'challenges',
    url: result.url,
    method: result.method,
    realm: result.realm,
    challenges: result.challenges.map(challengeToFrame),
  };
}

export function buildNoPaymentFrame(result: MppInspectResultNoPayment): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    outcome: 'no-payment-required',
    url: result.url,
    method: result.method,
    status: result.status,
    body_size_bytes: result.bodySizeBytes,
  };
  if (result.contentType !== undefined) frame.content_type = result.contentType;
  return frame;
}
