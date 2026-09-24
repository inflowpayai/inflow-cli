import {
  OpenApiOperationError,
  OpenApiPreparationError,
  SourceDiscovery,
  SourceDiscoveryError,
  sanitizeDeep,
  parseHeaderFlag,
  prepareOpenApiRequest,
  previewOpenApiRequest,
  selectOpenApiOperation,
  callOpenApiOperation,
  openApiHandoff,
  OpenApiCallError,
  type PublicDocumentFetch,
  type OpenApiDescription,
  type OpenApiOperation,
} from '@inflowpayai/inflow-core';
import { Cli } from 'incur';
import { Box, Text } from 'ink';
import { mcpTool } from '../../mcp-metadata.js';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { Table } from '../../utils/table.js';
import { callOptions, documentArgs, getOptions, listOptions, prepareOptions } from './schema.js';

interface ReadContext {
  agent: boolean;
  formatExplicit: boolean;
  error(error: { code: string; message: string; retryable: boolean }): never;
}

export function OperationView({ operation }: { operation: OpenApiOperation }) {
  return (
    <Box flexDirection="column">
      <Text bold>
        {operation.method} {operation.path}
      </Text>
      {operation.summary === undefined ? null : <Text>{operation.summary}</Text>}
      {operation.description === undefined ? null : <Text>{operation.description}</Text>}
      <Text>Operation ID: {operation.operationId ?? 'Not declared'}</Text>
      <Text bold>Servers</Text>
      {operation.servers.map((server, index) => (
        <Text key={index}>
          {index + 1}. {JSON.stringify(server)}
        </Text>
      ))}
      <Text bold>Parameters</Text>
      <Text>{JSON.stringify(operation.parameters, null, 2)}</Text>
      <Text bold>Request body</Text>
      <Text>
        {operation.requestBody === undefined ? 'Not declared' : JSON.stringify(operation.requestBody, null, 2)}
      </Text>
      <Text bold>Declared authentication</Text>
      <Text>{JSON.stringify(operation.security, null, 2)}</Text>
      <Text>{JSON.stringify(operation.securitySchemes, null, 2)}</Text>
      <Text bold>Advertised payment</Text>
      <Text>{JSON.stringify(operation.payment ?? { advertised: false }, null, 2)}</Text>
      <Text dimColor>
        Requirement objects are alternatives; schemes within an object are all required. No declared requirement does
        not prove anonymous access or free execution. Provider login and SIWX are not automated.
      </Text>
      {operation.limitations.map((item, index) => (
        <Text key={index}>{item}</Text>
      ))}
    </Box>
  );
}

export function PreparedRequestView({
  preview,
}: {
  preview: ReturnType<typeof previewOpenApiRequest> & {
    payment?: OpenApiOperation['payment'];
    next?: ReturnType<typeof openApiHandoff>;
  };
}) {
  return (
    <Box flexDirection="column">
      <Text bold>Prepared request — not sent</Text>
      <Text>
        {preview.request.method} {preview.request.url}
      </Text>
      <Text>{JSON.stringify(preview.request.headers, null, 2)}</Text>
      {preview.request.body === undefined ? null : <Text>{preview.request.body}</Text>}
      <Text>Declared authentication: {JSON.stringify(preview.authentication.requirements)}</Text>
      {preview.payment === undefined ? null : <Text>Advertised payment: {JSON.stringify(preview.payment)}</Text>}
      {preview.next === undefined || preview.next.length === 0 ? null : (
        <Text>Payment commands: {JSON.stringify(preview.next, null, 2)}</Text>
      )}
      {preview.redactions.map((item) => (
        <Text key={`${item.location}:${item.name}`}>
          Redacted {item.location}: {item.name}
        </Text>
      ))}
      {preview.limitations.map((item, index) => (
        <Text key={index}>{item}</Text>
      ))}
      <Text dimColor>
        Only recognized credentials are redacted. Other supplied data can be sensitive. This preview is not persisted.
      </Text>
    </Box>
  );
}

function jsonObject(value: string | undefined, option: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    /* Report the option, not its potentially sensitive value. */
  }
  throw new OpenApiPreparationError('OPENAPI_INPUT_INVALID', `${option} must contain a JSON object.`);
}

