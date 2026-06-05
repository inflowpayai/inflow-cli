import {
  type CombinedInspectPhase,
  type CombinedInspectPipelineDeps,
  type DecodedChallenge,
  type MppSection,
  reduceCombinedInspect,
  runCombinedInspectPipeline,
  type X402Section,
} from '@inflowpayai/inflow-core';
import type { PaymentRequirements } from '@inflowpayai/x402';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useReducer } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';
import { Table, type TableColumn } from '../../utils/table.js';

function orDash(value: string | undefined): string {
  return value === undefined || value === '' ? '—' : value;
}

/**
 * Triage column set for the combined view — only the decision-relevant fields. MPP carries a reliable human `amount`
 * and `currency` symbol, so both are shown.
 */
const MPP_TRIAGE_COLUMNS: ReadonlyArray<TableColumn<DecodedChallenge>> = [
  { header: 'Method', cell: (c) => c.method },
  { header: 'Intent', cell: (c) => c.intent },
  { header: 'Amount', cell: (c) => orDash(c.amount) },
  { header: 'Currency', cell: (c) => orDash(c.currency) },
  { header: 'Rail', cell: (c) => orDash(c.rail) },
];

/**
 * Triage column set for x402. `Amount` is the raw atomic units the seller advertised (no decimals on the wire); `Asset`
 * is the full on-chain contract address / mint, rendered verbatim — NOT a token symbol, since `extra.assetName` is only
 * present for sellers integrated with the inflow-node SDK. Full detail (pay-to, timeout, extras) lives in `inflow x402
 * inspect`.
 */
const X402_TRIAGE_COLUMNS: ReadonlyArray<TableColumn<PaymentRequirements>> = [
  { header: 'Scheme', cell: (r) => r.scheme },
  { header: 'Network', cell: (r) => r.network },
  { header: 'Amount', cell: (r) => r.amount },
  { header: 'Asset', cell: (r) => orDash(r.asset) },
];

/** Protocols with at least one usable entry — drives the `detected:` summary and the agent frame. */
export function detectedProtocols(mpp: MppSection, x402: X402Section): string[] {
  const out: string[] = [];
  if (mpp.kind === 'challenges' && mpp.challenges.length > 0) out.push('mpp');
  if (x402.kind === 'accepts' && x402.accepts.length > 0) out.push('x402');
  return out;
}

const MppSectionView: React.FC<{ section: MppSection }> = ({ section }) => {
  if (section.kind === 'absent') {
    return (
      <Text>
        <Text bold>── MPP ──</Text> <Text dimColor>none advertised</Text>
      </Text>
    );
  }
  if (section.kind === 'none-inflow') {
    const methods = section.methods.length > 0 ? section.methods.join(', ') : '(unknown)';
    return (
      <Text>
        <Text bold>── MPP ──</Text>{' '}
        <Text dimColor>{`advertised method(s) not payable by InFlow: ${methods} (only \`inflow\` is supported)`}</Text>
      </Text>
    );
  }
  if (section.kind === 'error') {
    return (
      <Text>
        <Text bold>── MPP ──</Text> <Text color="yellow">{`header present but undecodable (${section.code})`}</Text>
      </Text>
    );
  }
  const count = section.challenges.length;
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>── MPP ──</Text>
        {'  '}
        <Text dimColor>WWW-Authenticate: Payment</Text>
        {'  ·  '}
        <Text dimColor>{`realm ${section.realm}`}</Text>
        {'  ·  '}
        <Text dimColor>{`${String(count)} challenge${count === 1 ? '' : 's'}`}</Text>
      </Text>
      <Table columns={MPP_TRIAGE_COLUMNS} rows={[...section.challenges]} />
    </Box>
  );
};

const X402SectionView: React.FC<{ section: X402Section }> = ({ section }) => {
  if (section.kind === 'absent') {
    return (
      <Text>
        <Text bold>── x402 ──</Text> <Text dimColor>none advertised</Text>
      </Text>
    );
  }
  if (section.kind === 'error') {
    return (
      <Text>
        <Text bold>── x402 ──</Text> <Text color="yellow">{`header present but undecodable (${section.code})`}</Text>
      </Text>
    );
  }
  const count = section.accepts.length;
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>── x402 ──</Text>
        {'  '}
        <Text dimColor>PAYMENT-REQUIRED</Text>
        {'  ·  '}
        <Text dimColor>{`x402Version ${String(section.x402Version)}`}</Text>
        {'  ·  '}
        <Text dimColor>{`${String(count)} accept${count === 1 ? '' : 's'}`}</Text>
      </Text>
      <Table columns={X402_TRIAGE_COLUMNS} rows={[...section.accepts]} />
    </Box>
  );
};

export interface CombinedInspectViewProps {
  url: string;
  method: string;
  deps: CombinedInspectPipelineDeps;
  onComplete: (final: CombinedInspectPhase) => void;
}

export const CombinedInspectView: React.FC<CombinedInspectViewProps> = ({ url, method, deps, onComplete }) => {
  const initial: CombinedInspectPhase = { kind: 'probing' };
  const [phase, dispatch] = useReducer(reduceCombinedInspect, initial);
  const { finish } = useFlowExit(onComplete);

  useEffect(() => {
    let cancelled = false;
    void runCombinedInspectPipeline(deps, (event) => {
      if (!cancelled) dispatch(event);
    });
    return () => {
      cancelled = true;
    };
  }, [deps]);

  useEffect(() => {
    if (phase.kind === 'inspected' || phase.kind === 'no-payment' || phase.kind === 'error') {
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
        <Text dimColor>No InFlow-payable challenge advertised.</Text>
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
  const detected = detectedProtocols(result.mpp, result.x402);
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>PAYMENT-REQUIRED</Text>
        {' for '}
        <Text color="cyan">{result.url}</Text>
        {'  ·  '}
        <Text dimColor>{`detected: ${detected.length > 0 ? detected.join(', ') : 'none'}`}</Text>
      </Text>
      <Box marginTop={1}>
        <MppSectionView section={result.mpp} />
      </Box>
      <Box marginTop={1}>
        <X402SectionView section={result.x402} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Full detail (pay-to, timeout, extras, ids/digests): `inflow mpp inspect` / `inflow x402 inspect`, or --format
          json.
        </Text>
      </Box>
    </Box>
  );
};
