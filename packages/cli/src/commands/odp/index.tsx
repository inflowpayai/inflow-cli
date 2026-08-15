import {
  DirectoryRequestError,
  type DirectorySearchPage,
  type DirectorySearchRequest,
  type IOdpResource,
} from '@inflowpayai/inflow-core';
import { Cli } from 'incur';
import { Box, Text } from 'ink';
import React from 'react';
import { mcpTool } from '../../mcp-metadata.js';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { Table, type TableColumn } from '../../utils/table.js';
import {
  directorySearchArgs,
  directorySearchOptions,
  directorySuggestArgs,
  directorySuggestOptions,
  inspectArgs,
  inspectOptions,
} from './schema.js';
import { createCollectionsCli, InspectionView, runInspect } from './service.js';
import { createOfferingsCli } from './offerings.js';
import { createActionsCli } from './actions.js';
import { executeOdpCommand, odpCommandError } from './command.js';
import { Continuation, listed, summarize } from './presentation.js';
import {
  normalizePaymentFilters,
  paymentNameLabel,
  paymentOptionLabel,
  paymentProtocolLabel,
  type PaymentFilter,
} from './payments.js';

interface CommandContext {
  agent: boolean;
  formatExplicit: boolean;
  error(error: { code: string; message: string; exitCode?: number; retryable?: boolean }): never;
}

interface InspectCommandContext extends CommandContext {
  args: { service: string };
  options: { language?: string | undefined };
}

interface SearchInput {
  query: string | undefined;
  keyword: string[];
  limit: number | undefined;
  next: string | undefined;
  enrollment: 'aep'[];
  operation: Array<
    | 'get-collection'
    | 'get-offering'
    | 'list-collection-offerings'
    | 'list-collections'
    | 'list-offerings'
    | 'search-collections'
    | 'search-offerings'
  >;
  payment: PaymentFilter[];
}

function searchRequest(input: SearchInput): DirectorySearchRequest {
  const filters = {
    ...(input.keyword.length === 0 ? {} : { keywords: input.keyword }),
    ...(input.enrollment.length === 0 ? {} : { enrollment: input.enrollment.map((name) => ({ name })) }),
    ...(input.operation.length === 0 ? {} : { operations: input.operation.map((name) => ({ name })) }),
    ...(input.payment.length === 0 ? {} : { payments: normalizePaymentFilters(input.payment) }),
  };
  return {
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
}

function hasInitialSearchInput(input: SearchInput): boolean {
  return (
    input.query !== undefined ||
    input.keyword.length > 0 ||
    input.limit !== undefined ||
    input.enrollment.length > 0 ||
    input.operation.length > 0 ||
    input.payment.length > 0
  );
}

async function firstPage(sequence: ReturnType<IOdpResource['searchServices']>): Promise<DirectorySearchPage> {
  for await (const page of sequence.pages) return page;
  return { items: [] };
}

async function runDirectorySearch(
  resource: Pick<IOdpResource, 'continueSearchServices' | 'searchServices'>,
  input: SearchInput,
): Promise<DirectorySearchPage> {
  if (input.next !== undefined && hasInitialSearchInput(input)) {
    return odpCommandError({
      code: 'ODP_DIRECTORY_NEXT_CONFLICT',
      exitCode: 2,
      message: '--next cannot be combined with a query or directory filters.',
    });
  }
  try {
    const sequence =
      input.next === undefined
        ? resource.searchServices(searchRequest(input))
        : resource.continueSearchServices(input.next, { maxPages: 1 });
    return await firstPage(sequence);
  } catch (error) {
    if (error instanceof DirectoryRequestError) {
      return odpCommandError({
        code: 'ODP_DIRECTORY_HTTP_ERROR',
        message: 'ODP directory search failed.',
        retryable: error.status === 429 || error.status >= 500,
      });
    }
    return odpCommandError({
      code: 'ODP_DIRECTORY_SEARCH_FAILED',
      message: 'ODP directory search failed.',
      retryable: false,
    });
  }
}

async function runDirectorySuggest(
  resource: Pick<IOdpResource, 'suggestServices'>,
  prefix: string,
  limit?: number,
): Promise<{ items: string[] }> {
  try {
    const items = await resource.suggestServices({ prefix, ...(limit === undefined ? {} : { limit }) });
    return { items };
  } catch (error) {
    if (error instanceof DirectoryRequestError) {
      return odpCommandError({
        code: 'ODP_DIRECTORY_HTTP_ERROR',
        message: 'ODP directory suggestion failed.',
        retryable: error.status === 429 || error.status >= 500,
      });
    }
    return odpCommandError({
      code: 'ODP_DIRECTORY_SUGGEST_FAILED',
      message: 'ODP directory suggestion failed.',
      retryable: false,
    });
  }
}

async function present(c: CommandContext, view: React.ReactElement): Promise<void> {
  if (c.agent || c.formatExplicit) return;
  await renderInkUntilExit(view);
}

export function SearchView({ page }: { page: DirectorySearchPage }) {
  if (page.items.length === 0) return <Text dimColor>No Services found.</Text>;
  const rows = page.items.map((service) => ({
    description: summarize(service.description),
    name: service.name,
    origin: service.service_origin,
    protocols: listed([
      ...(service.protocols?.enrollment ?? []).map(({ name }) => name),
      ...(service.protocols?.payments ?? []).map(paymentProtocolLabel),
    ]),
  }));
  const columns: ReadonlyArray<TableColumn<(typeof rows)[number]>> = [
    { header: 'Name', cell: (row) => row.name },
    { header: 'Description', cell: (row) => row.description },
    { header: 'Protocols', cell: (row) => row.protocols },
    { header: 'Origin', cell: (row) => row.origin },
  ];
  const facets = [
    ...(page.facets?.keywords ?? []).map(({ count, value }) => ({ count, facet: 'Keyword', value })),
    ...(page.facets?.enrollment ?? []).map(({ count, value }) => ({ count, facet: 'Enrollment', value: value.name })),
    ...(page.facets?.operations ?? []).map(({ count, value }) => ({ count, facet: 'Operation', value: value.name })),
    ...(page.facets?.payment_options ?? []).map(({ count, value }) => ({
      count,
      facet: 'Payment Option',
      value: `${paymentNameLabel(value.name)}: ${paymentOptionLabel(value.option)}`,
    })),
    ...(page.facets?.payments ?? []).map(({ count, value }) => ({
      count,
      facet: 'Payment',
      value: paymentNameLabel(value.name),
    })),
  ];
  const facetColumns: ReadonlyArray<TableColumn<(typeof facets)[number]>> = [
    { header: 'Filter', cell: (row) => row.facet },
    { header: 'Value', cell: (row) => row.value },
    { header: 'Matching Services', cell: (row) => String(row.count) },
  ];
  return (
    <Box flexDirection="column">
      <Text bold>Services</Text>
      <Table columns={columns} rows={rows} />
      {facets.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Available Filters</Text>
          <Table columns={facetColumns} rows={facets} />
          <Text dimColor>
            Use these values with --keyword, --enrollment, --operation, or --payment to narrow the directory search.
          </Text>
        </Box>
      )}
      {page.next === undefined ? null : <Continuation command="inflow odp directory search" next={page.next} />}
    </Box>
  );
}

