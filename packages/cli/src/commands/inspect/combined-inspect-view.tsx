import {
  type CombinedInspectNoPayment,
  type CombinedInspectPhase,
  type CombinedInspectPipelineDeps,
  type CombinedInspectResult,
  type AepSection,
  type MppSection,
  type OdpSection,
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
import { AepDetailsTable } from '../aep/views.js';
import { MppChallengePresentation } from '../mpp/challenge-presentation.js';
import { OdpDetailsTable } from '../odp/service.js';

function orDash(value: string | undefined): string {
  return value === undefined || value === '' ? '—' : value;
}

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

interface ProtocolSummaryRow {
  capability: string;
  serviceCapability: string;
  currentRequest: string;
  evidence: string;
}

const PROTOCOL_SUMMARY_COLUMNS: ReadonlyArray<TableColumn<ProtocolSummaryRow>> = [
  { header: 'Capability', cell: (row) => row.capability },
  { header: 'Service capability', cell: (row) => row.serviceCapability },
  { header: 'Current request', cell: (row) => row.currentRequest },
  { header: 'Evidence', cell: (row) => row.evidence },
];

function evidence(...sources: Array<string | undefined>): string {
  return [...new Set(sources.filter((source): source is string => source !== undefined))].join(', ');
}

function responseEvidence(status: number | undefined): string | undefined {
  return status === undefined ? undefined : `HTTP ${String(status)}`;
}

function aepSummary(section: AepSection, status: number | undefined): ProtocolSummaryRow {
  const http = responseEvidence(status);
  if (section.kind === 'absent') {
    return {
      capability: 'AEP',
      serviceCapability: 'Not advertised',
      currentRequest: 'Authentication not required',
      evidence: http ?? 'Live probe',
    };
  }
  if (section.kind === 'blocked') {
    return {
      capability: 'AEP',
      serviceCapability: 'Supported',
      currentRequest: 'Authentication required',
      evidence: 'AEP OpenAPI',
    };
  }
  if (section.kind === 'openapi') {
    return {
      capability: 'AEP',
      serviceCapability: 'Supported',
      currentRequest: section.policy.state === 'required' ? 'Authentication required' : 'Authentication not required',
      evidence: evidence('AEP OpenAPI', http),
    };
  }
  if (section.kind === 'discovered') {
    return {
      capability: 'AEP',
      serviceCapability: 'Supported',
      currentRequest: 'Authentication not required',
      evidence: evidence('AEP', http),
    };
  }
  if (section.kind === 'service') {
    return {
      capability: 'AEP',
      serviceCapability: 'Supported',
      currentRequest: 'Authentication required',
      evidence: evidence('AEP challenge', http),
    };
  }
  return {
    capability: 'AEP',
    serviceCapability: 'Detected; inspection failed',
    currentRequest: 'Authentication required',
    evidence: evidence('AEP challenge', http),
  };
}

function odpSummary(section: OdpSection): ProtocolSummaryRow {
  if (section.kind === 'service') {
    return {
      capability: 'ODP',
      serviceCapability: 'Supported',
      currentRequest: 'Catalog available',
      evidence: 'ODP',
    };
  }
  if (section.kind === 'error') {
    return {
      capability: 'ODP',
      serviceCapability: 'Inspection failed',
      currentRequest: 'Catalog unknown',
      evidence: 'ODP inspection',
    };
  }
  return {
    capability: 'ODP',
    serviceCapability: 'Not advertised',
    currentRequest: 'Catalog unavailable',
    evidence: 'ODP inspection',
  };
}

function odpSupportsPayment(section: OdpSection, protocol: 'mpp' | 'x402'): boolean {
  return (
    section.kind === 'service' &&
    section.inspect.capabilities.payments.some(({ name }) => String(name).toLowerCase() === protocol)
  );
}

function paymentSummary(
  protocol: 'MPP' | 'x402',
  odp: OdpSection,
  aep: AepSection,
  section: MppSection | X402Section | undefined,
  status: number | undefined,
): ProtocolSummaryRow {
  const protocolName = protocol.toLowerCase() as 'mpp' | 'x402';
  const odpAdvertised = odpSupportsPayment(odp, protocolName);
  const liveAdvertised = section !== undefined && section.kind !== 'absent';
  let currentRequest: string;
  if (aep.kind === 'blocked') currentRequest = 'Unknown until authenticated';
  else if (section === undefined) currentRequest = 'Payment not required';
  else if (section.kind === 'absent') currentRequest = 'No live challenge';
  else if (section.kind === 'error') currentRequest = 'Challenge could not be decoded';
  else if (section.kind === 'none-inflow') currentRequest = 'Payment required; unsupported method';
  else currentRequest = 'Payment required';
  return {
    capability: protocol,
    serviceCapability: odpAdvertised || liveAdvertised ? 'Supported' : 'Not advertised',
    currentRequest,
    evidence: evidence(
      odpAdvertised ? 'ODP' : undefined,
      aep.kind === 'blocked' ? 'AEP OpenAPI' : responseEvidence(status),
    ),
  };
}

function protocolSummaryRows(result: CombinedInspectResult | CombinedInspectNoPayment): ProtocolSummaryRow[] {
  const status = result.status;
  return [
    odpSummary(result.odp),
    aepSummary(result.aep, status),
    paymentSummary('MPP', result.odp, result.aep, result.outcome === 'inspected' ? result.mpp : undefined, status),
    paymentSummary('x402', result.odp, result.aep, result.outcome === 'inspected' ? result.x402 : undefined, status),
  ];
}

const ProtocolSummaryTable: React.FC<{ result: CombinedInspectResult | CombinedInspectNoPayment }> = ({ result }) => (
  <Table columns={PROTOCOL_SUMMARY_COLUMNS} rows={protocolSummaryRows(result)} />
);

const HttpRequirementsHeader: React.FC<{
  result: CombinedInspectResult | CombinedInspectNoPayment;
}> = ({ result }) => (
  <Text>
    <Text bold>HTTP requirements</Text>
    {' for '}
    <Text color="cyan">{result.url}</Text>
  </Text>
);

/** Protocols with at least one usable entry in the structured agent output. */
export function detectedProtocols(odp: OdpSection, aep: AepSection, mpp: MppSection, x402: X402Section): string[] {
  const out: string[] = [];
  if (odp.kind === 'service') out.push('odp');
  if (aep.kind !== 'absent') out.push('aep');
  if (mpp.kind === 'challenges' && mpp.challenges.length > 0) out.push('mpp');
  if (x402.kind === 'accepts' && x402.accepts.length > 0) out.push('x402');
  return out;
}

const OdpSectionView: React.FC<{ section: OdpSection }> = ({ section }) => {
  if (section.kind === 'absent') {
    return (
      <Text>
        <Text bold>── ODP ──</Text> <Text dimColor>Service catalog not available.</Text>
      </Text>
    );
  }
  if (section.kind === 'error') {
    return (
      <Text>
        <Text bold>── ODP ──</Text> <Text color="yellow">{`inspection failed (${section.code})`}</Text>
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold>── ODP ──</Text>
      <OdpDetailsTable inspection={section.inspect} />
    </Box>
  );
};

const AepSectionView: React.FC<{ section: AepSection }> = ({ section }) => {
  if (section.kind === 'absent') {
    if (section.openApiPolicy !== undefined) {
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold>── AEP ──</Text>{' '}
            <Text dimColor>{section.source === 'not_checked' ? 'not checked' : 'not required for this URL'}</Text>
          </Text>
        </Box>
      );
    }
    return (
      <Text>
        <Text bold>── AEP ──</Text>{' '}
        <Text dimColor>{section.source === 'not_checked' ? 'not checked' : 'not required for this URL'}</Text>
      </Text>
    );
  }
  if (section.kind === 'error') {
    return (
      <Text>
        <Text bold>── AEP ──</Text>{' '}
        <Text color="yellow">{`authentication required, but Inspect failed (${section.code})`}</Text>
      </Text>
    );
  }
  const serviceUrl = String(section.inspect.finalUrl ?? section.inspect.inspectUrl).replace('/.well-known/aep', '');
  if (section.kind === 'discovered') {
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>── AEP ──</Text> <Text dimColor>available; authentication not required for this URL</Text>
        </Text>
        <AepDetailsTable
          document={section.inspect.document}
          resourceAuthentication="Not required"
          serviceUrl={serviceUrl}
        />
      </Box>
    );
  }
  if (section.kind === 'openapi') {
    const resourceAuthentication =
      section.policy.state === 'required'
        ? 'AEP authenticatable'
        : section.policy.state === 'public'
          ? 'Not required'
          : 'Not checked';
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>── AEP ──</Text>{' '}
          <Text dimColor>{section.policy.state === 'required' ? 'authentication required' : 'not required'}</Text>
        </Text>
        <AepDetailsTable
          document={section.inspect.document}
          openApiPolicy={section.policy}
          resourceAuthentication={resourceAuthentication}
          serviceUrl={serviceUrl}
        />
      </Box>
    );
  }
  if (section.kind === 'blocked') {
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>── AEP ──</Text> <Text color="yellow">authentication required before payment inspection</Text>
        </Text>
        <Text dimColor>{section.message}</Text>
        <AepDetailsTable
          document={section.inspect.document}
          openApiPolicy={section.policy}
          resourceAuthentication="AEP authenticatable"
          serviceUrl={serviceUrl}
        />
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>── AEP ──</Text> <Text dimColor>AEP authentication required</Text>
      </Text>
      <AepDetailsTable document={section.inspect.document} serviceUrl={serviceUrl} />
    </Box>
  );
};

