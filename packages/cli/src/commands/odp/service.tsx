import {
  type Collection,
  type CollectionGetOptions,
  type CollectionListOptions,
  type CollectionSearchOptions,
  type CollectionSequence,
  type ContinuationOptions,
  type IOdpResource,
  type OdpServiceOptions,
  OdpInspectionError,
  OdpRequestError,
  type PageEnvelope,
  type ServiceInspection,
  type TerseCollection,
} from '@inflowpayai/inflow-core';
import { Cli } from 'incur';
import { Box, Text } from 'ink';
import React from 'react';
import { mapAepRuntimeError } from '../aep/runtime.js';
import { mcpTool } from '../../mcp-metadata.js';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { Table, type TableColumn } from '../../utils/table.js';
import {
  collectionGetArgs,
  collectionGetOptions,
  collectionListArgs,
  collectionListOptions,
  collectionSearchArgs,
  collectionSearchOptions,
} from './schema.js';
import { executeOdpCommand, OdpCommandError, odpCommandError } from './command.js';
import {
  absoluteReference,
  Continuation,
  detail,
  DetailsTable,
  listed,
  shellQuote,
  summarize,
  type DetailRow,
} from './presentation.js';
import { paymentProtocolLabel } from './payments.js';

interface CommandContext {
  agent: boolean;
  formatExplicit: boolean;
  error(error: { code: string; message: string; exitCode?: number; retryable?: boolean }): never;
}

interface CollectionPageInput {
  language: string | undefined;
  limit: number | undefined;
  next: string | undefined;
  parentId: string | undefined;
  query: string | undefined;
  service: string;
}

export type CollectionPageResult = PageEnvelope<TerseCollection> & { service_origin: string };
export type CollectionResult = { collection: Collection; service_origin: string };

interface ServiceInspectionClient {
  inspect(): Promise<ServiceInspection>;
}

interface CollectionClient extends ServiceInspectionClient {
  continueListCollections(
    next: string,
    options?: ContinuationOptions & { representation?: 'terse' },
  ): CollectionSequence<TerseCollection>;
  continueSearchCollections(
    next: string,
    options?: ContinuationOptions & { representation?: 'terse' },
  ): CollectionSequence<TerseCollection>;
  getCollection(id: string, options?: CollectionGetOptions & { representation?: 'full' }): Promise<Collection>;
  listCollections(options?: CollectionListOptions & { representation?: 'terse' }): CollectionSequence<TerseCollection>;
  searchCollections(
    options: CollectionSearchOptions & { representation?: 'terse' },
  ): CollectionSequence<TerseCollection>;
}

type OdpOperation = ServiceInspection['capabilities']['operations'][number]['name'];

interface OperationAlternative {
  command: string;
  operation: OdpOperation;
}

interface CollectionResource {
  service(options: OdpServiceOptions): CollectionClient;
}

async function present(c: CommandContext, view: React.ReactElement): Promise<void> {
  if (c.agent || c.formatExplicit) return;
  await renderInkUntilExit(view);
}

function client(resource: CollectionResource, service: string, language?: string): CollectionClient {
  return resource.service({ serviceUrl: service, ...(language === undefined ? {} : { acceptLanguage: language }) });
}

function serviceOrigin(service: string): string {
  return new URL(service).origin;
}

async function firstPage(sequence: {
  pages: AsyncIterable<PageEnvelope<TerseCollection>>;
}): Promise<PageEnvelope<TerseCollection>> {
  for await (const page of sequence.pages) return page;
  return { items: [], odp_version: '1.0' };
}

function inputFailure(code: string, message: string): never {
  return odpCommandError({ code, exitCode: 2, message });
}

