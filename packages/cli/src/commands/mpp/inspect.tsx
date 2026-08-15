import {
  type DecodedChallenge,
  type MppInspectPhase,
  type MppInspectPipelineDeps,
  type MppInspectResultChallenges,
  type MppInspectResultNoPayment,
  type PaymentInspectionBlocked,
  reduceMppInspect,
  runMppInspectPipeline,
} from '@inflowpayai/inflow-core';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useReducer } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';
import { Table, type TableColumn } from '../../utils/table.js';
import { MppChallengePresentation } from './challenge-presentation.js';

export {
  type MppInspectPhase,
  type MppInspectPipelineDeps,
  type MppInspectResultChallenges,
  type MppInspectResultNoPayment,
  reduceMppInspect,
  runMppInspectPipeline,
};

interface NoPaymentRow {
  field: string;
  value: string;
}

const NO_PAYMENT_COLUMNS: ReadonlyArray<TableColumn<NoPaymentRow>> = [
  { header: 'Field', cell: (row) => row.field },
  { header: 'Value', cell: (row) => row.value },
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
    if (
      phase.kind === 'challenges' ||
      phase.kind === 'no-payment' ||
      phase.kind === 'blocked' ||
      phase.kind === 'error'
    ) {
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
    const rows: NoPaymentRow[] = [
      { field: 'Payment required', value: 'No' },
      { field: 'Status', value: String(result.status) },
    ];
    if (result.contentType !== undefined) rows.push({ field: 'Content type', value: result.contentType });
    rows.push({ field: 'Response size', value: `${String(result.bodySizeBytes)} bytes` });
    return (
      <Box flexDirection="column">
        <Table columns={NO_PAYMENT_COLUMNS} rows={rows} />
        <Box marginTop={1}>
          <Text dimColor>Use `mpp fetch` to fetch the body.</Text>
        </Box>
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

  if (phase.kind === 'blocked') {
    return (
      <Box flexDirection="column">
        <Text color="yellow">AEP authentication required before MPP terms can be inspected.</Text>
        {phase.result.serviceUrl !== undefined ? <Text>{`Service: ${phase.result.serviceUrl}`}</Text> : null}
        {phase.result.serviceDid !== undefined ? <Text dimColor>{`DID: ${phase.result.serviceDid}`}</Text> : null}
        <Text dimColor>{phase.result.message}</Text>
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
        <MppChallengePresentation challenges={result.challenges} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Use --format json to see challenge ids and digests.</Text>
      </Box>
    </Box>
  );
};

export function challengeToFrame(challenge: DecodedChallenge): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: challenge.id,
    realm: challenge.realm,
    method: challenge.method,
    intent: challenge.intent,
  };
  if (challenge.amount !== undefined) row['amount'] = challenge.amount;
  if (challenge.currency !== undefined) row['currency'] = challenge.currency;
  if (challenge.recipient !== undefined) row['recipient'] = challenge.recipient;
  if (challenge.rail !== undefined) row['rail'] = challenge.rail;
  if (challenge.instrumentId !== undefined) row['instrument_id'] = challenge.instrumentId;
  if (challenge.expires !== undefined) row['expires'] = challenge.expires;
  if (challenge.description !== undefined) row['description'] = challenge.description;
  if (challenge.digest !== undefined) row['digest'] = challenge.digest;
  if (challenge.periodCount !== undefined) row['period_count'] = challenge.periodCount;
  if (challenge.periodUnit !== undefined) row['period_unit'] = challenge.periodUnit;
  if (challenge.subscriptionExpires !== undefined) row['subscription_expires'] = challenge.subscriptionExpires;
  if (challenge.externalId !== undefined) row['external_id'] = challenge.externalId;
  if (challenge.optionId !== undefined) row['option_id'] = challenge.optionId;
  if (challenge.optionFingerprint !== undefined) row['option_fingerprint'] = challenge.optionFingerprint;
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
  if (result.contentType !== undefined) frame['content_type'] = result.contentType;
  return frame;
}

export function buildBlockedFrame(result: PaymentInspectionBlocked): Record<string, unknown> {
  return {
    outcome: 'aep-authentication-required',
    url: result.url,
    method: result.method,
    source: result.source,
    message: result.message,
    ...(result.serviceUrl === undefined ? {} : { service_url: result.serviceUrl }),
    ...(result.serviceDid === undefined ? {} : { service_did: result.serviceDid }),
  };
}