const MppSectionView: React.FC<{ section: MppSection }> = ({ section }) => {
  if (section.kind === 'absent') {
    return (
      <Text>
        <Text bold>── MPP ──</Text> <Text dimColor>no live challenge at this URL</Text>
      </Text>
    );
  }
  if (section.kind === 'none-inflow') {
    const methods = section.methods.length > 0 ? section.methods.join(', ') : '(unknown)';
    return (
      <Text>
        <Text bold>── MPP ──</Text> <Text dimColor>{`advertised method(s) not payable by InFlow: ${methods}`}</Text>
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
      <MppChallengePresentation challenges={section.challenges} />
    </Box>
  );
};

const X402SectionView: React.FC<{ section: X402Section }> = ({ section }) => {
  if (section.kind === 'absent') {
    return (
      <Text>
        <Text bold>── x402 ──</Text> <Text dimColor>no live challenge at this URL</Text>
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
        <HttpRequirementsHeader result={result} />
        <Box marginTop={1} flexDirection="column">
          <Text bold>Capability summary</Text>
          <ProtocolSummaryTable result={result} />
        </Box>
        {result.odp.kind !== 'absent' && (
          <Box marginTop={1}>
            <OdpSectionView section={result.odp} />
          </Box>
        )}
        {result.aep.kind !== 'absent' && (
          <Box marginTop={1}>
            <AepSectionView section={result.aep} />
          </Box>
        )}
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
  return (
    <Box flexDirection="column">
      <HttpRequirementsHeader result={result} />
      <Box marginTop={1} flexDirection="column">
        <Text bold>Capability summary</Text>
        <ProtocolSummaryTable result={result} />
      </Box>
      {result.odp.kind !== 'absent' && (
        <Box marginTop={1}>
          <OdpSectionView section={result.odp} />
        </Box>
      )}
      {result.aep.kind !== 'absent' && (
        <Box marginTop={1}>
          <AepSectionView section={result.aep} />
        </Box>
      )}
      {result.mpp.kind !== 'absent' && (
        <Box marginTop={1}>
          <MppSectionView section={result.mpp} />
        </Box>
      )}
      {result.x402.kind !== 'absent' && (
        <Box marginTop={1}>
          <X402SectionView section={result.x402} />
        </Box>
      )}
    </Box>
  );
};