export function odpServiceFailure(
  error: unknown,
  fallbackCode: string,
  message: string,
  inspectionCode?: string,
): never {
  if (error instanceof OdpCommandError) throw error;
  const authentication = mapAepRuntimeError(error);
  if (authentication !== undefined) return odpCommandError(authentication);
  if (error instanceof OdpInspectionError) {
    const codes: Record<OdpInspectionError['code'], string> = {
      aborted: 'ODP_REQUEST_ABORTED',
      http_error: 'ODP_INSPECT_HTTP_ERROR',
      invalid_json: 'ODP_INSPECT_JSON_INVALID',
      invalid_media_type: 'ODP_INSPECT_MEDIA_TYPE_INVALID',
      invalid_redirect: 'ODP_INSPECT_REDIRECT_REJECTED',
      response_too_large: 'ODP_INSPECT_RESPONSE_TOO_LARGE',
      validation_failed: 'ODP_INSPECT_DOCUMENT_INVALID',
    };
    return odpCommandError({
      code: inspectionCode ?? codes[error.code],
      message,
      retryable:
        error.code === 'aborted' ||
        (error.code === 'http_error' && (error.status === undefined || error.status === 429 || error.status >= 500)),
    });
  }
  if (error instanceof OdpRequestError) {
    return odpCommandError({ code: 'ODP_SERVICE_HTTP_ERROR', message, retryable: error.retryable });
  }
  return odpCommandError({ code: fallbackCode, message, retryable: false });
}

export async function requireServiceOperation(
  service: ServiceInspectionClient,
  operation: OdpOperation,
  alternative?: OperationAlternative,
): Promise<void> {
  const inspection = await service.inspect();
  const operations = inspection.capabilities.operations.map(({ name }) => name).sort();
  if (operations.includes(operation)) return;

  const advertised =
    operations.length === 0
      ? 'The Service advertises no ODP operations.'
      : `Advertised operations: ${operations.join(', ')}.`;
  const suggestion =
    alternative !== undefined && operations.includes(alternative.operation)
      ? ` Run \`${alternative.command}\` to browse the catalog instead.`
      : '';
  return odpCommandError({
    code: 'ODP_OPERATION_NOT_SUPPORTED',
    message: `This Service does not advertise ${operation}. ${advertised}${suggestion}`,
    retryable: false,
  });
}

export async function runInspect(
  resource: Pick<IOdpResource, 'inspect'>,
  service: string,
  language?: string,
): Promise<ServiceInspection> {
  try {
    return await resource.inspect({
      serviceUrl: service,
      ...(language === undefined ? {} : { acceptLanguage: language }),
    });
  } catch (error) {
    return odpServiceFailure(error, 'ODP_INSPECT_FAILED', 'ODP Service inspection failed.');
  }
}

async function runCollectionList(
  resource: CollectionResource,
  input: CollectionPageInput,
): Promise<CollectionPageResult> {
  if (input.next !== undefined && input.limit !== undefined) {
    return inputFailure('ODP_COLLECTION_NEXT_CONFLICT', '--next cannot be combined with --limit.');
  }
  try {
    const service = client(resource, input.service, input.language);
    if (input.next === undefined) await requireServiceOperation(service, 'list-collections');
    const page = await firstPage(
      input.next === undefined
        ? service.listCollections({
            representation: 'terse',
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            maxPages: 1,
          })
        : service.continueListCollections(input.next, { maxPages: 1, representation: 'terse' }),
    );
    return { ...page, service_origin: serviceOrigin(input.service) };
  } catch (error) {
    return odpServiceFailure(error, 'ODP_COLLECTION_LIST_FAILED', 'ODP Collection listing failed.');
  }
}

