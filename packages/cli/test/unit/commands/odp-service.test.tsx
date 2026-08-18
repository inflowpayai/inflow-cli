import type {
  Collection,
  CollectionSequence,
  IOdpResource,
  PageEnvelope,
  ServiceInspection,
  TerseCollection,
} from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import {
  CollectionsView,
  CollectionView,
  InspectionView,
  __testing,
  createCollectionsCli,
} from '../../../src/commands/odp/service.js';
import { createInspectCli } from '../../../src/commands/odp/index.js';
import { OdpCommandError } from '../../../src/commands/odp/command.js';

const collection: Collection = {
  id: 'compute',
  name: 'Compute',
  odp_version: '1.0',
  parent_ids: ['infrastructure'],
};
const listCollectionsOperation = { authentication: 'required', name: 'list-collections' } as const;
const operations = [
  { authentication: 'required', name: 'get-collection' },
  listCollectionsOperation,
  { authentication: 'required', name: 'search-collections' },
] satisfies ServiceInspection['capabilities']['operations'];
const inspection: ServiceInspection = {
  capabilities: {
    enrollment: [{ name: 'aep' }],
    operations,
    payments: [{ authentication: 'required', name: 'mpp', options: ['inflow', 'tempo'] }],
  },
  document: {
    description: 'Compute catalog',
    documentation_url: '/developers/',
    http: { endpoint_base: '/odp' },
    language: 'en',
    localizations: ['en'],
    name: 'Compute',
    odp_version: '1.0',
    operations,
    protocols: {
      enrollment: [{ name: 'aep' }],
      payments: [{ authentication: 'required', name: 'mpp', options: ['inflow', 'tempo'] }],
    },
    status_url: 'https://status.compute.example/',
    support_url: '/support/',
    website_url: '/compute/',
  },
  finalUrl: new URL('https://compute.example/.well-known/odp'),
  freshness: 'fetched',
  requestedUrl: new URL('https://compute.example/.well-known/odp'),
  serviceOrigin: 'https://compute.example',
};

function sequence(page: PageEnvelope<TerseCollection>): CollectionSequence<TerseCollection> {
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

function collectionResource() {
  const page = sequence({ items: [collection], odp_version: '1.0' });
  const service = {
    continueListCollections: vi.fn(() => page),
    continueSearchCollections: vi.fn(() => page),
    getCollection: vi.fn(() => Promise.resolve(collection)),
    inspect: vi.fn(() => Promise.resolve(inspection)),
    listCollections: vi.fn(() => page),
    searchCollections: vi.fn(() => page),
  };
  return { resource: { service: vi.fn(() => service) }, service };
}

function failingCollectionSequence(): CollectionSequence<TerseCollection> {
  return {
    items: {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        throw new TypeError('private Collection failure');
      },
    },
    pages: {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        throw new TypeError('private Collection failure');
      },
    },
  };
}

