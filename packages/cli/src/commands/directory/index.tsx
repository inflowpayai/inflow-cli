import {
  DirectoryRequestError,
  type DirectorySearchPage,
  type DirectoryResult,
  type DirectorySearchRequest,
  type DirectoryServiceFilters,
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
} from './schema.js';
import { executeOdpCommand, odpCommandError } from '../odp/command.js';
import { Continuation, summarize } from '../odp/presentation.js';
import {
  enrollmentProtocolLabel,
  normalizePaymentFilters,
  paymentNameLabel,
  paymentOptionLabel,
  type PaymentFilter,
} from '../odp/payments.js';

interface CommandContext {
  agent: boolean;
  formatExplicit: boolean;
  error(error: { code: string; message: string; exitCode?: number; retryable?: boolean }): never;
}

interface SearchInput {
  query: string | undefined;
  keyword: string[];
  limit: number | undefined;
  next: string | undefined;
  withAep: boolean;
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
  source: Array<'odp' | 'openapi'>;
}

function directoryFilters(
  input: Pick<SearchInput, 'keyword' | 'withAep' | 'operation' | 'payment' | 'source'>,
): DirectoryServiceFilters {
  return {
    ...(input.source.length === 0 ? {} : { sources: [...new Set(input.source)] }),
    ...(input.keyword.length === 0 ? {} : { keywords: input.keyword }),
    ...(input.withAep ? { enrollment: [{ name: 'aep' }] } : {}),
    ...(input.operation.length === 0 ? {} : { operations: input.operation.map((name) => ({ name })) }),
    ...(input.payment.length === 0 ? {} : { payments: normalizePaymentFilters(input.payment) }),
  };
}

function searchRequest(input: SearchInput): DirectorySearchRequest {
  const filters = directoryFilters(input);
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
    input.withAep ||
    input.operation.length > 0 ||
    input.payment.length > 0 ||
    input.source.length > 0
  );
}

async function firstPage(sequence: ReturnType<IOdpResource['search']>): Promise<DirectorySearchPage<DirectoryResult>> {
  for await (const page of sequence.pages) return page;
  return { items: [] };
}

async function runDirectorySearch(
  resource: Pick<IOdpResource, 'continueSearch' | 'search'>,
  input: SearchInput,
): Promise<DirectorySearchPage<DirectoryResult>> {
  if (input.next === undefined && !hasInitialSearchInput(input)) {
    return odpCommandError({
      code: 'DIRECTORY_SEARCH_INPUT_REQUIRED',
      exitCode: 2,
      message:
        'Provide a query or directory filter.\nUsage: inflow directory search [query] [options]\nRun `inflow directory search --help` for all options.',
    });
  }
  if (input.next !== undefined && hasInitialSearchInput(input)) {
    return odpCommandError({
      code: 'DIRECTORY_NEXT_CONFLICT',
      exitCode: 2,
      message: '--next cannot be combined with a query or directory filters.',
    });
  }
  try {
    const sequence =
      input.next === undefined
        ? resource.search(searchRequest(input))
        : resource.continueSearch(input.next, { maxPages: 1 });
    return await firstPage(sequence);
  } catch (error) {
    if (error instanceof DirectoryRequestError) {
      return odpCommandError({
        code: 'DIRECTORY_HTTP_ERROR',
        message: `The directory returned HTTP ${error.status}.`,
        retryable: error.status === 429 || error.status >= 500,
      });
    }
    if (error instanceof Error && error.name === 'OdpValidationError') {
      return odpCommandError({
        code: 'DIRECTORY_RESPONSE_INVALID',
        message: 'The directory returned invalid result metadata.',
        retryable: false,
      });
    }
    return odpCommandError({
      code: 'DIRECTORY_SEARCH_FAILED',
      message: 'Directory search failed.',
      retryable: false,
    });
  }
}

async function runDirectorySuggest(
  resource: Pick<IOdpResource, 'suggest'>,
  prefix: string,
  input: Pick<SearchInput, 'keyword' | 'withAep' | 'operation' | 'payment' | 'source'> & { limit?: number | undefined },
): Promise<{ items: string[] }> {
  try {
    const filters = directoryFilters(input);
    const items = await resource.suggest({
      prefix,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(Object.keys(filters).length === 0 ? {} : { filters }),
    });
    return { items };
  } catch (error) {
    if (error instanceof DirectoryRequestError) {
      return odpCommandError({
        code: 'DIRECTORY_HTTP_ERROR',
        message: 'Directory suggestion failed.',
        retryable: error.status === 429 || error.status >= 500,
      });
    }
    return odpCommandError({
      code: 'DIRECTORY_SUGGEST_FAILED',
      message: 'Directory suggestion failed.',
      retryable: false,
    });
  }
}

