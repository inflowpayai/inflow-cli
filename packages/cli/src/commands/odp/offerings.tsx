import {
  type DirectoryService,
  type FederatedOfferingSearchRequest,
  type FilterDefinition,
  type IOdpResource,
  type OdpServiceOptions,
  type OfferingDetails,
  type OfferingPage,
  type OfferingSearchOptions,
  type ResolvedSortDefinition,
  type SearchCapabilityCatalog,
  type ServiceInspection,
  type TerseOffering,
} from '@inflowpayai/inflow-core';
import { Cli } from 'incur';
import { Box, Text } from 'ink';
import React from 'react';
import { odpServiceFailure, requireServiceOperation } from './service.js';
import { mcpTool } from '../../mcp-metadata.js';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { Table, type TableColumn } from '../../utils/table.js';
import {
  offeringCapabilitiesArgs,
  offeringCapabilitiesOptions,
  offeringDiscoverArgs,
  offeringDiscoverOptions,
  offeringGetArgs,
  offeringGetOptions,
  offeringListArgs,
  offeringListOptions,
  offeringSearchArgs,
  offeringSearchOptions,
} from './schema.js';
import { executeOdpCommand, odpCommandError } from './command.js';
import {
  absoluteReference,
  attributeDetails,
  Continuation,
  detail,
  DetailsTable,
  formatPrice,
  listed,
  pricePreviewDetails,
  shellQuote,
  summarize,
  type DetailRow,
} from './presentation.js';

interface CommandContext {
  agent: boolean;
  formatExplicit: boolean;
  error(error: { code: string; message: string; exitCode?: number; retryable?: boolean }): never;
}

interface OfferingSequence {
  pages: AsyncIterable<OfferingPage<TerseOffering>>;
}

interface OfferingClient {
  continueListOfferings(next: string, options: { maxPages: 1; representation: 'terse' }): OfferingSequence;
  continueSearchOfferings(next: string, options: { maxPages: 1; representation: 'terse' }): OfferingSequence;
  getOffering(id: string, options: { representation: 'full' }): Promise<OfferingDetails>;
  getOfferingSearchCapabilities(collectionId?: string): Promise<SearchCapabilityCatalog>;
  inspect(): Promise<ServiceInspection>;
  listCollectionOfferings(
    collectionId: string,
    options: { limit?: number; maxPages: 1; representation: 'terse' },
  ): OfferingSequence;
  listOfferings(options: { limit?: number; maxPages: 1; representation: 'terse' }): OfferingSequence;
  searchOfferings(options: OfferingSearchOptions & { maxPages: 1; representation: 'terse' }): OfferingSequence;
}

interface OfferingResource {
  searchOfferingsAcrossServices(
    request?: FederatedOfferingSearchRequest,
  ): ReturnType<IOdpResource['searchOfferingsAcrossServices']>;
  service(options: OdpServiceOptions): OfferingClient;
}

interface OfferingPageInput {
  collectionId: string | undefined;
  filters: unknown[];
  includeDescendants: boolean | undefined;
  language: string | undefined;
  limit: number | undefined;
  next: string | undefined;
  query: string | undefined;
  refinements: string[];
  service: string;
  sort: string | undefined;
}

export interface OfferingCapabilitiesResult {
  filters: FilterDefinition[];
  issues: SearchCapabilityCatalog['issues'];
  service_origin: string;
  sorts: ResolvedSortDefinition[];
}

export type OfferingPageResult = OfferingPage<TerseOffering> & { service_origin: string };
export type OfferingResult = { offering: OfferingDetails; service_origin: string };

interface DiscoveryInput {
  collectionId: string | undefined;
  concurrency: number | undefined;
  filters: unknown[];
  includeDescendants: boolean | undefined;
  keywords: string[];
  maxOfferingsPerService: number | undefined;
  maxServices: number | undefined;
  enrollment: 'aep'[];
  operations: OfferingDiscoverOperation[];
  payments: Array<'mpp' | 'x402'>;
  query: string | undefined;
  refinements: string[];
  serviceQuery: string | undefined;
  sort: string | undefined;
}