describe('ODP Service and Collection commands', () => {
  it('inspects a Service with the requested language', async () => {
    const inspect = vi.fn<IOdpResource['inspect']>(() => Promise.resolve(inspection));

    await expect(__testing.runInspect({ inspect }, 'https://compute.example', 'ja')).resolves.toEqual(inspection);
    expect(inspect).toHaveBeenCalledWith({ acceptLanguage: 'ja', serviceUrl: 'https://compute.example' });
  });

  it('dispatches Service inspection successfully', async () => {
    const output: string[] = [];
    await createInspectCli({ inspect: vi.fn(() => Promise.resolve(inspection)) }).serve(
      ['inspect', 'https://compute.example', '--format', 'json'],
      {
        exit: vi.fn(),
        stdout(chunk) {
          output.push(chunk);
        },
      },
    );

    expect(output.join('')).toContain('Compute catalog');
  });

  it('returns a stable Service inspection failure', async () => {
    const output: string[] = [];
    const exit = vi.fn();
    await createInspectCli({ inspect: vi.fn(() => Promise.reject(new TypeError('private inspection failure'))) }).serve(
      ['inspect', 'https://compute.example'],
      {
        exit,
        stdout(chunk) {
          output.push(chunk);
        },
      },
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(output.join('')).toContain('ODP_INSPECT_FAILED');
    expect(output.join('')).not.toContain('private inspection failure');
  });

  it('lists one terse Collection page', async () => {
    const { resource, service } = collectionResource();
    const result = await __testing.runCollectionList(resource, {
      language: 'en',
      limit: 20,
      next: undefined,
      parentId: undefined,
      query: undefined,
      service: 'https://compute.example',
    });

    expect(result).toEqual({ items: [collection], odp_version: '1.0', service_origin: 'https://compute.example' });
    expect(resource.service).toHaveBeenCalledWith({ acceptLanguage: 'en', serviceUrl: 'https://compute.example' });
    expect(service.listCollections).toHaveBeenCalledWith({ limit: 20, maxPages: 1, representation: 'terse' });
    expect(service.inspect).toHaveBeenCalledOnce();
  });

  it('delegates Collection search continuation without rebuilding it', async () => {
    const { resource, service } = collectionResource();
    await __testing.runCollectionSearch(resource, {
      language: undefined,
      limit: undefined,
      next: '/odp/collections/search?cursor=opaque',
      parentId: undefined,
      query: undefined,
      service: 'https://compute.example',
    });

    expect(service.continueSearchCollections).toHaveBeenCalledWith('/odp/collections/search?cursor=opaque', {
      maxPages: 1,
      representation: 'terse',
    });
    expect(service.inspect).not.toHaveBeenCalled();
  });

  it('rejects Collection search without a query or parent identifier before contacting the Service', async () => {
    const { resource, service } = collectionResource();

    await expect(
      __testing.runCollectionSearch(resource, {
        language: undefined,
        limit: undefined,
        next: undefined,
        parentId: undefined,
        query: undefined,
        service: 'https://compute.example',
      }),
    ).rejects.toMatchObject({
      detail: {
        code: 'ODP_COLLECTION_SEARCH_INPUT_REQUIRED',
        message: 'A query or --parent-id is required. Use `collections list` for an unconstrained request.',
      },
    });
    expect(resource.service).not.toHaveBeenCalled();
    expect(service.searchCollections).not.toHaveBeenCalled();
  });

  it('directs unsupported Collection search to the advertised list operation', async () => {
    const { resource, service } = collectionResource();
    service.inspect.mockResolvedValue({
      ...inspection,
      capabilities: { ...inspection.capabilities, operations: [listCollectionsOperation] },
    });

    try {
      await __testing.runCollectionSearch(resource, {
        language: undefined,
        limit: undefined,
        next: undefined,
        parentId: undefined,
        query: 'compute',
        service: 'https://compute.example',
      });
      throw new Error('Expected Collection search to reject an unadvertised operation.');
    } catch (error) {
      expect(error).toBeInstanceOf(OdpCommandError);
      if (error instanceof OdpCommandError) {
        expect(error.detail.code).toBe('ODP_OPERATION_NOT_SUPPORTED');
        expect(error.detail.message).toContain('inflow odp collections list <service>');
        expect(error.detail.retryable).toBe(false);
      }
    }
    expect(service.searchCollections).not.toHaveBeenCalled();
  });

  it('returns the capability-aware Collection failure through structured CLI output', async () => {
    const { resource, service } = collectionResource();
    service.inspect.mockResolvedValue({
      ...inspection,
      capabilities: { ...inspection.capabilities, operations: [listCollectionsOperation] },
    });
    const output: string[] = [];
    const exit = vi.fn();

    await createCollectionsCli(resource).serve(['search', 'https://compute.example', 'compute', '--format', 'json'], {
      exit,
      stdout(chunk) {
        output.push(chunk);
      },
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(output.join('')).toContain('ODP_OPERATION_NOT_SUPPORTED');
    expect(output.join('')).toContain('inflow odp collections list <service>');
  });

  it('gets a full Collection representation', async () => {
    const { resource, service } = collectionResource();
    await expect(
      __testing.runCollectionGet(resource, 'https://compute.example', 'compute', undefined),
    ).resolves.toEqual({ collection, service_origin: 'https://compute.example' });
    expect(service.getCollection).toHaveBeenCalledWith('compute', { representation: 'full' });
  });

  it('renders a concise Service inspection for interactive terminals', () => {
    const { lastFrame } = render(<InspectionView inspection={inspection} />);
    expect(lastFrame()).toContain('ODP Service');
    expect(lastFrame()).toContain('Field');
    expect(lastFrame()).toContain('Value');
    expect(lastFrame()).toContain('Compute catalog');
    expect(lastFrame()).toContain('https://compute.example');
    expect(lastFrame()).toContain('https://compute.example/compute/');
    expect(lastFrame()).toContain('https://compute.example/developers/');
    expect(lastFrame()).toContain('https://compute.example/support/');
    expect(lastFrame()).toContain('https://status.compute.example/');
    expect(lastFrame()).toContain('ODP version');
    expect(lastFrame()).toContain('list-collections');
    expect(lastFrame()).toContain('get-collection (authentication required)');
    expect(lastFrame()).toContain('aep');
    expect(lastFrame()).toContain('MPP: InFlow, Tempo (authentication required)');
  });

  it('renders Collection pages and full Collection details for interactive terminals', () => {
    const page = render(
      <CollectionsView
        command="list"
        page={{ items: [collection], next: '/odp/collections?cursor=next', odp_version: '1.0' }}
        service="https://compute.example/catalog"
      />,
    );
    expect(page.lastFrame()).toContain('Compute');
    expect(page.lastFrame()).toContain('Parent Collections');
    expect(page.lastFrame()).toContain('infrastructure');
    expect(page.lastFrame()).toContain("inflow odp collections list 'https://compute.example/catalog' --next");
    expect(
      render(
        <CollectionsView command="list" page={{ items: [], odp_version: '1.0' }} service="https://compute.example" />,
      ).lastFrame(),
    ).toContain('No Collections found');
    const detail = render(
      <CollectionView
        collection={{ ...collection, description: 'Compute products', web_url: '/collections/compute' }}
        serviceOrigin="https://compute.example"
      />,
    );
    expect(detail.lastFrame()).toContain('Compute products');
    expect(detail.lastFrame()).toContain('Parent Collections');
    expect(detail.lastFrame()).toContain('https://compute.example/collections/compute');
    expect(detail.lastFrame()).not.toContain('Localizations');
    expect(detail.lastFrame()).not.toContain('ODP version');
  });

  it('renders localized Collection search capabilities from inline and linked definitions', () => {
    const inline = render(
      <CollectionView
        collection={{
          ...collection,
          language: 'en',
          localizations: ['en', 'ja'],
          search_capabilities: {
            filters: { inline: [] },
            sorts: { inline: [] },
          },
        }}
        serviceOrigin="https://compute.example"
      />,
    ).lastFrame();
    expect(inline).toContain('Language');
    expect(inline).toContain('en, ja');
    expect(inline).toContain('0 inline');

    const linked = render(
      <CollectionView
        collection={{
          ...collection,
          search_capabilities: {
            filters: { linked: { href: '/odp/collections/compute/filters' } },
            sorts: { linked: { href: '/odp/collections/compute/sorts' } },
          },
        }}
        serviceOrigin="https://compute.example"
      />,
    ).lastFrame();
    expect(linked).toContain('https://compute.example/odp/collections/compute/filters');
    expect(linked).toContain('https://compute.example/odp/collections/compute/sorts');
  });

  it('omits empty Service localization metadata', () => {
    const emptyLocalizations = {
      ...inspection,
      document: { ...inspection.document, localizations: [] },
    };
    expect(render(<InspectionView inspection={emptyLocalizations} />).lastFrame()).not.toContain('Localizations');
  });

  it.each([
    ['list', ['list', 'https://compute.example', '--format', 'json']],
    ['search', ['search', 'https://compute.example', 'compute', '--format', 'json']],
    ['get', ['get', 'https://compute.example', 'compute', '--format', 'json']],
  ] as const)('dispatches Collection %s successfully', async (_name, argv) => {
    const { resource } = collectionResource();
    const output: string[] = [];

    await createCollectionsCli(resource).serve([...argv], {
      exit: vi.fn(),
      stdout(chunk) {
        output.push(chunk);
      },
    });

    expect(output.join('')).toContain('compute');
  });

  it.each([
    ['list', ['list', 'https://compute.example'], 'ODP_COLLECTION_LIST_FAILED'],
    ['search', ['search', 'https://compute.example', 'compute'], 'ODP_COLLECTION_SEARCH_FAILED'],
    ['get', ['get', 'https://compute.example', 'compute'], 'ODP_COLLECTION_GET_FAILED'],
  ] as const)('returns a stable Collection %s failure', async (_name, argv, code) => {
    const output: string[] = [];
    const exit = vi.fn();
    const failure = failingCollectionSequence();
    const service = {
      continueListCollections: vi.fn(() => failure),
      continueSearchCollections: vi.fn(() => failure),
      getCollection: vi.fn(() => Promise.reject(new TypeError('private Collection failure'))),
      inspect: vi.fn(() => Promise.resolve(inspection)),
      listCollections: vi.fn(() => failure),
      searchCollections: vi.fn(() => failure),
    };

    await createCollectionsCli({ service: vi.fn(() => service) }).serve([...argv], {
      exit,
      stdout(chunk) {
        output.push(chunk);
      },
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(output.join('')).toContain(code);
    expect(output.join('')).not.toContain('private Collection failure');
  });
});
