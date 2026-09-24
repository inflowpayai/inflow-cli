import {
  OpenApiOperationError,
  SourceDiscovery,
  SourceDiscoveryError,
  sanitizeDeep,
  selectOpenApiOperation,
  type OpenApiDescription,
  type OpenApiOperation,
} from '@inflowpayai/inflow-core';
import { Cli } from 'incur';
import { Box, Text } from 'ink';
import { mcpTool } from '../../mcp-metadata.js';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { Table } from '../../utils/table.js';
import { documentArgs, getOptions, listOptions } from './schema.js';

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
      <Text>{JSON.stringify(operation.servers, null, 2)}</Text>
      <Text bold>Parameters</Text>
      <Text>{JSON.stringify(operation.parameters, null, 2)}</Text>
      <Text bold>Request body</Text>
      <Text>
        {operation.requestBody === undefined ? 'Not declared' : JSON.stringify(operation.requestBody, null, 2)}
      </Text>
      <Text bold>Declared authentication</Text>
      <Text>{JSON.stringify(operation.security, null, 2)}</Text>
      <Text>{JSON.stringify(operation.securitySchemes, null, 2)}</Text>
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
    if (error instanceof SourceDiscoveryError || error instanceof OpenApiOperationError)
      return context.error({
        code: error.code,
        message:
          error instanceof SourceDiscoveryError && error.candidates.length > 0
            ? `${error.message}\n${error.candidates.join('\n')}`
            : error.message,
        retryable: false,
      });
    return context.error({
      code: 'OPENAPI_READ_FAILED',
      message: 'Unable to read the public OpenAPI document. Check its URL and JSON OpenAPI 3.x content.',
      retryable: false,
    });
  }
}

export function createOpenApiCli(discovery: Pick<SourceDiscovery, 'inspect'> = new SourceDiscovery()) {
  const cli = Cli.create('openapi', {
    description: 'Read public OpenAPI documents without invoking their operations.',
  });
  const operations = Cli.create('operations', {
    description: 'List and inspect operations from the full OpenAPI document.',
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
          items: document.operations.map(({ method, path, operationId, summary }) => ({
            method,
            path,
            ...(operationId === undefined ? {} : { operationId }),
            ...(summary === undefined ? {} : { summary }),
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
  cli.command(operations);
  return cli;
}
