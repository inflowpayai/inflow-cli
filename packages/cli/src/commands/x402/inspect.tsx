import {
  type InspectPhase,
  type InspectPipelineDeps,
  type InspectResultAccepts,
  type InspectResultNoPayment,
  reduceX402Inspect,
  runInspectPipeline,
} from '@inflowpayai/inflow-core';
import type { PaymentRequirements } from '@inflowpayai/x402';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useReducer } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';
import { Table, type TableColumn } from '../../utils/table.js';

export {
  type InspectPhase,
  type InspectPipelineDeps,
  type InspectResultAccepts,
  type InspectResultNoPayment,
  reduceX402Inspect,
  runInspectPipeline,
};

type InspectRow = PaymentRequirements;

function summarizeExtra(extra: Record<string, unknown> | undefined): string {
  if (extra === undefined) return '—';
  const keys = Object.keys(extra);
  if (keys.length === 0) return '—';
  return [...keys].sort((a, b) => a.localeCompare(b)).join(', ');
}

function formatTimeout(seconds: number): string {
  return `${String(seconds)}s`;
}

function formatAsset(asset: string): string {
  return asset === '' ? '—' : asset;
}

const COLUMNS: ReadonlyArray<TableColumn<InspectRow>> = [
  { header: 'Scheme', cell: (r) => r.scheme },
  { header: 'Network', cell: (r) => r.network },
  { header: 'Amount', cell: (r) => r.amount },
  { header: 'Asset', cell: (r) => formatAsset(r.asset) },
  { header: 'Pay To', cell: (r) => r.payTo },
  { header: 'Timeout', cell: (r) => formatTimeout(r.maxTimeoutSeconds) },
  { header: 'Extra', cell: (r) => summarizeExtra(r.extra) },
];

export interface InspectViewProps {
  url: string;
  method: string;
  deps: InspectPipelineDeps;
  onComplete: (final: InspectPhase) => void;
}

export const InspectView: React.FC<InspectViewProps> = ({ url, method, deps, onComplete }) => {
  const initial: InspectPhase = { kind: 'probing' };
  const [phase, dispatch] = useReducer(reduceX402Inspect, initial);
  const { finish } = useFlowExit(onComplete);

  useEffect(() => {
    let cancelled = false;
    void runInspectPipeline(deps, (event) => {
      if (!cancelled) dispatch(event);
    });
    return () => {
      cancelled = true;
    };
  }, [deps]);

  useEffect(() => {
    if (phase.kind === 'accepts' || phase.kind === 'no-payment' || phase.kind === 'error') {
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
    return (
      <Box flexDirection="column">
        <Text color="green">✓ Seller accepted without payment</Text>
        <Text dimColor>Use `x402 pay` to fetch the body.</Text>
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
  const acceptsCount = result.accepts.length;
  const extensionsLine = result.extensions !== undefined ? Object.keys(result.extensions).join(', ') : null;

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>PAYMENT-REQUIRED</Text>
        {' for '}
        <Text color="cyan">{result.resource}</Text>
        {'  ·  '}
        <Text dimColor>{`x402Version ${String(result.x402Version)}`}</Text>
        {'  ·  '}
        <Text dimColor>{`${String(acceptsCount)} accept${acceptsCount === 1 ? '' : 's'}`}</Text>
      </Text>
      {extensionsLine !== null ? <Text dimColor>{`extensions: ${extensionsLine}`}</Text> : null}
      <Box marginTop={1}>
        <Table columns={COLUMNS} rows={result.accepts} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Use --format json to inspect extras values.</Text>
      </Box>
    </Box>
  );
};

export function acceptToFrame(entry: InspectRow): Record<string, unknown> {
  const row: Record<string, unknown> = {
    scheme: entry.scheme,
    network: entry.network,
    amount: entry.amount,
    asset: entry.asset,
    pay_to: entry.payTo,
    max_timeout_seconds: entry.maxTimeoutSeconds,
  };
  if (entry.extra !== undefined) row.extra = entry.extra;
  return row;
}

export function buildAcceptsFrame(result: InspectResultAccepts): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    outcome: 'accepts',
    url: result.url,
    method: result.method,
    resource: result.resource,
    x402_version: result.x402Version,
    accepts: result.accepts.map(acceptToFrame),
  };
  if (result.extensions !== undefined) frame.extensions = result.extensions;
  return frame;
}

export function buildNoPaymentFrame(result: InspectResultNoPayment): Record<string, unknown> {
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