export function CallView({ result }: { result: Awaited<ReturnType<typeof callOpenApiOperation>> }) {
  return (
    <Box flexDirection="column">
      <Text bold>
        {result.outcome} — {result.sent ? `HTTP ${result.status}` : 'request not sent'}
      </Text>
      <Text>
        {result.request.method} {result.request.url}
      </Text>
      {'body' in result ? <Text>{result.body}</Text> : null}
      {'body_base64' in result ? <Text>{result.body_base64}</Text> : null}
      {'output_saved_to' in result ? <Text>Saved to {result.output_saved_to}</Text> : null}
      {result.next.map((next) => (
        <Box key={next.command.join(' ')} flexDirection="column">
          <Text>
            Use inflow {next.command.join(' ')} with URL {next.url}
          </Text>
          <Text>{JSON.stringify(next.options, null, 2)}</Text>
          <Text>{next.message}</Text>
          {next.requiredInputs.length > 0 ? (
            <Text>Supply the original credentials for: {next.requiredInputs.map((item) => item.name).join(', ')}</Text>
          ) : null}
        </Box>
      ))}
      {result.outcome === 'payment-required' && result.next.length === 0 ? (
        <Text>No recognized payment protocol. No payment was attempted.</Text>
      ) : null}
    </Box>
  );
}

function requestHeaders(values: string[]): Record<string, string> {
  const entries: [string, string][] = [];
  for (const value of values) {
    let parsed: ReturnType<typeof parseHeaderFlag>;
    try {
      parsed = parseHeaderFlag(value);
    } catch {
      throw new OpenApiPreparationError('OPENAPI_INPUT_INVALID', 'Use --header "Name: Value" for each request header.');
    }
    const name = parsed.name.toLowerCase();
    if (entries.some(([key]) => key === name))
      throw new OpenApiPreparationError('OPENAPI_INPUT_INVALID', 'Each request header may be supplied only once.');
    entries.push([name, parsed.value]);
  }
  return Object.fromEntries(entries);
}

export function OperationsView({ document }: { document: OpenApiDescription }) {
  return (
    <Box flexDirection="column">
      <Text bold>{document.title}</Text>
      <Text>OpenAPI {document.version}</Text>
      <Text>Document: {document.sourceUrl}</Text>
      {document.operations.length === 0 ? (
        <Text>No operations declared.</Text>
      ) : (
        <Table
          columns={[
            { header: 'Method', cell: (operation: OpenApiOperation) => operation.method },
            { header: 'Path', cell: (operation: OpenApiOperation) => operation.path },
            { header: 'Summary', cell: (operation: OpenApiOperation) => operation.summary ?? '-' },
            {
              header: 'Payment',
              cell: (operation: OpenApiOperation) =>
                operation.payment?.advertised
                  ? operation.payment.protocols.join(', ') || 'Unrecognized'
                  : 'Not advertised',
            },
          ]}
          rows={document.operations}
        />
      )}
      {document.limitations.map((item, index) => (
        <Text key={index}>{item}</Text>
      ))}
    </Box>
  );
}

async function readCommand<T>(context: ReadContext, operation: () => Promise<T>): Promise<T> {
  try {
    return sanitizeDeep(await operation());
  } catch (error) {
    if (
      error instanceof SourceDiscoveryError ||
      error instanceof OpenApiOperationError ||
      error instanceof OpenApiPreparationError ||
      error instanceof OpenApiCallError
    )
      return context.error({
        code: error.code,
        message: sanitizeDeep(
          error instanceof SourceDiscoveryError && error.candidates.length > 0
            ? `${error.message}\n${error.candidates.join('\n')}`
            : error.message,
        ),
        retryable: false,
      });
    return context.error({
      code: 'OPENAPI_READ_FAILED',
      message: 'Unable to read the public OpenAPI document. Check its URL and JSON OpenAPI 3.x content.',
      retryable: false,
    });
  }
}