async function runCollectionSearch(
  resource: CollectionResource,
  input: CollectionPageInput,
): Promise<CollectionPageResult> {
  if (
    input.next !== undefined &&
    (input.query !== undefined || input.parentId !== undefined || input.limit !== undefined)
  ) {
    return inputFailure(
      'ODP_COLLECTION_NEXT_CONFLICT',
      '--next cannot be combined with a query, --parent-id, or --limit.',
    );
  }
  if (input.next === undefined && input.query === undefined && input.parentId === undefined) {
    return inputFailure(
      'ODP_COLLECTION_SEARCH_INPUT_REQUIRED',
      'A query or --parent-id is required. Use `collections list` for an unconstrained request.',
    );
  }
  try {
    const service = client(resource, input.service, input.language);
    if (input.next === undefined) {
      await requireServiceOperation(service, 'search-collections', {
        command: 'inflow odp collections list <service>',
        operation: 'list-collections',
      });
    }
    const page = await firstPage(
      input.next === undefined
        ? service.searchCollections({
            representation: 'terse',
            ...(input.query === undefined ? {} : { query: input.query }),
            ...(input.parentId === undefined ? {} : { parent_id: input.parentId }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            maxPages: 1,
          })
        : service.continueSearchCollections(input.next, { maxPages: 1, representation: 'terse' }),
    );
    return { ...page, service_origin: serviceOrigin(input.service) };
  } catch (error) {
    return odpServiceFailure(error, 'ODP_COLLECTION_SEARCH_FAILED', 'ODP Collection search failed.');
  }
}

async function runCollectionGet(
  resource: CollectionResource,
  service: string,
  id: string,
  language?: string,
): Promise<CollectionResult> {
  try {
    const serviceClient = client(resource, service, language);
    await requireServiceOperation(serviceClient, 'get-collection');
    const collection = await serviceClient.getCollection(id, { representation: 'full' });
    return { collection, service_origin: serviceOrigin(service) };
  } catch (error) {
    return odpServiceFailure(error, 'ODP_COLLECTION_GET_FAILED', 'ODP Collection retrieval failed.');
  }
}

function capabilityLabel(name: string, authentication: string): string {
  const requirement =
    authentication === 'not-required' ? 'no authentication required' : `authentication ${authentication}`;
  return `${name} (${requirement})`;
}

export function OdpDetailsTable({ inspection }: { inspection: ServiceInspection }) {
  const { capabilities, document } = inspection;
  const rows: DetailRow[] = [
    ...detail('Service URL', inspection.serviceOrigin),
    ...detail('Name', document.name),
    ...detail('Description', document.description),
    ...(document.website_url === undefined
      ? []
      : detail('Website', absoluteReference(document.website_url, inspection.serviceOrigin))),
    ...(document.documentation_url === undefined
      ? []
      : detail('Documentation', absoluteReference(document.documentation_url, inspection.serviceOrigin))),
    ...(document.support_url === undefined
      ? []
      : detail('Support', absoluteReference(document.support_url, inspection.serviceOrigin))),
    ...(document.status_url === undefined
      ? []
      : detail('Status', absoluteReference(document.status_url, inspection.serviceOrigin))),
    ...detail('ODP version', document.odp_version),
    ...detail('Language', document.language),
    ...(document.localizations.length === 0 ? [] : detail('Localizations', listed(document.localizations))),
    ...detail('Keywords', listed(document.keywords ?? [])),
    ...detail(
      'Operations',
      listed(capabilities.operations.map(({ authentication, name }) => capabilityLabel(name, authentication))),
    ),
    ...detail('Enrollment', listed(capabilities.enrollment.map(({ name }) => name))),
    ...detail(
      'Payments',
      listed(
        capabilities.payments.map((payment) => capabilityLabel(paymentProtocolLabel(payment), payment.authentication)),
      ),
    ),
  ];
  return <DetailsTable rows={rows} />;
}

export function InspectionView({ inspection }: { inspection: ServiceInspection }) {
  return (
    <Box flexDirection="column">
      <Text bold>ODP Service</Text>
      <OdpDetailsTable inspection={inspection} />
    </Box>
  );
}

interface CollectionRow {
  description: string;
  id: string;
  name: string;
  parents: string;
}

const COLLECTION_COLUMNS: ReadonlyArray<TableColumn<CollectionRow>> = [
  { header: 'Name', cell: (row) => row.name },
  { header: 'Description', cell: (row) => row.description },
  { header: 'Parent Collections', cell: (row) => row.parents },
  { header: 'ID', cell: (row) => row.id },
];

export function CollectionsView({
  command,
  page,
  service,
}: {
  command: 'list' | 'search';
  page: PageEnvelope<TerseCollection>;
  service: string;
}) {
  if (page.items.length === 0) return <Text dimColor>No Collections found.</Text>;
  const rows = page.items.map((collection) => ({
    description: summarize(collection.description ?? ''),
    id: collection.id,
    name: collection.name,
    parents: listed(collection.parent_ids ?? []),
  }));
  return (
    <Box flexDirection="column">
      <Text bold>Collections</Text>
      <Table columns={COLLECTION_COLUMNS} rows={rows} />
      {page.next === undefined ? null : (
        <Continuation command={`inflow odp collections ${command} ${shellQuote(service)}`} next={page.next} />
      )}
    </Box>
  );
}

export function CollectionView({ collection, serviceOrigin }: { collection: Collection; serviceOrigin: string }) {
  const filters = collection.search_capabilities?.filters;
  const sorts = collection.search_capabilities?.sorts;
  const rows: DetailRow[] = [
    ...detail('Name', collection.name),
    ...detail('ID', collection.id),
    ...(collection.description === undefined ? [] : detail('Description', collection.description)),
    ...(collection.web_url === undefined
      ? []
      : detail('Browser', absoluteReference(collection.web_url, serviceOrigin))),
    ...detail('Parent Collections', listed(collection.parent_ids ?? [])),
    ...(collection.language === undefined ? [] : detail('Language', collection.language)),
    ...(collection.localizations === undefined || collection.localizations.length === 0
      ? []
      : detail('Localizations', listed(collection.localizations))),
    ...(filters === undefined
      ? []
      : detail(
          'Search filters',
          'inline' in filters
            ? `${String(filters.inline.length)} inline`
            : absoluteReference(filters.linked.href, serviceOrigin),
        )),
    ...(sorts === undefined
      ? []
      : detail(
          'Search sorts',
          'inline' in sorts
            ? `${String(sorts.inline.length)} inline`
            : absoluteReference(sorts.linked.href, serviceOrigin),
        )),
  ];
  return (
    <Box flexDirection="column">
      <Text bold>Collection</Text>
      <DetailsTable rows={rows} />
    </Box>
  );
}

export function createCollectionsCli(resource: CollectionResource) {
  const cli = Cli.create('collections', { description: 'Browse collections from a service.' });

  cli.command('list', {
    args: collectionListArgs,
    description: 'List collections from a service.',
    mcp: mcpTool('odp_collections_list'),
    options: collectionListOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return executeOdpCommand(
        c,
        () =>
          runCollectionList(resource, {
            language: c.options.language,
            limit: c.options.limit,
            next: c.options.next,
            parentId: undefined,
            query: undefined,
            service: c.args.service,
          }),
        (result) => present(c, <CollectionsView command="list" page={result} service={c.args.service} />),
        { code: 'ODP_COLLECTION_LIST_FAILED', message: 'ODP Collection listing failed.', retryable: false },
      );
    },
  });

  cli.command('search', {
    args: collectionSearchArgs,
    description: 'Search collections from a service.',
    mcp: mcpTool('odp_collections_search'),
    options: collectionSearchOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return executeOdpCommand(
        c,
        () =>
          runCollectionSearch(resource, {
            language: c.options.language,
            limit: c.options.limit,
            next: c.options.next,
            parentId: c.options.parentId,
            query: c.args.query,
            service: c.args.service,
          }),
        (result) => present(c, <CollectionsView command="search" page={result} service={c.args.service} />),
        { code: 'ODP_COLLECTION_SEARCH_FAILED', message: 'ODP Collection search failed.', retryable: false },
      );
    },
  });

  cli.command('get', {
    args: collectionGetArgs,
    description: 'Get full collection details.',
    mcp: mcpTool('odp_collections_get'),
    options: collectionGetOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return executeOdpCommand(
        c,
        () => runCollectionGet(resource, c.args.service, c.args.id, c.options.language),
        (result) => present(c, <CollectionView collection={result.collection} serviceOrigin={result.service_origin} />),
        { code: 'ODP_COLLECTION_GET_FAILED', message: 'ODP Collection retrieval failed.', retryable: false },
      );
    },
  });

  return cli;
}

export const __testing = { runCollectionGet, runCollectionList, runCollectionSearch, runInspect };