type OfferingDiscoverOperation =
  | 'get-collection'
  | 'get-offering'
  | 'list-collection-offerings'
  | 'list-collections'
  | 'list-offerings'
  | 'search-collections'
  | 'search-offerings';

async function present(c: CommandContext, view: React.ReactElement): Promise<void> {
  if (c.agent || c.formatExplicit) return;
  await renderInkUntilExit(view);
}

function client(resource: OfferingResource, service: string, language?: string): OfferingClient {
  return resource.service({ serviceUrl: service, ...(language === undefined ? {} : { acceptLanguage: language }) });
}

function serviceOrigin(service: string): string {
  return new URL(service).origin;
}

async function firstPage(sequence: OfferingSequence): Promise<OfferingPage<TerseOffering>> {
  for await (const page of sequence.pages) return page;
  return { items: [], odp_version: '1.0' };
}

function inputFailure(code: string, message: string): never {
  return odpCommandError({ code, exitCode: 2, message });
}

function parseFilters(values: string[]): unknown[] {
  return values.map((value) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return inputFailure('ODP_FILTER_JSON_INVALID', '--filter must contain a valid JSON object.');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return inputFailure('ODP_FILTER_JSON_INVALID', '--filter must contain a valid JSON object.');
    }
    return parsed;
  });
}

export async function runOfferingList(
  resource: OfferingResource,
  input: OfferingPageInput,
): Promise<OfferingPageResult> {
  if (input.next !== undefined && (input.collectionId !== undefined || input.limit !== undefined)) {
    return inputFailure('ODP_OFFERING_NEXT_CONFLICT', '--next cannot be combined with --collection-id or --limit.');
  }
  try {
    const service = client(resource, input.service, input.language);
    if (input.next !== undefined) {
      const page = await firstPage(service.continueListOfferings(input.next, { maxPages: 1, representation: 'terse' }));
      return { ...page, service_origin: serviceOrigin(input.service) };
    }
    const options = {
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      maxPages: 1 as const,
      representation: 'terse' as const,
    };
    await requireServiceOperation(
      service,
      input.collectionId === undefined ? 'list-offerings' : 'list-collection-offerings',
    );
    const page = await firstPage(
      input.collectionId === undefined
        ? service.listOfferings(options)
        : service.listCollectionOfferings(input.collectionId, options),
    );
    return { ...page, service_origin: serviceOrigin(input.service) };
  } catch (error) {
    return odpServiceFailure(error, 'ODP_OFFERING_LIST_FAILED', 'ODP Offering listing failed.', 'ODP_INSPECT_FAILED');
  }
}

export async function runOfferingSearch(
  resource: OfferingResource,
  input: OfferingPageInput,
): Promise<OfferingPageResult> {
  if (
    input.next !== undefined &&
    (input.collectionId !== undefined ||
      input.filters.length > 0 ||
      input.includeDescendants !== undefined ||
      input.limit !== undefined ||
      input.query !== undefined ||
      input.refinements.length > 0 ||
      input.sort !== undefined)
  ) {
    return inputFailure('ODP_OFFERING_NEXT_CONFLICT', '--next cannot be combined with a new Offering search.');
  }
  if (input.next === undefined && input.query === undefined && input.filters.length === 0) {
    return inputFailure(
      'ODP_OFFERING_SEARCH_INPUT_REQUIRED',
      'A query or --filter is required. Use `offerings list` for an unconstrained request.',
    );
  }
  try {
    const service = client(resource, input.service, input.language);
    if (input.next !== undefined) {
      const page = await firstPage(
        service.continueSearchOfferings(input.next, { maxPages: 1, representation: 'terse' }),
      );
      return { ...page, service_origin: serviceOrigin(input.service) };
    }
    await requireServiceOperation(service, 'search-offerings', {
      command:
        input.collectionId === undefined
          ? 'inflow odp offerings list <service>'
          : 'inflow odp offerings list <service> --collection-id <collection-id>',
      operation: input.collectionId === undefined ? 'list-offerings' : 'list-collection-offerings',
    });
    const page = await firstPage(
      service.searchOfferings({
        ...(input.collectionId === undefined ? {} : { collection_id: input.collectionId }),
        ...(input.filters.length === 0 ? {} : { filters: input.filters }),
        ...(input.includeDescendants === undefined ? {} : { include_descendants: input.includeDescendants }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        maxPages: 1,
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.refinements.length === 0 ? {} : { refinements: input.refinements }),
        representation: 'terse',
        ...(input.sort === undefined ? {} : { sort: input.sort }),
      }),
    );
    return { ...page, service_origin: serviceOrigin(input.service) };
  } catch (error) {
    return odpServiceFailure(error, 'ODP_OFFERING_SEARCH_FAILED', 'ODP Offering search failed.', 'ODP_INSPECT_FAILED');
  }
}

