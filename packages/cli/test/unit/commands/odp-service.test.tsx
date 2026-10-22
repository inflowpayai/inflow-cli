import type {
  Collection,
  CollectionSequence,
  IOdpResource,
  PageEnvelope,
  ServiceInspection,
  TerseCollection,
} from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import {
  Inflow,
  MemoryStorage,
  OdpInspectionError,
  SecureStorageError,
  TapSigningError,
} from '@inflowpayai/inflow-core';
import { describe, expect, it, vi } from 'vitest';
import {
  CollectionsView,
  CollectionView,
  InspectionView,
  __testing,
  createCollectionsCli,
  odpServiceFailure,
} from '../../../src/commands/odp/service.js';
import { createInspectCli, createOdpCli } from '../../../src/commands/odp/index.js';
import { OdpCommandError } from '../../../src/commands/odp/command.js';
import * as renderer from '../../../src/utils/render-ink-until-exit.js';

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
    payments: [
      { authentication: 'required', name: 'mpp', options: ['inflow', 'tempo'] },
      { authentication: 'not-required', name: 'x402', options: ['arc', 'monad'] },
    ],
    trust: [],
  },
  document: {
    description: 'Compute catalog',
    documentation_url: '/developers/',
    http: { endpoint_base: '/odp' },
    language: 'en',
    localizations: ['en'],
    mcp: [
      {
        description: 'Browse the compute catalog.',
        name: 'Catalog',
        type: 'streamable-http',
        url: '/mcp',
      },
      { type: 'streamable-http', url: 'https://automation.compute.example/mcp' },
    ],
    name: 'Compute',
    odp_version: '1.0',
    operations,
    protocols: {
      enrollment: [{ name: 'aep' }],
      payments: [
        { authentication: 'required', name: 'mpp', options: ['inflow', 'tempo'] },
        { authentication: 'not-required', name: 'x402', options: ['arc', 'monad'] },
      ],
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
  it.each([
    { query: 'compute', parentId: undefined, limit: undefined },
    { query: undefined, parentId: 'infrastructure', limit: undefined },
    { query: 'compute', parentId: 'infrastructure', limit: 5 },
  ])('forwards only the selected Collection search constraints: %j', async (filters) => {
    const { resource, service } = collectionResource();
    const result = await __testing.runCollectionSearch(resource, {
      service: 'https://compute.example',
      language: undefined,
      next: undefined,
      ...filters,
    });
    expect(result.items).toEqual([collection]);
    expect(service.searchCollections).toHaveBeenCalledWith({
      representation: 'terse',
      maxPages: 1,
      ...(filters.query === undefined ? {} : { query: filters.query }),
      ...(filters.parentId === undefined ? {} : { parent_id: filters.parentId }),
      ...(filters.limit === undefined ? {} : { limit: filters.limit }),
    });
    expect(service.continueSearchCollections).not.toHaveBeenCalled();
  });

  it('renders root Collections and a Service without MCP without inventing metadata', () => {
    const root: Collection = { id: 'root', name: 'Root Collection', odp_version: '1.0' };
    const list = render(
      <CollectionsView command="list" page={{ items: [root], odp_version: '1.0' }} service="https://compute.example" />,
    );
    const detail = render(<CollectionView collection={root} serviceOrigin="https://compute.example" />);
    const document = { ...inspection.document };
    delete document.mcp;
    const service = render(<InspectionView inspection={{ ...inspection, document }} />);
    try {
      expect(list.lastFrame()).toContain('Root Collection');
      expect(detail.lastFrame()).toContain('Root Collection');
      expect(list.lastFrame()).not.toContain('infrastructure');
      expect(detail.lastFrame()).not.toContain('infrastructure');
      expect(service.lastFrame()).not.toContain('MCP endpoints');
    } finally {
      list.unmount();
      detail.unmount();
      service.unmount();
    }
  });

  it('registers all discovery groups without inspecting a Service or reading credentials', async () => {
    const storage = new MemoryStorage();
    const credentials = vi.spyOn(storage, 'getApiKey');
    const fetch = vi.spyOn(globalThis, 'fetch');
    const output: string[] = [];
    try {
      const client = new Inflow({ authStorage: storage });
      credentials.mockClear();
      await createOdpCli(client.odp).serve(['--help'], {
        exit: vi.fn(),
        stdout: (chunk) => {
          output.push(chunk);
        },
      });
      for (const command of ['inspect', 'actions', 'collections', 'offerings'])
        expect(output.join('')).toContain(command);
      expect(fetch).not.toHaveBeenCalled();
      expect(credentials).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      credentials.mockRestore();
    }
  });
  it('rejects a Collection continuation combined with a new page limit before fetching', async () => {
    const { resource } = collectionResource();
    await expect(
      __testing.runCollectionList(resource, {
        service: 'https://compute.example',
        language: undefined,
        limit: 5,
        next: '/odp/collections?cursor=next',
        parentId: undefined,
        query: undefined,
      }),
    ).rejects.toMatchObject({ detail: { code: 'ODP_COLLECTION_NEXT_CONFLICT', exitCode: 2 } });
    expect(resource.service).not.toHaveBeenCalled();
  });

  it.each(['list', 'get', 'search'])('renders Collection %s in a human terminal', async (command) => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const rendered = vi.spyOn(renderer, 'renderInkUntilExit').mockResolvedValue(undefined);
    const { resource } = collectionResource();
    try {
      await createCollectionsCli(resource).serve(
        command === 'list' ? [command, 'https://compute.example'] : [command, 'https://compute.example', 'compute'],
        { exit: vi.fn(), stdout: vi.fn() },
      );
      expect(rendered).toHaveBeenCalledOnce();
      const element = rendered.mock.calls[0]?.[0];
      if (element === undefined) throw new Error('Missing Collection view');
      const view = render(element);
      expect(view.lastFrame()).toContain('Compute');
      view.unmount();
    } finally {
      rendered.mockRestore();
      if (descriptor === undefined) Reflect.deleteProperty(process.stdout, 'isTTY');
      else Object.defineProperty(process.stdout, 'isTTY', descriptor);
    }
  });

  it.each([
    ['aborted', undefined, 'ODP_REQUEST_ABORTED', true],
    ['http_error', undefined, 'ODP_INSPECT_HTTP_ERROR', true],
    ['http_error', 429, 'ODP_INSPECT_HTTP_ERROR', true],
    ['http_error', 503, 'ODP_INSPECT_HTTP_ERROR', true],
    ['http_error', 404, 'ODP_INSPECT_HTTP_ERROR', false],
    ['invalid_json', undefined, 'ODP_INSPECT_JSON_INVALID', false],
    ['invalid_media_type', undefined, 'ODP_INSPECT_MEDIA_TYPE_INVALID', false],
    ['invalid_redirect', undefined, 'ODP_INSPECT_REDIRECT_REJECTED', false],
    ['response_too_large', undefined, 'ODP_INSPECT_RESPONSE_TOO_LARGE', false],
    ['validation_failed', undefined, 'ODP_INSPECT_DOCUMENT_INVALID', false],
  ] as const)(
    'classifies inspection failure %s / %s without exposing its internal message',
    (kind, status, code, retryable) => {
      let caught: unknown;
      try {
        odpServiceFailure(new OdpInspectionError('private diagnostic', kind, status), 'FAILED', 'Inspection failed.');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OdpCommandError);
      expect(caught).toMatchObject({ detail: { code, message: 'Inspection failed.', retryable } });
    },
  );

  it.each([{ query: 'compute' }, { parentId: 'infrastructure' }, { limit: 10 }])(
    'rejects collection continuation conflicts before creating a client: %j',
    async (conflict) => {
      const { resource } = collectionResource();
      await expect(
        __testing.runCollectionSearch(resource, {
          language: undefined,
          limit: undefined,
          next: '/odp/collections/search?cursor=next',
          parentId: undefined,
          query: undefined,
          service: 'https://compute.example',
          ...conflict,
        }),
      ).rejects.toMatchObject({ detail: { code: 'ODP_COLLECTION_NEXT_CONFLICT', exitCode: 2 } });
      expect(resource.service).not.toHaveBeenCalled();
    },
  );

  it('preserves a collection list continuation and avoids a fresh inspection', async () => {
    const { resource, service } = collectionResource();
    const next = '/odp/collections?cursor=a%2Fb%3D';
    const result = await __testing.runCollectionList(resource, {
      language: 'ja',
      limit: undefined,
      next,
      parentId: undefined,
      query: undefined,
      service: 'https://compute.example',
    });
    expect(result.items).toEqual([collection]);
    expect(resource.service).toHaveBeenCalledWith({ serviceUrl: 'https://compute.example', acceptLanguage: 'ja' });
    expect(service.continueListCollections).toHaveBeenCalledWith(next, { maxPages: 1, representation: 'terse' });
    expect(service.inspect).not.toHaveBeenCalled();
    expect(service.listCollections).not.toHaveBeenCalled();
  });

  it('does not query an unadvertised collection operation or suggest an unavailable alternative', async () => {
    const { resource, service } = collectionResource();
    service.inspect.mockResolvedValue({ ...inspection, capabilities: { ...inspection.capabilities, operations: [] } });
    await expect(__testing.runCollectionGet(resource, 'https://compute.example', 'compute')).rejects.toMatchObject({
      detail: {
        code: 'ODP_OPERATION_NOT_SUPPORTED',
        retryable: false,
        message: 'This Service does not advertise get-collection. The Service advertises no ODP operations.',
      },
    });
    expect(service.getCollection).not.toHaveBeenCalled();
  });

  it('preserves locked-vault errors from credential lookup and signing', () => {
    expect.assertions(2);
    const locked = new SecureStorageError('vault_locked', 'Unlock the vault.');
    for (const cause of [locked, new TapSigningError(locked)]) {
      try {
        odpServiceFailure(new OdpInspectionError('fetch failed', 'http_error', undefined, cause), 'FAILED', 'Failed.');
      } catch (error) {
        expect(error).toMatchObject({ detail: { code: 'VAULT_LOCKED', message: 'Unlock the vault.' } });
      }
    }
  });
  it('identifies platform signing failures wrapped by ODP without printing underlying secrets', () => {
    expect.assertions(4);
    const signing = new TapSigningError(new Error('secret'));
    for (const error of [signing, new OdpInspectionError('fetch failed', 'http_error', undefined, signing)]) {
      try {
        odpServiceFailure(error, 'FALLBACK', 'Service failed.');
      } catch (failure) {
        expect(failure).toBeInstanceOf(OdpCommandError);
        if (!(failure instanceof OdpCommandError)) throw failure;
        expect(failure.detail).toEqual({
          code: 'TAP_SIGNING_FAILED',
          message: 'InFlow TAP signing failed. The Service request was not sent.',
          retryable: false,
        });
      }
    }
  });
  it('reports blocked inspection destinations without retrying', () => {
    expect.assertions(1);
    try {
      odpServiceFailure(
        new OdpInspectionError('Blocked destination', 'blocked_destination'),
        'FAILED',
        'Inspection failed.',
      );
    } catch (error) {
      expect(error).toMatchObject({
        detail: { code: 'ODP_INSPECT_DESTINATION_BLOCKED', message: 'Inspection failed.', retryable: false },
      });
    }
  });

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

    expect(JSON.parse(output.join(''))).toMatchObject({ document: { mcp: inspection.document.mcp } });
  });

  it('renders native inspection in a human terminal', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const rendered = vi.spyOn(renderer, 'renderInkUntilExit').mockResolvedValue(undefined);
    try {
      await createInspectCli({ inspect: vi.fn(() => Promise.resolve(inspection)) }).serve(
        ['inspect', 'https://compute.example'],
        { exit: vi.fn(), stdout: vi.fn() },
      );
      expect(rendered).toHaveBeenCalledOnce();
    } finally {
      rendered.mockRestore();
      if (descriptor === undefined) Reflect.deleteProperty(process.stdout, 'isTTY');
      else Object.defineProperty(process.stdout, 'isTTY', descriptor);
    }
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
    expect(lastFrame()).toContain('AEP');
    expect(lastFrame()).toContain('MPP: InFlow, Tempo (authentication required)');
    expect(lastFrame()).toContain('x402: Arc, Monad');
    expect(lastFrame()).toContain('MCP endpoints');
    expect(lastFrame()).toContain('Catalog');
    expect(lastFrame()).toContain('Streamable HTTP');
    expect(lastFrame()).toContain('https://compute.example/mcp');
    expect(lastFrame()).toContain('https://automation.compute.example/mcp');
    expect(lastFrame()).toContain('Browse the compute catalog.');
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
        collection={{
          ...collection,
          description: 'Compute products',
          images: [
            {
              alt: 'GPU server rack',
              height: 800,
              src: '/images/compute.webp',
              type: 'image/webp',
              width: 1200,
            },
            { src: 'https://cdn.compute.example/compute-detail.webp' },
          ],
          web_url: '/collections/compute',
        }}
        serviceOrigin="https://compute.example"
      />,
    );
    expect(detail.lastFrame()).toContain('Compute products');
    expect(detail.lastFrame()).toContain('Parent Collections');
    expect(detail.lastFrame()).toContain('https://compute.example/collections/compute');
    expect(detail.lastFrame()).toContain('Images');
    expect(detail.lastFrame()).toContain('GPU server rack');
    expect(detail.lastFrame()).toContain('1200 x 800');
    expect(detail.lastFrame()).toContain('image/webp');
    expect(detail.lastFrame()).toContain('https://compute.example/images/compute.webp');
    expect(detail.lastFrame()).toContain('https://cdn.compute.example/compute-detail.webp');
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