async function present(c: CommandContext, view: React.ReactElement): Promise<void> {
  if (c.agent || c.formatExplicit) return;
  await renderInkUntilExit(view);
}

export function SearchView({ page }: { page: DirectorySearchPage<DirectoryResult> }) {
  const rows = page.items.map((result) => {
    if (result.type === 'unknown') {
      return {
        type: 'Unsupported',
        name: result.resource_type,
        description: '-',
        source: '-',
        target: '-',
        collectionId: '-',
      };
    }
    const metadata = result.type === 'collection' ? result.collection : result.service;
    return {
      type: result.type === 'collection' ? 'Collection' : 'Service',
      name: metadata.name,
      description: metadata.description === undefined ? '-' : summarize(metadata.description),
      source: result.service.source.type,
      target: result.service.source.type === 'odp' ? result.service.service_origin : result.service.source.url,
      collectionId: result.type === 'collection' ? result.collection.id : '-',
    };
  });
  const columns: ReadonlyArray<TableColumn<(typeof rows)[number]>> = [
    { header: 'Type', cell: (row) => row.type },
    { header: 'Name', cell: (row) => row.name },
    { header: 'Description', cell: (row) => row.description },
    { header: 'Source', cell: (row) => row.source },
    { header: 'Target URL', cell: (row) => row.target },
    { header: 'Collection ID', cell: (row) => row.collectionId },
  ];
  const facets = [
    ...(page.facets?.keywords ?? []).map(({ count, value }) => ({ count, facet: 'Keyword', value })),
    ...(page.facets?.enrollment ?? []).map(({ count, value }) => ({
      count,
      facet: 'AEP support',
      value: enrollmentProtocolLabel(value.name),
    })),
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
    { header: 'Matching results', cell: (row) => String(row.count) },
  ];
  return (
    <Box flexDirection="column">
      <Text bold>Directory results</Text>
      {rows.length === 0 ? <Text dimColor>No results found.</Text> : <Table columns={columns} rows={rows} />}
      {(page.issues ?? []).map((issue) => (
        <Text key={issue.index} dimColor>
          Skipped result {issue.index + 1}: {issue.message}
        </Text>
      ))}
      {facets.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Available Filters</Text>
          <Table columns={facetColumns} rows={facets} />
          <Text dimColor>
            Use --with-aep or these values with --keyword, --operation, or --payment to narrow the directory search.
          </Text>
        </Box>
      )}
      {page.next === undefined ? null : <Continuation command="inflow directory search" next={page.next} />}
    </Box>
  );
}

export function SuggestView({ items }: { items: string[] }) {
  if (items.length === 0) return <Text dimColor>No suggestions found.</Text>;
  const rows = items.map((keyword) => ({ keyword }));
  const columns: ReadonlyArray<TableColumn<(typeof rows)[number]>> = [{ header: 'Name', cell: (row) => row.keyword }];
  return (
    <Box flexDirection="column">
      <Text bold>Directory suggestions</Text>
      <Table columns={columns} rows={rows} />
    </Box>
  );
}

export function createDirectoryCli(resource: Pick<IOdpResource, 'continueSearch' | 'search' | 'suggest'>) {
  const directory = Cli.create('directory', { description: 'Search the directory for Services and Collections.' });

  directory.command('search', {
    args: directorySearchArgs,
    description: 'Search the directory for Services and Collections.',
    mcp: mcpTool('directory_search'),
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
            withAep: c.options.withAep,
            operation: c.options.operation,
            payment: c.options.payment,
            query: c.args.query,
            source: c.options.source,
          }),
        (page) => present(c, <SearchView page={page} />),
        { code: 'DIRECTORY_SEARCH_FAILED', message: 'Directory search failed.', retryable: false },
      );
    },
  });

  directory.command('suggest', {
    args: directorySuggestArgs,
    description: 'Find matching Service and Collection names.',
    mcp: mcpTool('directory_suggest'),
    options: directorySuggestOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return executeOdpCommand(
        c,
        () => runDirectorySuggest(resource, c.args.prefix, c.options),
        (result) => present(c, <SuggestView items={result.items} />),
        { code: 'DIRECTORY_SUGGEST_FAILED', message: 'Directory suggestion failed.', retryable: false },
      );
    },
  });

  return directory;
}

export const __testing = { runDirectorySearch, runDirectorySuggest };