export async function runOfferingCapabilities(
  resource: OfferingResource,
  service: string,
  collectionId?: string,
  language?: string,
): Promise<OfferingCapabilitiesResult> {
  try {
    const catalog = await client(resource, service, language).getOfferingSearchCapabilities(collectionId);
    return {
      filters: [...catalog.filters.values()],
      issues: catalog.issues,
      service_origin: serviceOrigin(service),
      sorts: [...catalog.sorts.values()],
    };
  } catch (error) {
    return odpServiceFailure(
      error,
      'ODP_OFFERING_CAPABILITIES_FAILED',
      'ODP Offering search capability resolution failed.',
      'ODP_INSPECT_FAILED',
    );
  }
}

function requiredDiscoveryOperation(input: DiscoveryInput): OfferingDiscoverOperation {
  if (
    input.query !== undefined ||
    input.filters.length > 0 ||
    input.includeDescendants !== undefined ||
    input.refinements.length > 0 ||
    input.sort !== undefined
  ) {
    return 'search-offerings';
  }
  return input.collectionId === undefined ? 'list-offerings' : 'list-collection-offerings';
}

export async function runOfferingGet(
  resource: OfferingResource,
  service: string,
  id: string,
  language?: string,
): Promise<OfferingResult> {
  try {
    const serviceClient = client(resource, service, language);
    await requireServiceOperation(serviceClient, 'get-offering');
    const offering = await serviceClient.getOffering(id, { representation: 'full' });
    return { offering, service_origin: serviceOrigin(service) };
  } catch (error) {
    return odpServiceFailure(error, 'ODP_OFFERING_GET_FAILED', 'ODP Offering retrieval failed.', 'ODP_INSPECT_FAILED');
  }
}

export async function runOfferingDiscovery(
  resource: OfferingResource,
  input: DiscoveryInput,
): Promise<{ items: Array<{ service: DirectoryService; offering: TerseOffering }> }> {
  try {
    const operations = input.operations.length === 0 ? [requiredDiscoveryOperation(input)] : input.operations;
    const serviceFilters = {
      ...(input.keywords.length === 0 ? {} : { keywords: input.keywords }),
      ...(input.enrollment.length === 0 ? {} : { enrollment: input.enrollment.map((name) => ({ name })) }),
      operations: operations.map((name) => ({ name })),
      ...(input.payments.length === 0 ? {} : { payments: input.payments.map((name) => ({ name })) }),
    };
    const services = {
      ...(input.serviceQuery === undefined ? {} : { query: input.serviceQuery }),
      ...(Object.keys(serviceFilters).length === 0 ? {} : { filters: serviceFilters }),
    };
    const request: FederatedOfferingSearchRequest = {
      ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
      ...(input.maxOfferingsPerService === undefined ? {} : { maxOfferingsPerService: input.maxOfferingsPerService }),
      ...(input.maxServices === undefined ? {} : { maxServices: input.maxServices }),
      offerings: {
        ...(input.collectionId === undefined ? {} : { collection_id: input.collectionId }),
        ...(input.filters.length === 0 ? {} : { filters: input.filters }),
        ...(input.includeDescendants === undefined ? {} : { include_descendants: input.includeDescendants }),
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.refinements.length === 0 ? {} : { refinements: input.refinements }),
        ...(input.sort === undefined ? {} : { sort: input.sort }),
      },
      ...(Object.keys(services).length === 0 ? {} : { services }),
    };
    const items: Array<{ service: DirectoryService; offering: TerseOffering }> = [];
    for await (const event of resource.searchOfferingsAcrossServices(request)) {
      if (event.type === 'offering') items.push({ offering: event.offering, service: event.service });
    }
    return { items };
  } catch (error) {
    return odpServiceFailure(
      error,
      'ODP_OFFERING_DISCOVERY_FAILED',
      'ODP Offering discovery failed.',
      'ODP_INSPECT_FAILED',
    );
  }
}

