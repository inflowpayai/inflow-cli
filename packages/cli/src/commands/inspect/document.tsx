import {
  SourceDiscoveryError,
  sanitizeDeep,
  type SourceDiscovery,
  type SourceDiscoveryResult,
} from '@inflowpayai/inflow-core';
import { Box, Text } from 'ink';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { OperationsView } from '../openapi/index.js';
import type { InspectCommandContext } from './index.js';

export function DocumentView({ result }: { result: SourceDiscoveryResult }) {
  if (result.sourceType === 'openapi')
    return (
      <Box flexDirection="column">
        <OperationsView document={result.document} />
        <Text>Operation count: {result.document.operations.length}</Text>
        <Text>
          Declared authentication schemes:{' '}
          {[...new Set(result.document.operations.flatMap((operation) => Object.keys(operation.securitySchemes)))].join(
            ', ',
          ) || 'None'}
        </Text>
        <Text dimColor>
          Authentication requirements vary by operation. Use openapi operations get for details. No operation was called
          or payment requirement tested.
        </Text>
      </Box>
    );
  return (
    <Box flexDirection="column">
      <Text bold>{result.document.name}</Text>
      <Text>Source: ODP</Text>
      <Text>Origin: {new URL(result.sourceUrl).origin}</Text>
      <Text>Document: {result.sourceUrl}</Text>
      <Text>{result.document.description}</Text>
      <Text>
        Advertised operations: {result.document.operations.map((operation) => operation.name).join(', ') || 'None'}
      </Text>
      <Text>Advertised protocols: {JSON.stringify(result.document.protocols ?? {})}</Text>
      <Text dimColor>Public document inspection only. No operation was called or payment requirement tested.</Text>
    </Box>
  );
}

export async function inspectDocument(
  c: InspectCommandContext,
  discovery: Pick<SourceDiscovery, 'inspect'>,
): Promise<Record<string, unknown>> {
  let result: SourceDiscoveryResult;
  try {
    result = sanitizeDeep(
      await discovery.inspect(c.args.url, { refresh: c.options.refresh ?? false, signal: AbortSignal.timeout(60_000) }),
    );
  } catch (error) {
    return c.error({
      code: error instanceof SourceDiscoveryError ? error.code : 'INSPECT_DOCUMENT_FAILED',
      message:
        error instanceof SourceDiscoveryError
          ? [error.message, ...error.candidates].join('\n')
          : 'Unable to read a valid public ODP or JSON OpenAPI 3.x document at this location.',
      retryable: false,
    });
  }
  if (!c.agent && !c.formatExplicit) await renderInkUntilExit(<DocumentView result={result} />);
  return {
    outcome: 'document-inspected',
    source: { type: result.sourceType, url: result.sourceUrl },
    ...(result.sourceType === 'odp'
      ? { service_origin: new URL(result.sourceUrl).origin }
      : { operation_count: result.document.operations.length }),
    document: result.document,
  };
}
