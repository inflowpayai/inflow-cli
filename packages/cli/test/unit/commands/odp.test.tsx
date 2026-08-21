import {
  DirectoryRequestError,
  type DirectorySearchPage,
  type DirectoryService,
  type IOdpResource,
} from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { SearchView, SuggestView, __testing, createDirectoryCli } from '../../../src/commands/odp/index.js';
import { OdpCommandError } from '../../../src/commands/odp/command.js';

const emptyInput: Parameters<typeof __testing.runDirectorySearch>[1] = {
  keyword: [],
  limit: undefined,
  next: undefined,
  enrollment: [],
  operation: [],
  payment: [],
  query: undefined,
};

function sequence(page: DirectorySearchPage): ReturnType<IOdpResource['searchServices']> {
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

function failingSequence(): ReturnType<IOdpResource['searchServices']> {
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

describe('ODP directory commands', () => {
  it('sends search terms and filters to one directory page', async () => {
    const page = { items: [], next: '/v1/services/search?cursor=next' };
    const searchServices = vi.fn(() => sequence(page));

    const result = await __testing.runDirectorySearch(
      { continueSearchServices: vi.fn(), searchServices },
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
    expect(searchServices).toHaveBeenCalledWith({
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
    const continueSearchServices = vi.fn(() => sequence(page));

    await __testing.runDirectorySearch(
      { continueSearchServices, searchServices: vi.fn() },
      { ...emptyInput, next: '/v1/services/search?cursor=opaque' },
    );

    expect(continueSearchServices).toHaveBeenCalledWith('/v1/services/search?cursor=opaque', { maxPages: 1 });
  });

  it('rejects combining a continuation with initial search input', async () => {
    await expect(
      __testing.runDirectorySearch(
        { continueSearchServices: vi.fn(), searchServices: vi.fn() },
        { ...emptyInput, next: '/v1/services/search?cursor=opaque', query: 'gpu' },
      ),
    ).rejects.toMatchObject({ detail: { code: 'ODP_DIRECTORY_NEXT_CONFLICT', exitCode: 2 } });
  });

  it('prints directory search usage when no search input is provided', async () => {
    try {
      await __testing.runDirectorySearch({ continueSearchServices: vi.fn(), searchServices: vi.fn() }, emptyInput);
      throw new Error('Expected an empty directory search to fail.');
    } catch (caught) {
      expect(caught).toBeInstanceOf(OdpCommandError);
      if (caught instanceof OdpCommandError) {
        expect(caught.detail.code).toBe('ODP_DIRECTORY_SEARCH_INPUT_REQUIRED');
        expect(caught.detail.exitCode).toBe(2);
        expect(caught.detail.message).toContain('Usage: inflow odp directory search [query] [options]');
      }
    }
  });

  it('identifies an invalid ODP directory response', async () => {
    const failure = new Error('Invalid ODP Service Document');
    failure.name = 'OdpValidationError';

    await expect(
      __testing.runDirectorySearch(
        {
          continueSearchServices: vi.fn(),
          searchServices: vi.fn(() => ({
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
        code: 'ODP_DIRECTORY_RESPONSE_INVALID',
        message: 'The directory returned Service metadata that does not conform to ODP.',
      },
    });
  });

  it('reports the directory HTTP status for search failures', async () => {
    const failure = new DirectoryRequestError(503, 'private directory failure', new Headers());
    const resource = {
      continueSearchServices: vi.fn(),
      searchServices: vi.fn(() => ({
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
        code: 'ODP_DIRECTORY_HTTP_ERROR',
        message: 'The directory returned HTTP 503.',
        retryable: true,
      },
    });
  });

  it('returns keyword suggestions in the stable items envelope', async () => {
    const suggestServices = vi.fn(() => Promise.resolve(['gpu', 'gpu compute']));

    await expect(__testing.runDirectorySuggest({ suggestServices }, 'gp', 5)).resolves.toEqual({
      items: ['gpu', 'gpu compute'],
    });
    expect(suggestServices).toHaveBeenCalledWith({ limit: 5, prefix: 'gp' });
  });

  it.each([
    [404, false],
    [429, true],
    [503, true],
  ])('maps directory HTTP %i retryability', async (status, retryable) => {
    const error = new DirectoryRequestError(status, 'private directory failure', new Headers());
    try {
      await __testing.runDirectorySuggest({ suggestServices: vi.fn(() => Promise.reject(error)) }, 'gp');
      throw new Error('Expected directory suggestion to fail.');
    } catch (caught) {
      expect(caught).toBeInstanceOf(OdpCommandError);
      if (caught instanceof OdpCommandError) {
        expect(caught.detail).toMatchObject({ code: 'ODP_DIRECTORY_HTTP_ERROR', retryable });
      }
    }
  });

  it('renders Service results, continuations, and suggestions for interactive terminals', () => {
    const service: DirectoryService = {
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
          items: [service],
          next: '/v1/services/search?cursor=next',
        }}
      />,
    );
    expect(search.lastFrame()).toContain('Compute catalog');
    expect(search.lastFrame()).toContain('ODP, AEP, MPP');
    expect(search.lastFrame()).toContain('Available Filters');
    expect(search.lastFrame()).toContain('Matching Services');
    expect(search.lastFrame()).not.toContain('aep');
    expect(search.lastFrame()).toContain('Payment Option');
    expect(search.lastFrame()).toContain('Enrollment');
    expect(search.lastFrame()).toContain('AEP');
    expect(search.lastFrame()).toContain('MPP: InFlow');
    expect(search.lastFrame()).toContain('Use these values with --keyword');
    expect(search.lastFrame()).toContain("inflow odp directory search --next '/v1/services/search?cursor=next'");
    expect(render(<SearchView page={{ items: [] }} />).lastFrame()).toContain('No Services found');
    expect(render(<SuggestView items={['gpu']} />).lastFrame()).toContain('gpu');
    expect(render(<SuggestView items={[]} />).lastFrame()).toContain('No keyword suggestions found');

    const protocolsOnly = render(<SearchView page={{ items: [service] }} />).lastFrame();
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
      continueSearchServices: vi.fn(() => sequence(page)),
      searchServices: vi.fn(() => sequence(page)),
      suggestServices: vi.fn(() => Promise.resolve(['gpu'])),
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
    const searchServices = vi.fn(() => sequence({ items: [] }));

    await createDirectoryCli({
      continueSearchServices: vi.fn(),
      searchServices,
      suggestServices: vi.fn(),
    }).serve(['search', 'query', 'plants'], {
      exit,
      stdout(chunk) {
        output.push(chunk);
      },
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(output.join('')).toContain('Unexpected argument: plants');
    expect(searchServices).not.toHaveBeenCalled();
  });

  it.each([
    ['search', ['search', 'plants'], 'ODP_DIRECTORY_SEARCH_FAILED'],
    ['suggest', ['suggest', 'gp'], 'ODP_DIRECTORY_SUGGEST_FAILED'],
  ] as const)('returns a stable directory %s failure', async (_name, argv, code) => {
    const output: string[] = [];
    const exit = vi.fn();
    const resource = {
      continueSearchServices: vi.fn(() => failingSequence()),
      searchServices: vi.fn(() => failingSequence()),
      suggestServices: vi.fn(() => Promise.reject(new TypeError('private directory failure'))),
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
