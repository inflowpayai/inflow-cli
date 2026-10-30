import {
  SourceDiscoveryError,
  sanitizeDeep,
  type SourceDiscovery,
  type SourceDiscoveryResult,
  type IAepResource,
} from '@inflowpayai/inflow-core';
import { Box, Text } from 'ink';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { OperationsView } from '../openapi/index.js';
import type { InspectCommandContext } from './index.js';
import { DetailsTable, detail, listed } from '../odp/presentation.js';
import { enrollmentProtocolLabel, paymentProtocolLabel } from '../odp/payments.js';
import type { AepDocumentReadResult } from '@aep-foundation/agent';
import { ServiceDocumentsTable } from '../aep/documents.js';

export type OriginDiscovery = { source: SourceDiscoveryResult } | { error: { code: string; message: string } };

export async function discoverOrigin(
  origin: string,
  refresh: boolean,
  discovery: Pick<SourceDiscovery, 'inspect'>,
): Promise<OriginDiscovery> {
  try {
    return { source: sanitizeDeep(await discovery.inspect(origin, { refresh, signal: AbortSignal.timeout(60_000) })) };
  } catch (error) {
    return {
      error: {
        code: error instanceof SourceDiscoveryError ? error.code : 'INSPECT_DOCUMENT_FAILED',
        message:
          error instanceof SourceDiscoveryError
            ? sanitizeDeep([error.message, ...error.candidates].join('\n'))
            : 'Unable to discover a public ODP or OpenAPI document.',
      },
    };
  }
}

export function OriginDiscoveryView({ discovery }: { discovery: OriginDiscovery | undefined }) {
  if (discovery === undefined) return null;
  if ('error' in discovery) return <Text dimColor>Document discovery: {discovery.error.message}</Text>;
  return discovery.source.sourceType === 'openapi' ? (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>OpenAPI document</Text>
      <OperationsView document={discovery.source.document} />
      <Text dimColor>
        These are advertised operations. Their individual authentication and payment requirements were not tested.
      </Text>
    </Box>
  ) : null;
}

export function DocumentView({
  result,
  documents,
  documentsUnavailable,
}: {
  result: SourceDiscoveryResult;
  documents?: AepDocumentReadResult['descriptor'][];
  documentsUnavailable?: boolean;
}) {
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
      <DetailsTable
        rows={[
          ...detail('Source', 'ODP'),
          ...detail('Origin', new URL(result.sourceUrl).origin),
          ...detail('Document', result.sourceUrl),
          ...detail('Description', result.document.description),
          ...detail(
            'Operations',
            listed(result.document.operations.map(({ name, authentication }) => `${name} (${authentication})`)),
          ),
          ...detail(
            'Enrollment',
            listed((result.document.protocols?.enrollment ?? []).map(({ name }) => enrollmentProtocolLabel(name))),
          ),
          ...detail(
            'Payments',
            listed(
              (result.document.protocols?.payments ?? []).map(
                (payment) => `${paymentProtocolLabel(payment)} (${payment.authentication})`,
              ),
            ),
          ),
        ]}
      />
      <Text dimColor>Public document inspection only. No operation was called or payment requirement tested.</Text>
      <ServiceDocumentsTable documents={documents} serviceUrl={new URL(result.sourceUrl).origin} />
      {documentsUnavailable ? <Text>AEP Service document inspection failed. Use aep inspect for details.</Text> : null}
    </Box>
  );
}

export async function inspectDocument(
  c: InspectCommandContext,
  discovery: Pick<SourceDiscovery, 'inspect'>,
  aep?: Pick<IAepResource, 'inspect'>,
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
  let documents: AepDocumentReadResult['descriptor'][] | undefined;
  let documentsUnavailable = false;
  if (
    aep !== undefined &&
    result.sourceType === 'odp' &&
    result.document.protocols?.enrollment?.some(({ name }) => name.toLowerCase() === 'aep') === true
  ) {
    try {
      const inspected = await aep.inspect({
        serviceUrl: new URL(result.sourceUrl).origin,
        signal: AbortSignal.timeout(30_000),
      });
      documents = sanitizeDeep(inspected.document.service_documents);
    } catch {
      documentsUnavailable = true;
    }
  }
  if (!c.agent && !c.formatExplicit)
    await renderInkUntilExit(
      <DocumentView
        result={result}
        {...(documents === undefined ? {} : { documents })}
        documentsUnavailable={documentsUnavailable}
      />,
    );
  return {
    outcome: 'document-inspected',
    source: { type: result.sourceType, url: result.sourceUrl },
    ...(result.sourceType === 'odp'
      ? { service_origin: new URL(result.sourceUrl).origin }
      : { operation_count: result.document.operations.length }),
    document: result.document,
    ...(documents === undefined ? {} : { service_documents: documents }),
    ...(documentsUnavailable
      ? {
          warnings: [
            {
              code: 'AEP_DOCUMENTS_UNAVAILABLE',
              message: 'AEP Service document inspection failed. Use aep inspect for details.',
            },
          ],
        }
      : {}),
  };
}
