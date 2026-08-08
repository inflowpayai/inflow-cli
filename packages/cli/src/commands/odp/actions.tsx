import { type OdpServiceOptions, type ResolvedAction, type ServiceInspection } from '@inflowpayai/inflow-core';
import { Cli } from 'incur';
import { Box, Text } from 'ink';
import React from 'react';
import { odpServiceFailure, requireServiceOperation } from './service.js';
import { mcpTool } from '../../mcp-metadata.js';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { Table, type TableColumn } from '../../utils/table.js';
import { actionResolveArgs } from './schema.js';
import { executeOdpCommand } from './command.js';
import { absoluteReference, detail, DetailsTable, listed, record, type DetailRow } from './presentation.js';

interface CommandContext {
  agent: boolean;
  formatExplicit: boolean;
  error(error: { code: string; message: string; exitCode?: number; retryable?: boolean }): never;
}

interface ActionClient {
  inspect(): Promise<ServiceInspection>;
  resolveAction(offeringId: string, actionId: string): Promise<ResolvedAction>;
}

interface ActionResource {
  service(options: OdpServiceOptions): ActionClient;
}

export type ActionResolution = ResolvedAction & {
  offering_id: string;
  service_origin: string;
};

interface ActionInputRow {
  allowed: string;
  description: string;
  name: string;
  required: string;
  type: string;
}

const ACTION_INPUT_COLUMNS: ReadonlyArray<TableColumn<ActionInputRow>> = [
  { header: 'Input', cell: (row) => row.name },
  { header: 'Type', cell: (row) => row.type },
  { header: 'Required', cell: (row) => row.required },
  { header: 'Allowed Values', cell: (row) => row.allowed },
  { header: 'Description', cell: (row) => row.description },
];

function actionInputs(schema: Record<string, unknown> | undefined): ActionInputRow[] {
  const properties = record(schema?.['properties']);
  if (properties === undefined) return [];
  const required = new Set(
    Array.isArray(schema?.['required']) ? schema['required'].filter((value) => typeof value === 'string') : [],
  );
  return Object.keys(properties)
    .sort()
    .map((name) => {
      const definition = record(properties[name]);
      const allowed = Array.isArray(definition?.['enum'])
        ? definition['enum'].map((value) => String(value)).join(', ')
        : 'Not constrained';
      const description = definition?.['description'];
      const type = definition?.['type'];
      return {
        allowed,
        description: typeof description === 'string' ? description : '',
        name,
        required: required.has(name) ? 'Yes' : 'No',
        type: typeof type === 'string' ? type : 'Not advertised',
      };
    });
}

async function present(c: CommandContext, view: React.ReactElement): Promise<void> {
  if (c.agent || c.formatExplicit) return;
  await renderInkUntilExit(view);
}

export async function runActionResolve(
  resource: ActionResource,
  service: string,
  offeringId: string,
  actionId: string,
): Promise<ActionResolution> {
  try {
    const serviceOrigin = new URL(service).origin;
    const serviceClient = resource.service({ serviceUrl: service });
    await requireServiceOperation(serviceClient, 'get-offering');
    const resolved = await serviceClient.resolveAction(offeringId, actionId);
    return { ...resolved, offering_id: offeringId, service_origin: serviceOrigin };
  } catch (error) {
    return odpServiceFailure(error, 'ODP_ACTION_RESOLVE_FAILED', 'ODP Action resolution failed.', 'ODP_INSPECT_FAILED');
  }
}

export function ActionView({ resolution }: { resolution: ActionResolution }) {
  const { action } = resolution;
  const rows: DetailRow[] = [
    ...detail('Action ID', action.id),
    ...detail('Offering ID', resolution.offering_id),
    ...detail('Relationship', action.rel),
    ...detail(
      'Authentication',
      action.authentication === 'not-required'
        ? 'Not required'
        : action.authentication === 'optional'
          ? 'Optional'
          : 'Required',
    ),
    ...(action.description === undefined ? [] : detail('Description', action.description)),
    ...detail('Type', action.target.kind === 'http' ? 'HTTP' : 'OpenAPI'),
    ...(action.target.kind === 'http'
      ? [
          ...detail('Method', action.target.method),
          ...detail('Target', absoluteReference(action.target.url, resolution.service_origin)),
          ...(action.target.request?.content_type === undefined
            ? []
            : detail('Request content type', action.target.request.content_type)),
          ...(action.target.request?.schema === undefined
            ? []
            : detail('Request schema', absoluteReference(action.target.request.schema.url, resolution.service_origin))),
          ...detail('Response content types', listed(action.target.response_content_types ?? [])),
        ]
      : [
          ...detail('Operation', action.target.operation_id),
          ...detail('OpenAPI document', absoluteReference(action.target.url, resolution.service_origin)),
        ]),
  ];
  const inputs = 'request_schema' in resolution ? actionInputs(resolution.request_schema) : [];
  return (
    <Box flexDirection="column">
      <Text bold>Resolved Action</Text>
      <DetailsTable rows={rows} />
      {inputs.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Action Inputs</Text>
          <Table columns={ACTION_INPUT_COLUMNS} rows={inputs} />
        </Box>
      )}
    </Box>
  );
}

export function createActionsCli(resource: ActionResource) {
  const cli = Cli.create('actions', { description: 'Inspect executable requests advertised by offerings.' });
  cli.command('resolve', {
    args: actionResolveArgs,
    description: "Resolve an offering's action into an executable request without invoking it.",
    mcp: mcpTool('odp_actions_resolve'),
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return executeOdpCommand(
        c,
        () => runActionResolve(resource, c.args.service, c.args.offeringId, c.args.actionId),
        (result) => present(c, <ActionView resolution={result} />),
        { code: 'ODP_ACTION_RESOLVE_FAILED', message: 'ODP Action resolution failed.', retryable: false },
      );
    },
  });
  return cli;
}

export const __testing = { runActionResolve };