interface OfferingRow {
  description: string;
  id: string;
  name: string;
  price: string;
}

const OFFERING_COLUMNS: ReadonlyArray<TableColumn<OfferingRow>> = [
  { header: 'Name', cell: (row) => row.name },
  { header: 'Price', cell: (row) => row.price },
  { header: 'Description', cell: (row) => row.description },
  { header: 'ID', cell: (row) => row.id },
];

interface ActionRow {
  action: string;
  authentication: string;
  method: string;
  relationship: string;
  target: string;
}

const ACTION_COLUMNS: ReadonlyArray<TableColumn<ActionRow>> = [
  { header: 'Action ID', cell: (row) => row.action },
  { header: 'Relationship', cell: (row) => row.relationship },
  { header: 'Authentication', cell: (row) => row.authentication },
  { header: 'Method', cell: (row) => row.method },
  { header: 'Target', cell: (row) => row.target },
];

function authenticationLabel(value: 'not-required' | 'optional' | 'required'): string {
  if (value === 'not-required') return 'Not required';
  return value === 'optional' ? 'Optional' : 'Required';
}

export function OfferingsView({
  command,
  next,
  offerings,
  service,
}: {
  command: 'list' | 'search';
  next?: string;
  offerings: TerseOffering[];
  service: string;
}) {
  if (offerings.length === 0) return <Text dimColor>No Offerings found.</Text>;
  const rows = offerings.map((offering) => ({
    description: summarize(offering.description ?? '', 64),
    id: offering.id,
    name: offering.name,
    price: formatPrice(offering.price),
  }));
  return (
    <Box flexDirection="column">
      <Text bold>Offerings</Text>
      <Table columns={OFFERING_COLUMNS} rows={rows} />
      {next === undefined ? null : (
        <Continuation command={`inflow odp offerings ${command} ${shellQuote(service)}`} next={next} />
      )}
    </Box>
  );
}

export function OfferingView({ offering, serviceOrigin }: { offering: OfferingDetails; serviceOrigin: string }) {
  const rows: DetailRow[] = [
    ...detail('Name', offering.name),
    ...detail('ID', offering.id),
    ...(offering.description === undefined ? [] : detail('Description', offering.description)),
    ...(offering.web_url === undefined ? [] : detail('Browser', absoluteReference(offering.web_url, serviceOrigin))),
    ...detail('Collections', listed(offering.collection_ids ?? [])),
    ...(offering.language === undefined ? [] : detail('Language', offering.language)),
    ...(offering.localizations === undefined || offering.localizations.length === 0
      ? []
      : detail('Localizations', listed(offering.localizations))),
    ...(offering.schema === undefined
      ? []
      : detail('Attribute schema', absoluteReference(offering.schema.url, serviceOrigin))),
  ];
  const price = pricePreviewDetails(offering.price);
  const attributes = attributeDetails(offering.attributes, offering.attribute_schema, serviceOrigin);
  const actions: ActionRow[] = (offering.actions ?? []).map((action) => ({
    action: action.id,
    authentication: authenticationLabel(action.authentication),
    method: action.target.kind === 'http' ? action.target.method : 'OpenAPI',
    relationship: action.rel,
    target:
      action.target.kind === 'http'
        ? absoluteReference(action.target.url, serviceOrigin)
        : `${absoluteReference(action.target.url, serviceOrigin)}#operationId=${encodeURIComponent(action.target.operation_id)}`,
  }));
  const issueColumns: ReadonlyArray<TableColumn<NonNullable<OfferingDetails['issues']>[number]>> = [
    { header: 'Scope', cell: (issue) => issue.scope },
    { header: 'Action', cell: (issue) => issue.action_id ?? 'None' },
    { header: 'Message', cell: (issue) => issue.message },
  ];
  return (
    <Box flexDirection="column">
      <Text bold>Offering</Text>
      <DetailsTable rows={rows} />
      {price.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Price Preview</Text>
          <DetailsTable rows={price} />
        </Box>
      )}
      {attributes.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Attributes</Text>
          <DetailsTable rows={attributes} />
        </Box>
      )}
      {actions.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Available Actions</Text>
          <Table columns={ACTION_COLUMNS} rows={actions} />
        </Box>
      )}
      {offering.issues === undefined || offering.issues.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Issues</Text>
          <Table columns={issueColumns} rows={offering.issues} />
        </Box>
      )}
    </Box>
  );
}