export function SuggestView({ items }: { items: string[] }) {
  if (items.length === 0) return <Text dimColor>No keyword suggestions found.</Text>;
  const rows = items.map((keyword) => ({ keyword }));
  const columns: ReadonlyArray<TableColumn<(typeof rows)[number]>> = [
    { header: 'Keyword', cell: (row) => row.keyword },
  ];
  return (
    <Box flexDirection="column">
      <Text bold>Directory keyword suggestions</Text>
      <Table columns={columns} rows={rows} />
    </Box>
  );
}

export function createDirectoryCli(
  resource: Pick<IOdpResource, 'continueSearchServices' | 'searchServices' | 'suggestServices'>,
) {
  const directory = Cli.create('directory', { description: 'Search the service directory.' });

  directory.command('search', {
    args: directorySearchArgs,
    description: 'Search the directory for services.',
    mcp: mcpTool('odp_directory_search'),
    options: directorySearchOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return executeOdpCommand(
        c,
        () =>
          runDirectorySearch(resource, {
            keyword: c.options.keyword,
            limit: c.options.limit,
            next: c.options.next,
            enrollment: c.options.enrollment,
            operation: c.options.operation,
            payment: c.options.payment,
            query: c.args.query,
          }),
        (page) => present(c, <SearchView page={page} />),
        { code: 'ODP_DIRECTORY_SEARCH_FAILED', message: 'ODP directory search failed.', retryable: false },
      );
    },
  });

  directory.command('suggest', {
    args: directorySuggestArgs,
    description: 'Suggest directory keywords.',
    mcp: mcpTool('odp_directory_suggest'),
    options: directorySuggestOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return executeOdpCommand(
        c,
        () => runDirectorySuggest(resource, c.args.prefix, c.options.limit),
        (result) => present(c, <SuggestView items={result.items} />),
        { code: 'ODP_DIRECTORY_SUGGEST_FAILED', message: 'ODP directory suggestion failed.', retryable: false },
      );
    },
  });

  return directory;
}

function createInspectCommand(resource: Pick<IOdpResource, 'inspect'>) {
  return {
    args: inspectArgs,
    description: "Inspect a service's capabilities.",
    mcp: mcpTool('odp_inspect'),
    options: inspectOptions,
    outputPolicy: 'agent-only' as const,
    async run(c: InspectCommandContext) {
      return executeOdpCommand(
        c,
        () => runInspect(resource, c.args.service, c.options.language),
        (result) => present(c, <InspectionView inspection={result} />),
        { code: 'ODP_INSPECT_FAILED', message: 'ODP Service inspection failed.', retryable: false },
      );
    },
  };
}

export function createInspectCli(resource: Pick<IOdpResource, 'inspect'>) {
  const cli = Cli.create('odp', { description: 'Offering Discovery Protocol commands' });
  cli.command('inspect', createInspectCommand(resource));
  return cli;
}

export function createOdpCli(resource: IOdpResource) {
  const cli = createInspectCli(resource);
  cli.command(createActionsCli(resource));
  cli.command(createCollectionsCli(resource));
  cli.command(createDirectoryCli(resource));
  cli.command(createOfferingsCli(resource));
  return cli;
}

export const __testing = { runDirectorySearch, runDirectorySuggest };
