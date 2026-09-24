import {
  DirectoryRequestError,
  type DirectorySearchPage,
  type DirectoryResult,
  type DirectoryService,
  type IOdpResource,
} from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { SearchView, SuggestView, __testing, createDirectoryCli } from '../../../src/commands/directory/index.js';
import { OdpCommandError } from '../../../src/commands/odp/command.js';

const emptyInput: Parameters<typeof __testing.runDirectorySearch>[1] = {
  source: [],
  keyword: [],
  limit: undefined,
  next: undefined,
  withAep: false,
  operation: [],
  payment: [],
  query: undefined,
};

function sequence(page: DirectorySearchPage<DirectoryResult>): ReturnType<IOdpResource['search']> {
  return {
    items: {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield* page.items;
      },
    },
    pages: {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield page;
      },
    },
  };
}

function failingSequence(): ReturnType<IOdpResource['search']> {
  return {
    items: {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        throw new TypeError('private directory failure');
      },
    },
    pages: {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        throw new TypeError('private directory failure');
      },
    },
  };
}

describe('Directory commands', () => {
  it('renders mixed identities without attribution and preserves metadata in JSON', async () => {
    const service: DirectoryService & {
      service_id: string;
      source: { type: string; url: string; x402_discovery: boolean };
    } = {
      source: { type: 'odp', url: 'https://compute.example/.well-known/odp', x402_discovery: false },
      service_id: 'compute',
      service_origin: 'https://compute.example',
      name: 'Compute',
      description: 'Compute service',
      language: 'en',
      localizations: ['en'],
      operations: [],
      indexed_at: '2026-09-18T12:00:00Z',
      protocols: { payments: [{ name: 'mpp' as const, authentication: 'required' as const }] },
    };
    const page: DirectorySearchPage<DirectoryResult> = {
      items: [
        {
          type: 'service',
          service,
          indexed_at: service.indexed_at,
          available_through: { service_id: 'platform', service_origin: 'https://platform.example', name: 'Platform' },
        },
        { type: 'collection', service, indexed_at: service.indexed_at, collection: { id: 'GPU', name: 'GPU catalog' } },
        {
          type: 'collection',
          service,
          indexed_at: service.indexed_at,
          collection: { id: 'cpu', name: 'CPU catalog', description: 'CPU capacity' },
        },
        { type: 'unknown', resource_type: 'future', raw: { type: 'future', value: 1 } },
      ],
      issues: [{ index: 4, message: 'Invalid result' }],
    };
    const frame = render(<SearchView page={page} />).lastFrame();
    expect(frame).toContain('Collection ID');
    expect(frame).toContain('Target URL');
    expect(frame).toMatch(/https:\/\/compute\.example\s/);
    expect(frame).not.toContain(service.source.url);
    expect(frame).toContain('GPU catalog');
    expect(frame).toContain('CPU capacity');
    expect(frame).toContain('Unsupported');
    expect(frame).toContain('future');
    expect(frame).toContain('Skipped result 5: Invalid result');
    expect(frame).not.toContain('Platform');
    expect(frame).not.toContain('MPP');
    const output: string[] = [];
    await createDirectoryCli({ search: () => sequence(page), continueSearch: vi.fn(), suggest: vi.fn() }).serve(
      ['search', 'compute', '--format', 'json'],
      {
        exit: vi.fn(),
        stdout: (chunk) => {
          output.push(chunk);
        },
      },
    );
    expect(JSON.parse(output.join(''))).toEqual(page);
    expect(
      render(
        <SearchView
          page={{
            items: [],
            issues: [{ index: 4, message: 'Invalid result' }],
            next: '/v1/directory/search?cursor=next',
          }}
        />,
      ).lastFrame(),
    ).toContain('Skipped result 5');
  });

  it('sends search terms and filters to one directory page', async () => {
    const page = { items: [], next: '/v1/directory/search?cursor=next' };
    const search = vi.fn(() => sequence(page));

    const result = await __testing.runDirectorySearch(
      { continueSearch: vi.fn(), search },
      {
        ...emptyInput,
        keyword: ['gpu'],
        limit: 10,
        operation: ['search-offerings'],
        payment: ['mpp:inflow', 'mpp:solana'],
        query: 'compute',
      },
    );

    expect(result).toEqual(page);
    expect(search).toHaveBeenCalledWith({
      filters: {
        keywords: ['gpu'],
        operations: [{ name: 'search-offerings' }],
        payments: [{ name: 'mpp', options: ['inflow', 'solana'] }],
      },
      limit: 10,
      query: 'compute',
    });
  });

  it('delegates an opaque continuation to the ODP resource', async () => {
    const page = { items: [] };
    const continueSearch = vi.fn(() => sequence(page));

    await __testing.runDirectorySearch(
      { continueSearch, search: vi.fn() },
      { ...emptyInput, next: '/v1/directory/search?cursor=opaque' },
    );

    expect(continueSearch).toHaveBeenCalledWith('/v1/directory/search?cursor=opaque', { maxPages: 1 });
  });

  it('rejects combining a continuation with initial search input', async () => {
    await expect(
      __testing.runDirectorySearch(
        { continueSearch: vi.fn(), search: vi.fn() },
        { ...emptyInput, next: '/v1/directory/search?cursor=opaque', query: 'gpu' },
      ),
    ).rejects.toMatchObject({ detail: { code: 'DIRECTORY_NEXT_CONFLICT', exitCode: 2 } });
  });

  it('prints directory search usage when no search input is provided', async () => {
    try {
      await __testing.runDirectorySearch({ continueSearch: vi.fn(), search: vi.fn() }, emptyInput);
      throw new Error('Expected an empty directory search to fail.');
    } catch (caught) {
      expect(caught).toBeInstanceOf(OdpCommandError);
      if (caught instanceof OdpCommandError) {
        expect(caught.detail.code).toBe('DIRECTORY_SEARCH_INPUT_REQUIRED');
        expect(caught.detail.exitCode).toBe(2);
        expect(caught.detail.message).toContain('Usage: inflow directory search [query] [options]');
      }
    }
  });

  it('identifies an invalid Directory response', async () => {
    const failure = new Error('Invalid ODP Service Document');
    failure.name = 'OdpValidationError';

    await expect(
      __testing.runDirectorySearch(
        {
          continueSearch: vi.fn(),
          search: vi.fn(() => ({
            items: failingSequence().items,
            pages: {
              async *[Symbol.asyncIterator]() {
                await Promise.resolve();
                throw failure;
              },
            },
          })),
        },
        { ...emptyInput, query: 'plants' },
      ),
    ).rejects.toMatchObject({
      detail: {
        code: 'DIRECTORY_RESPONSE_INVALID',
        message: 'The directory returned invalid result metadata.',
      },
    });
  });

  it('reports the directory HTTP status for search failures', async () => {
    const failure = new DirectoryRequestError(503, 'private directory failure', new Headers());
    const resource = {
      continueSearch: vi.fn(),
      search: vi.fn(() => ({
        items: failingSequence().items,
        pages: {
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            throw failure;
          },
        },
      })),
    };

    await expect(__testing.runDirectorySearch(resource, { ...emptyInput, query: 'plants' })).rejects.toMatchObject({
      detail: {
        code: 'DIRECTORY_HTTP_ERROR',
        message: 'The directory returned HTTP 503.',
        retryable: true,
      },
    });
  });

  it('returns name suggestions in the stable items envelope', async () => {
    const suggest = vi.fn(() => Promise.resolve(['gpu', 'gpu compute']));

    await expect(__testing.runDirectorySuggest({ suggest }, 'gp', { ...emptyInput, limit: 5 })).resolves.toEqual({
      items: ['gpu', 'gpu compute'],
    });
    expect(suggest).toHaveBeenCalledWith({ limit: 5, prefix: 'gp' });
  });

  it.each(['search', 'suggest'])('forwards all filters from %s including --with-aep', async (command) => {
    const search = vi.fn(() => sequence({ items: [] }));
    const suggest = vi.fn(() => Promise.resolve(['Weather']));
    const exit = vi.fn();
    await createDirectoryCli({ search, suggest, continueSearch: vi.fn() }).serve(
      [
        command,
        'weather',
        '--with-aep',
        '--source',
        'odp',
        '--source',
        'openapi',
        '--keyword',
        'weather',
        '--operation',
        'get-offering',
        '--payment',
        'mpp:inflow',
        '--limit',
        '5',
        '--format',
        'json',
      ],
      { exit, stdout: vi.fn() },
    );
    const filters = {
      sources: ['odp', 'openapi'],
      enrollment: [{ name: 'aep' }],
      keywords: ['weather'],
      operations: [{ name: 'get-offering' }],
      payments: [{ name: 'mpp', options: ['inflow'] }],
    };
    if (command === 'search') expect(search).toHaveBeenCalledWith({ query: 'weather', limit: 5, filters });
    else expect(suggest).toHaveBeenCalledWith({ prefix: 'weather', limit: 5, filters });
  });

  it('treats --with-aep as an initial filter and rejects it with continuation', async () => {
    const search = vi.fn(() => sequence({ items: [] }));
    const resource = { search, continueSearch: vi.fn() };
    await __testing.runDirectorySearch(resource, { ...emptyInput, withAep: true });
    expect(search).toHaveBeenCalledWith({ filters: { enrollment: [{ name: 'aep' }] } });
    await expect(
      __testing.runDirectorySearch(resource, { ...emptyInput, withAep: true, next: '/next' }),
    ).rejects.toBeInstanceOf(OdpCommandError);
  });

  it('accepts source alone and rejects source with a continuation', async () => {
    const search = vi.fn(() => sequence({ items: [] }));
    const resource = { search, continueSearch: vi.fn() };
    await __testing.runDirectorySearch(resource, { ...emptyInput, source: ['openapi'] });
    expect(search).toHaveBeenCalledWith({ filters: { sources: ['openapi'] } });
    await expect(
      __testing.runDirectorySearch(resource, { ...emptyInput, source: ['openapi'], next: '/next' }),
    ).rejects.toMatchObject({ detail: { code: 'DIRECTORY_NEXT_CONFLICT' } });
  });

  it.each(['search', 'suggest'])('deduplicates source filters for %s', async (command) => {
    const search = vi.fn(() => sequence({ items: [] }));
    const suggest = vi.fn(() => Promise.resolve([]));
    await createDirectoryCli({ search, suggest, continueSearch: vi.fn() }).serve(
      [command, 'weather', '--source', 'openapi', '--source', 'odp', '--source', 'openapi', '--format', 'json'],
      { exit: vi.fn(), stdout: vi.fn() },
    );
    const filters = { sources: ['openapi', 'odp'] };
    if (command === 'search') expect(search).toHaveBeenCalledWith({ query: 'weather', filters });
    else expect(suggest).toHaveBeenCalledWith({ prefix: 'weather', filters });
  });

  it.each(['search', 'suggest'])('rejects blank %s text before calling the directory', async (command) => {
    for (const text of ['', '   ', '\t\n']) {
      const search = vi.fn(() => sequence({ items: [] }));
      const suggest = vi.fn(() => Promise.resolve([]));
      const stdout = vi.fn();
      await createDirectoryCli({ search, suggest, continueSearch: vi.fn() }).serve(
        [command, text, '--format', 'json'],
        { exit: vi.fn(), stdout },
      );
      expect(search).not.toHaveBeenCalled();
      expect(suggest).not.toHaveBeenCalled();
      expect(stdout.mock.calls.flat().join('')).toContain('VALIDATION_ERROR');
      expect(stdout.mock.calls.flat().join('')).toContain('nonblank');
    }
  });

  it.each(['search', 'suggest'])('trims surrounding whitespace from %s text', async (command) => {
    const search = vi.fn(() => sequence({ items: [] }));
    const suggest = vi.fn(() => Promise.resolve([]));
    await createDirectoryCli({ search, suggest, continueSearch: vi.fn() }).serve(
      [command, '  weather forecast  ', '--format', 'json'],
      { exit: vi.fn(), stdout: vi.fn() },
    );
    if (command === 'search') expect(search).toHaveBeenCalledWith({ query: 'weather forecast' });
    else expect(suggest).toHaveBeenCalledWith({ prefix: 'weather forecast' });
  });

  it('shows the exact parent document for imported Collections and preserves future source kinds', () => {
    const service = {
      service_id: 'imported',
      service_origin: 'https://example.com',
      name: 'Imported',
      indexed_at: '2026-09-23T00:00:00Z',
      source: { type: 'openapi', url: 'https://example.com/api/spec?version=2', x402_discovery: true },
    };
    const page: DirectorySearchPage<DirectoryResult> = {
      items: [
        { type: 'collection', service, collection: { id: 'group', name: 'Weather' }, indexed_at: service.indexed_at },
        {
          type: 'service',
          service: { ...service, source: { ...service.source, type: 'future' } },
          indexed_at: service.indexed_at,
        },
      ],
    };
    const output = render(<SearchView page={page} />).lastFrame();
    expect(output).toContain('openapi');
    expect(output).toContain('future');
    expect(output).toContain(service.source.url);
    expect(output).toContain('Target URL');
    expect(output).not.toMatch(/https:\/\/example\.com\s/);
    expect(output).not.toContain('odp collections get');
  });

  it.each([
    [404, false],
    [429, true],
    [503, true],
  ])('maps directory HTTP %i retryability', async (status, retryable) => {
    const error = new DirectoryRequestError(status, 'private directory failure', new Headers());
    try {
      await __testing.runDirectorySuggest({ suggest: vi.fn(() => Promise.reject(error)) }, 'gp', emptyInput);
      throw new Error('Expected directory suggestion to fail.');
    } catch (caught) {
      expect(caught).toBeInstanceOf(OdpCommandError);
      if (caught instanceof OdpCommandError) {
        expect(caught.detail).toMatchObject({ code: 'DIRECTORY_HTTP_ERROR', retryable });
      }
    }
  });

  it('renders Service results, continuations, and suggestions for interactive terminals', () => {
    const service: DirectoryService & { source: { type: string; url: string; x402_discovery: boolean } } = {
      source: { type: 'odp', url: 'https://compute.example/.well-known/odp', x402_discovery: false },
      description: 'Compute catalog',
      indexed_at: '2026-08-03T00:00:00Z',
      language: 'en',
      localizations: ['en'],
      name: 'Compute',
      operations: [{ authentication: 'not-required', name: 'list-offerings' }],
      protocols: {
        enrollment: [{ name: 'aep' }],
        payments: [{ authentication: 'not-required', name: 'mpp', options: ['inflow', 'solana'] }],
      },
      service_origin: 'https://compute.example',
    };
    const search = render(
      <SearchView
        page={{
          facets: {
            enrollment: [{ count: 8, value: { name: 'aep' } }],
            keywords: [{ count: 12, value: 'gpu' }],
            payment_options: [{ count: 4, value: { name: 'mpp', option: 'inflow' } }],
            payments: [{ count: 6, value: { authentication: 'not-required', name: 'mpp' } }],
          },
          items: [{ type: 'service', service: { ...service, service_id: 'compute' }, indexed_at: service.indexed_at }],
          next: '/v1/directory/search?cursor=next',
        }}
      />,
    );
    expect(search.lastFrame()).toContain('Compute catalog');
    expect(search.lastFrame()).not.toContain('Protocols');
    expect(search.lastFrame()).toContain('Available Filters');
    expect(search.lastFrame()).toContain('Matching results');
    expect(search.lastFrame()).toContain('--with-aep');
    expect(search.lastFrame()).toContain('Payment Option');
    expect(search.lastFrame()).toContain('AEP support');
    expect(search.lastFrame()).toContain('AEP');
    expect(search.lastFrame()).toContain('MPP: InFlow');
    expect(search.lastFrame()).toContain('Use --with-aep or these values with --keyword');
    expect(search.lastFrame()).toContain("inflow directory search --next '/v1/directory/search?cursor=next'");
    expect(render(<SearchView page={{ items: [] }} />).lastFrame()).toContain('No results found');
    expect(render(<SuggestView items={['gpu']} />).lastFrame()).toContain('gpu');
    expect(render(<SuggestView items={[]} />).lastFrame()).toContain('No suggestions found');

    const protocolsOnly = render(
      <SearchView
        page={{
          items: [{ type: 'service', service: { ...service, service_id: 'compute' }, indexed_at: service.indexed_at }],
        }}
      />,
    ).lastFrame();
    expect(protocolsOnly).not.toContain('InFlow');
    expect(protocolsOnly).not.toContain('Solana');
  });

  it.each([
    ['search', ['search', 'plants', '--format', 'json'], '"items"'],
    ['suggest', ['suggest', 'gp', '--format', 'json'], 'gpu'],
  ] as const)('dispatches directory %s successfully', async (_name, argv, expected) => {
    const output: string[] = [];
    const page = { items: [] };
    const resource = {
      continueSearch: vi.fn(() => sequence(page)),
      search: vi.fn(() => sequence(page)),
      suggest: vi.fn(() => Promise.resolve(['gpu'])),
    };

    await createDirectoryCli(resource).serve([...argv], {
      exit: vi.fn(),
      stdout(chunk) {
        output.push(chunk);
      },
    });

    expect(output.join('')).toContain(expected);
  });

  it('rejects an unexpected directory search positional argument', async () => {
    const output: string[] = [];
    const exit = vi.fn();
    const search = vi.fn(() => sequence({ items: [] }));

    await createDirectoryCli({
      continueSearch: vi.fn(),
      search,
      suggest: vi.fn(),
    }).serve(['search', 'query', 'plants'], {
      exit,
      stdout(chunk) {
        output.push(chunk);
      },
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(output.join('')).toContain('Unexpected argument: plants');
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    ['search', ['search', 'plants'], 'DIRECTORY_SEARCH_FAILED'],
    ['suggest', ['suggest', 'gp'], 'DIRECTORY_SUGGEST_FAILED'],
  ] as const)('returns a stable directory %s failure', async (_name, argv, code) => {
    const output: string[] = [];
    const exit = vi.fn();
    const resource = {
      continueSearch: vi.fn(() => failingSequence()),
      search: vi.fn(() => failingSequence()),
      suggest: vi.fn(() => Promise.reject(new TypeError('private directory failure'))),
    };

    await createDirectoryCli(resource).serve([...argv], {
      exit,
      stdout(chunk) {
        output.push(chunk);
      },
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(output.join('')).toContain(code);
    expect(output.join('')).not.toContain('private directory failure');
  });
});