export function DiscoveryView({ items }: { items: Array<{ service: DirectoryService; offering: TerseOffering }> }) {
  if (items.length === 0) return <Text dimColor>No Offerings found.</Text>;
  const rows = items.map(({ offering, service }) => ({
    offering: offering.name,
    price: formatPrice(offering.price),
    service: service.name,
    origin: service.service_origin,
  }));
  const columns: ReadonlyArray<TableColumn<(typeof rows)[number]>> = [
    { header: 'Offering', cell: (row) => row.offering },
    { header: 'Price', cell: (row) => row.price },
    { header: 'Service', cell: (row) => row.service },
    { header: 'Origin', cell: (row) => row.origin },
  ];
  return (
    <Box flexDirection="column">
      <Text bold>Discovered Offerings</Text>
      <Table columns={columns} rows={rows} />
    </Box>
  );
}

export function OfferingCapabilitiesView({ result }: { result: OfferingCapabilitiesResult }) {
  const filters = result.filters.map((filter) => ({
    id: filter.id,
    operators: filter.operators.join(', '),
    title: filter.title,
    type: filter.type,
    unit: filter.unit === undefined ? 'None' : filter.unit.code,
  }));
  const filterColumns: ReadonlyArray<TableColumn<(typeof filters)[number]>> = [
    { header: 'ID', cell: (row) => row.id },
    { header: 'Title', cell: (row) => row.title },
    { header: 'Type', cell: (row) => row.type },
    { header: 'Operators', cell: (row) => row.operators },
    { header: 'Unit', cell: (row) => row.unit },
  ];
  const sorts = result.sorts.map((sort) => ({
    id: sort.id,
    keys: sort.keys.map((key) => `${key.filter_id} ${key.direction}`).join(', '),
    title: sort.title,
  }));
  const sortColumns: ReadonlyArray<TableColumn<(typeof sorts)[number]>> = [
    { header: 'ID', cell: (row) => row.id },
    { header: 'Title', cell: (row) => row.title },
    { header: 'Keys', cell: (row) => row.keys },
  ];
  const issueColumns: ReadonlyArray<TableColumn<(typeof result.issues)[number]>> = [
    { header: 'Scope', cell: (row) => row.scope },
    { header: 'Kind', cell: (row) => row.kind },
    { header: 'Message', cell: (row) => row.message },
  ];
  return (
    <Box flexDirection="column">
      <Text bold>Offering search capabilities</Text>
      {filters.length === 0 ? (
        <Text dimColor>No filters advertised.</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Filters</Text>
          <Table columns={filterColumns} rows={filters} />
        </Box>
      )}
      {sorts.length === 0 ? (
        <Text dimColor>No sorts advertised.</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Sorts</Text>
          <Table columns={sortColumns} rows={sorts} />
        </Box>
      )}
      {result.issues.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Issues</Text>
          <Table columns={issueColumns} rows={result.issues} />
        </Box>
      )}
    </Box>
  );
}