export function createOpenApiCli(
  discovery: Pick<SourceDiscovery, 'inspect'> = new SourceDiscovery(),
  request?: PublicDocumentFetch,
) {
  const cli = Cli.create('openapi', {
    description: 'Discover, prepare, and call OpenAPI operations. Payments require an explicit payment command.',
  });
  const operations = Cli.create('operations', {
    description: 'List, inspect, prepare, and call operations from the full OpenAPI document.',
  });
  const read = async (source: string, refresh: boolean) => {
    const result = await discovery.inspect(source, { format: 'openapi', refresh, signal: AbortSignal.timeout(60_000) });
    if (result.sourceType !== 'openapi') throw new TypeError('Expected OpenAPI source.');
    return sanitizeDeep(result.document);
  };
  operations.command('list', {
    args: documentArgs,
    description: 'List all operations advertised by an OpenAPI document.',
    mcp: mcpTool('openapi_operations_list'),
    options: listOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return readCommand(c, async () => {
        const document = await read(c.args.source, c.options.refresh);
        if (!c.agent && !c.formatExplicit) await renderInkUntilExit(<OperationsView document={document} />);
        return {
          source: { type: 'openapi', url: document.sourceUrl },
          title: document.title,
          openapi: document.version,
          items: document.operations.map(({ method, path, operationId, summary, payment }) => ({
            method,
            path,
            ...(operationId === undefined ? {} : { operationId }),
            ...(summary === undefined ? {} : { summary }),
            ...(payment === undefined ? {} : { payment }),
          })),
          limitations: document.limitations,
        };
      });
    },
  });
  operations.command('get', {
    args: documentArgs,
    description: 'Inspect one operation without invoking it or obtaining credentials.',
    mcp: mcpTool('openapi_operations_get'),
    options: getOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return readCommand(c, async () => {
        const document = await read(c.args.source, c.options.refresh);
        const operation = selectOpenApiOperation(document, c.options);
        if (!c.agent && !c.formatExplicit)
          await renderInkUntilExit(
            <Box flexDirection="column">
              <Text>Document: {document.sourceUrl}</Text>
              <OperationView operation={operation} />
            </Box>,
          );
        return { source: { type: 'openapi', url: document.sourceUrl }, operation, limitations: document.limitations };
      });
    },
  });
  operations.command('prepare', {
    args: documentArgs,
    description: 'Construct a request preview without invoking the operation, enrolling, or paying.',
    mcp: mcpTool('openapi_operations_prepare'),
    options: prepareOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return readCommand(c, async () => {
        const input = {
          ...c.options,
          headers: requestHeaders(c.options.header),
          parameters: jsonObject(c.options.parameters, '--parameters'),
          serverVariables: jsonObject(c.options.serverVariables, '--server-variables'),
        };
        const document = await read(c.args.source, c.options.refresh);
        const prepared = prepareOpenApiRequest(document, input);
        const operation = selectOpenApiOperation(document, input);
        const preview = sanitizeDeep({
          ...previewOpenApiRequest(prepared, operation),
          payment: operation.payment,
          next: openApiHandoff(prepared, operation, operation.payment?.protocols ?? []),
        });
        if (!c.agent && !c.formatExplicit) await renderInkUntilExit(<PreparedRequestView preview={preview} />);
        return preview;
      });
    },
  });
  operations.command('call', {
    args: documentArgs,
    description: 'Call an operation once, or direct an advertised paid operation to an explicit payment command.',
    mcp: mcpTool('openapi_operations_call'),
    options: callOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      const result = await readCommand(c, async () => {
        const document = await read(c.args.source, c.options.refresh);
        return callOpenApiOperation(
          document,
          {
            ...c.options,
            headers: requestHeaders(c.options.header),
            parameters: jsonObject(c.options.parameters, '--parameters'),
            serverVariables: jsonObject(c.options.serverVariables, '--server-variables'),
          },
          request,
        );
      });
      if (result.outcome === 'http-error')
        return c.error({
          code: 'OPENAPI_HTTP_ERROR',
          message: `The operation returned HTTP ${result.status}. Redirects are not followed automatically.`,
          details: result,
          retryable: false,
        });
      if (!c.agent && !c.formatExplicit) await renderInkUntilExit(<CallView result={result} />);
      return result;
    },
  });
  cli.command(operations);
  return cli;
}