export function createOfferingsCli(resource: OfferingResource) {
  const cli = Cli.create('offerings', { description: 'Find and inspect offerings.' });

  cli.command('capabilities', {
    args: offeringCapabilitiesArgs,
    description: 'Resolve offering search filters and sorts.',
    mcp: mcpTool('odp_offerings_capabilities'),
    options: offeringCapabilitiesOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return executeOdpCommand(
        c,
        () => runOfferingCapabilities(resource, c.args.service, c.options.collectionId, c.options.language),
        (result) => present(c, <OfferingCapabilitiesView result={result} />),
        {
          code: 'ODP_OFFERING_CAPABILITIES_FAILED',
          message: 'ODP Offering search capability resolution failed.',
          retryable: false,
        },
      );
    },
  });

  cli.command('list', {
    args: offeringListArgs,
    description: 'List offerings from a service.',
    mcp: mcpTool('odp_offerings_list'),
    options: offeringListOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return executeOdpCommand(
        c,
        () =>
          runOfferingList(resource, {
            collectionId: c.options.collectionId,
            filters: [],
            includeDescendants: undefined,
            language: c.options.language,
            limit: c.options.limit,
            next: c.options.next,
            query: undefined,
            refinements: [],
            service: c.args.service,
            sort: undefined,
          }),
        (result) =>
          present(
            c,
            <OfferingsView
              command="list"
              {...(result.next === undefined ? {} : { next: result.next })}
              offerings={result.items}
              service={c.args.service}
            />,
          ),
        { code: 'ODP_OFFERING_LIST_FAILED', message: 'ODP Offering listing failed.', retryable: false },
      );
    },
  });

  cli.command('search', {
    args: offeringSearchArgs,
    description: 'Search offerings from a service.',
    mcp: mcpTool('odp_offerings_search'),
    options: offeringSearchOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return executeOdpCommand(
        c,
        () =>
          runOfferingSearch(resource, {
            collectionId: c.options.collectionId,
            filters: parseFilters(c.options.filter),
            includeDescendants: c.options.includeDescendants,
            language: c.options.language,
            limit: c.options.limit,
            next: c.options.next,
            query: c.args.query,
            refinements: c.options.refinement,
            service: c.args.service,
            sort: c.options.sort,
          }),
        (result) =>
          present(
            c,
            <OfferingsView
              command="search"
              {...(result.next === undefined ? {} : { next: result.next })}
              offerings={result.items}
              service={c.args.service}
            />,
          ),
        { code: 'ODP_OFFERING_SEARCH_FAILED', message: 'ODP Offering search failed.', retryable: false },
      );
    },
  });

  cli.command('get', {
    args: offeringGetArgs,
    description: 'Get full offering details.',
    mcp: mcpTool('odp_offerings_get'),
    options: offeringGetOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return executeOdpCommand(
        c,
        () => runOfferingGet(resource, c.args.service, c.args.id, c.options.language),
        (result) => present(c, <OfferingView offering={result.offering} serviceOrigin={result.service_origin} />),
        { code: 'ODP_OFFERING_GET_FAILED', message: 'ODP Offering retrieval failed.', retryable: false },
      );
    },
  });

  cli.command('discover', {
    args: offeringDiscoverArgs,
    description: 'Find offerings across services selected from the directory.',
    mcp: mcpTool('odp_offerings_discover'),
    options: offeringDiscoverOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return executeOdpCommand(
        c,
        () =>
          runOfferingDiscovery(resource, {
            collectionId: c.options.collectionId,
            concurrency: c.options.concurrency,
            filters: parseFilters(c.options.filter),
            includeDescendants: c.options.includeDescendants,
            keywords: c.options.keyword,
            maxOfferingsPerService: c.options.maxOfferingsPerService,
            maxServices: c.options.maxServices,
            enrollment: c.options.enrollment,
            operations: c.options.operation,
            payments: c.options.payment,
            query: c.args.query,
            refinements: c.options.refinement,
            serviceQuery: c.options.serviceQuery,
            sort: c.options.sort,
          }),
        (result) => present(c, <DiscoveryView items={result.items} />),
        { code: 'ODP_OFFERING_DISCOVERY_FAILED', message: 'ODP Offering discovery failed.', retryable: false },
      );
    },
  });

  return cli;
}

export const __testing = {
  parseFilters,
  runOfferingCapabilities,
  runOfferingDiscovery,
  runOfferingGet,
  runOfferingList,
  runOfferingSearch,
};
