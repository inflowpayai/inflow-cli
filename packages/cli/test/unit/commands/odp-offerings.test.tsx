import type {
  DirectoryService,
  FederatedDiscoveryEvent,
  OfferingDetails,
  OfferingPage,
  SearchCapabilityCatalog,
  ServiceInspection,
  TerseOffering,
} from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import {
  DiscoveryView,
  OfferingCapabilitiesView,
  OfferingView,
  OfferingsView,
  __testing,
  createOfferingsCli,
} from '../../../src/commands/odp/offerings.js';
import { OdpCommandError } from '../../../src/commands/odp/command.js';
import { pricePreviewDetails } from '../../../src/commands/odp/presentation.js';
import * as renderer from '../../../src/utils/render-ink-until-exit.js';

const offering: TerseOffering = { description: 'On-demand accelerator capacity.', id: 'gpu-a100', name: 'A100 GPU' };
const priceCases: Array<[NonNullable<TerseOffering['price']>, string]> = [
  [{ amount: '1', currency: 'USDC', type: 'fixed' }, 'fixed - one advertised price'],
  [{ type: 'free' }, 'free - no price is required'],
  [{ amount: '1', currency: 'USDC', type: 'metered', unit: 'hour' }, 'metered - a price per advertised unit'],
  [{ type: 'quote' }, 'quote - the price is determined by a later action'],
  [{ currency: 'USDC', maximum: '2', minimum: '1', type: 'range' }, 'range - an advertised minimum-to-maximum price'],
  [{ amount: '1', currency: 'USDC', type: 'starting_at' }, 'starting_at - the lowest advertised starting price'],
];
const directoryService: DirectoryService = {
  description: 'Compute catalog',
  indexed_at: '2026-08-03T00:00:00Z',
  language: 'en',
  localizations: ['en'],
  name: 'Compute',
  operations: [{ authentication: 'not-required', name: 'search-offerings' }],
  service_origin: 'https://compute.example',
};
const listCollectionOfferingsOperation = {
  authentication: 'not-required',
  name: 'list-collection-offerings',
} as const;
const operations = [
  { authentication: 'not-required', name: 'get-offering' },
  listCollectionOfferingsOperation,
  { authentication: 'not-required', name: 'list-offerings' },
  { authentication: 'not-required', name: 'search-offerings' },
] satisfies ServiceInspection['capabilities']['operations'];
const inspection: ServiceInspection = {
  capabilities: { enrollment: [], operations, payments: [], trust: [] },
  document: {
    description: 'Compute catalog',
    http: { endpoint_base: '/odp' },
    language: 'en',
    localizations: ['en'],
    name: 'Compute',
    odp_version: '1.0',
    operations,
    protocols: {},
  },
  finalUrl: new URL('https://compute.example/.well-known/odp'),
  freshness: 'fetched',
  requestedUrl: new URL('https://compute.example/.well-known/odp'),
  serviceOrigin: 'https://compute.example',
};
const searchCapabilities = {
  filters: new Map([
    ['memory', { description: 'GPU memory', id: 'memory', operators: ['gte'], title: 'Memory', type: 'number' }],
  ]),
  issues: [],
  sorts: new Map([
    ['price-lowest', { description: 'Lowest price', filters: [], id: 'price-lowest', keys: [], title: 'Lowest price' }],
  ]),
} satisfies SearchCapabilityCatalog;

function sequence(page: OfferingPage<TerseOffering>) {
  return {
    pages: {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield page;
      },
    },
  };
}

function offeringResource() {
  const page = sequence({ items: [offering], odp_version: '1.0' });
  const service = {
    continueListOfferings: vi.fn(() => page),
    continueSearchOfferings: vi.fn(() => page),
    getOffering: vi.fn(() => Promise.resolve({ ...offering, odp_version: '1.0' } satisfies OfferingDetails)),
    getOfferingSearchCapabilities: vi.fn(() => Promise.resolve(searchCapabilities)),
    inspect: vi.fn(() => Promise.resolve(inspection)),
    listCollectionOfferings: vi.fn(() => page),
    listOfferings: vi.fn(() => page),
    searchOfferings: vi.fn(() => page),
  };
  return {
    resource: {
      searchOfferingsAcrossServices: vi.fn(() => events([{ offering, service: directoryService, type: 'offering' }])),
      service: vi.fn(() => service),
    },
    service,
  };
}

function events(values: FederatedDiscoveryEvent[]): AsyncIterable<FederatedDiscoveryEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield* values;
    },
  };
}

function failingSequence() {
  return {
    pages: {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        throw new TypeError('private Offering failure');
      },
    },
  };
}

function failingEvents(): AsyncIterable<FederatedDiscoveryEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      throw new TypeError('private Offering failure');
    },
  };
}

const emptyPageInput = {
  collectionId: undefined,
  filters: [],
  includeDescendants: undefined,
  language: undefined,
  limit: undefined,
  next: undefined,
  query: undefined,
  refinements: [],
  service: 'https://compute.example',
  sort: undefined,
};

describe('ODP Offering commands', () => {
  it.each(['list', 'search'])('preserves the continuation returned by the %s command', async (command) => {
    const { resource, service } = offeringResource();
    const page = sequence({ items: [offering], odp_version: '1.0', next: 'opaque-next-page' });
    service.listOfferings.mockReturnValue(page);
    service.searchOfferings.mockReturnValue(page);
    const output: string[] = [];
    await createOfferingsCli(resource).serve(
      [command, 'https://compute.example', ...(command === 'search' ? ['gpu'] : []), '--format', 'json'],
      {
        exit: vi.fn(),
        stdout: (chunk) => output.push(chunk),
      },
    );
    expect(output.join('')).toContain('opaque-next-page');
  });

  it('renders filters that have no physical unit', () => {
    const view = render(
      <OfferingCapabilitiesView
        result={{
          filters: [...searchCapabilities.filters.values()],
          sorts: [],
          issues: [],
          service_origin: 'https://compute.example',
        }}
      />,
    );
    try {
      expect(view.lastFrame()).toContain('Memory');
      expect(view.lastFrame()).toContain('None');
    } finally {
      view.unmount();
    }
  });
  it('searches by structured filters without inventing a text query and preserves the page limit', async () => {
    const { resource, service } = offeringResource();
    await __testing.runOfferingSearch(resource, {
      ...emptyPageInput,
      limit: 7,
      filters: [{ id: 'memory', operator: 'gte', value: 16 }],
    });
    expect(service.searchOfferings).toHaveBeenCalledWith({
      filters: [{ id: 'memory', operator: 'gte', value: 16 }],
      limit: 7,
      maxPages: 1,
      representation: 'terse',
    });
  });

  it('renders empty discovery and Offerings without descriptions without inventing values', () => {
    const empty = render(<DiscoveryView items={[]} />);
    const minimal = render(
      <OfferingsView command="list" service="https://compute.example" offerings={[{ id: 'one', name: 'One' }]} />,
    );
    try {
      expect(empty.lastFrame()).toContain('No Offerings found.');
      expect(minimal.lastFrame()).toContain('One');
      expect(minimal.lastFrame()).not.toContain('undefined');
    } finally {
      empty.unmount();
      minimal.unmount();
    }
  });

  it.each(['list', 'get', 'search'])('renders Offering %s in a human terminal', async (command) => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const rendered = vi.spyOn(renderer, 'renderInkUntilExit').mockResolvedValue(undefined);
    const { resource } = offeringResource();
    try {
      await createOfferingsCli(resource).serve(
        command === 'list' ? [command, 'https://compute.example'] : [command, 'https://compute.example', 'gpu-a100'],
        { exit: vi.fn(), stdout: vi.fn() },
      );
      expect(rendered).toHaveBeenCalledOnce();
      const element = rendered.mock.calls[0]?.[0];
      if (element === undefined) throw new Error('Missing Offering view');
      const view = render(element);
      expect(view.lastFrame()).toContain('A100 GPU');
      view.unmount();
    } finally {
      rendered.mockRestore();
      if (descriptor === undefined) Reflect.deleteProperty(process.stdout, 'isTTY');
      else Object.defineProperty(process.stdout, 'isTTY', descriptor);
    }
  });

  it.each([{ collectionId: 'compute' }, { limit: 10 }])(
    'rejects list continuation conflicts before creating a client: %j',
    async (conflict) => {
      const { resource } = offeringResource();
      await expect(
        __testing.runOfferingList(resource, {
          ...emptyPageInput,
          next: '/odp/offerings?cursor=opaque',
          ...conflict,
        }),
      ).rejects.toMatchObject({ detail: { code: 'ODP_OFFERING_NEXT_CONFLICT', exitCode: 2 } });
      expect(resource.service).not.toHaveBeenCalled();
    },
  );

  it.each([
    { collectionId: 'compute' },
    { filters: [{ id: 'memory', operator: 'gte', value: 80 }] },
    { includeDescendants: false },
    { limit: 10 },
    { query: 'gpu' },
    { refinements: ['memory'] },
    { sort: 'price-lowest' },
  ])('rejects search continuation conflicts before creating a client: %j', async (conflict) => {
    const { resource } = offeringResource();
    await expect(
      __testing.runOfferingSearch(resource, {
        ...emptyPageInput,
        next: '/odp/offerings/search?cursor=opaque',
        ...conflict,
      }),
    ).rejects.toMatchObject({ detail: { code: 'ODP_OFFERING_NEXT_CONFLICT', exitCode: 2 } });
    expect(resource.service).not.toHaveBeenCalled();
  });

  it('continues a list without inspecting or restarting the catalog', async () => {
    const { resource, service } = offeringResource();
    const next = '/odp/offerings?cursor=a%2Fb%3D';
    const result = await __testing.runOfferingList(resource, { ...emptyPageInput, next });
    expect(result.items).toEqual([offering]);
    expect(service.continueListOfferings).toHaveBeenCalledWith(next, { maxPages: 1, representation: 'terse' });
    expect(service.inspect).not.toHaveBeenCalled();
    expect(service.listOfferings).not.toHaveBeenCalled();
  });

  it('stops after the first page and closes the iterator', async () => {
    const { resource, service } = offeringResource();
    const closed = vi.fn();
    const secondPage = vi.fn();
    service.listOfferings.mockReturnValue({
      pages: {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          try {
            yield { items: [offering], odp_version: '1.0', next: '/odp/offerings?cursor=next' };
            secondPage();
            yield { items: [], odp_version: '1.0' };
          } finally {
            closed();
          }
        },
      },
    });
    await expect(__testing.runOfferingList(resource, emptyPageInput)).resolves.toMatchObject({
      items: [offering],
      next: '/odp/offerings?cursor=next',
    });
    expect(closed).toHaveBeenCalledOnce();
    expect(secondPage).not.toHaveBeenCalled();
  });

  it.each(['null', '[]', '42', 'true', '"memory"'])('rejects non-object filters: %s', (value) => {
    expect(() => __testing.parseFilters([value])).toThrow(OdpCommandError);
  });

  it('preserves structured filters without changing their values', () => {
    const filter = { id: 'memory', operator: 'gte', value: 80 };
    expect(__testing.parseFilters([JSON.stringify(filter)])).toEqual([filter]);
  });

  it.each([
    [{}, 'list-offerings'],
    [{ query: 'gpu' }, 'search-offerings'],
    [{ filters: [{ id: 'memory', operator: 'gte', value: 80 }] }, 'search-offerings'],
    [{ includeDescendants: false }, 'search-offerings'],
    [{ refinements: ['memory'] }, 'search-offerings'],
    [{ sort: 'price-lowest' }, 'search-offerings'],
  ] as const)('selects directory capabilities for discovery inputs %j', async (overrides, operation) => {
    const { resource } = offeringResource();
    await __testing.runOfferingDiscovery(resource, {
      collectionId: undefined,
      concurrency: undefined,
      includeDescendants: undefined,
      keywords: [],
      maxOfferingsPerService: undefined,
      maxServices: undefined,
      withAep: false,
      operations: [],
      payments: [],
      query: undefined,
      serviceQuery: undefined,
      sort: undefined,
      ...overrides,
      filters: 'filters' in overrides ? [...overrides.filters] : [],
      refinements: 'refinements' in overrides ? [...overrides.refinements] : [],
    });
    expect(resource.searchOfferingsAcrossServices).toHaveBeenCalledWith({
      offerings: {
        ...('query' in overrides ? { query: overrides.query } : {}),
        ...('filters' in overrides ? { filters: overrides.filters } : {}),
        ...('includeDescendants' in overrides ? { include_descendants: false } : {}),
        ...('refinements' in overrides ? { refinements: overrides.refinements } : {}),
        ...('sort' in overrides ? { sort: overrides.sort } : {}),
      },
      services: { filters: { operations: [{ name: operation }] } },
    });
  });

  it.each(priceCases)('describes the %s Price Preview type', (price, description) => {
    expect(pricePreviewDetails(price).map((row) => row.value)).toContain(description);
  });

  it('omits a Price Preview when none is advertised', () => {
    expect(pricePreviewDetails(undefined)).toEqual([]);
  });

  it('returns an empty page when a client sequence has no pages', async () => {
    const { resource, service } = offeringResource();
    service.listOfferings.mockReturnValue({
      pages: {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield* [];
        },
      },
    });
    await expect(__testing.runOfferingList(resource, emptyPageInput)).resolves.toEqual({
      items: [],
      odp_version: '1.0',
      service_origin: 'https://compute.example',
    });
  });

  it('renders optional metadata, OpenAPI actions, and unresolved action issues', () => {
    const output = render(
      <OfferingView
        serviceOrigin="https://compute.example"
        offering={{
          id: 'gpu',
          name: 'GPU',
          odp_version: '1.0',
          web_url: '/gpu',
          language: 'en',
          localizations: ['en', 'ja'],
          collection_ids: ['compute'],
          schema: { url: '/schemas/gpu' },
          actions: [
            {
              id: 'quote',
              rel: 'quote',
              authentication: 'optional',
              target: { kind: 'openapi', url: '/openapi.json', operation_id: 'quoteGpu' },
            },
            {
              id: 'details',
              rel: 'invoke',
              authentication: 'not-required',
              target: { kind: 'http', method: 'GET', url: '/gpu/details' },
            },
          ],
          issues: [
            { scope: 'attribute_schema', message: 'Schema unavailable' },
            { scope: 'action', action_id: 'quote', message: 'Operation unavailable' },
          ],
        }}
      />,
    ).lastFrame();
    expect(output).toContain('https://compute.example/gpu');
    expect(output).toContain('https://compute.example/schemas/gpu');
    expect(output).toContain('Localizations');
    expect(output).toContain('ja');
    expect(output).toContain('Optional');
    expect(output).toContain('Not required');
    expect(output).toContain('OpenAPI');
    expect(output).toContain('https://compute.example/openapi.json#operationId=quoteGpu');
    expect(output).toContain('Schema unavailable');
    expect(output).toContain('Operation unavailable');
    expect(output).not.toContain('Price Preview');
    expect(output).not.toContain('Attributes');
  });

  it('lists one terse Offering page for a Collection', async () => {
    const { resource, service } = offeringResource();
    const result = await __testing.runOfferingList(resource, {
      ...emptyPageInput,
      collectionId: 'compute',
      language: 'en',
      limit: 25,
    });

    expect(result).toEqual({ items: [offering], odp_version: '1.0', service_origin: 'https://compute.example' });
    expect(resource.service).toHaveBeenCalledWith({ acceptLanguage: 'en', serviceUrl: 'https://compute.example' });
    expect(service.listCollectionOfferings).toHaveBeenCalledWith('compute', {
      limit: 25,
      maxPages: 1,
      representation: 'terse',
    });
  });

  it('searches Offerings with structured filters', async () => {
    const { resource, service } = offeringResource();
    await __testing.runOfferingSearch(resource, {
      ...emptyPageInput,
      collectionId: 'compute',
      filters: [{ id: 'memory', operator: 'gte', value: 80 }],
      includeDescendants: true,
      query: 'gpu',
      refinements: ['memory'],
      sort: 'price-lowest',
    });

    expect(service.searchOfferings).toHaveBeenCalledWith({
      collection_id: 'compute',
      filters: [{ id: 'memory', operator: 'gte', value: 80 }],
      include_descendants: true,
      maxPages: 1,
      query: 'gpu',
      refinements: ['memory'],
      representation: 'terse',
      sort: 'price-lowest',
    });
  });

  it('rejects Offering search without a query or filter before contacting the Service', async () => {
    const { resource, service } = offeringResource();

    await expect(__testing.runOfferingSearch(resource, emptyPageInput)).rejects.toMatchObject({
      detail: {
        code: 'ODP_OFFERING_SEARCH_INPUT_REQUIRED',
        message: 'A query or --filter is required. Use `offerings list` for an unconstrained request.',
      },
    });
    expect(resource.service).not.toHaveBeenCalled();
    expect(service.searchOfferings).not.toHaveBeenCalled();
  });

  it('resolves effective Offering search capabilities into JSON-friendly arrays', async () => {
    const { resource } = offeringResource();

    await expect(
      __testing.runOfferingCapabilities(resource, 'https://compute.example', 'compute', 'en'),
    ).resolves.toEqual({
      filters: [{ description: 'GPU memory', id: 'memory', operators: ['gte'], title: 'Memory', type: 'number' }],
      issues: [],
      service_origin: 'https://compute.example',
      sorts: [{ description: 'Lowest price', filters: [], id: 'price-lowest', keys: [], title: 'Lowest price' }],
    });
  });

  it('directs unsupported Offering search to the advertised scoped list operation', async () => {
    const { resource, service } = offeringResource();
    service.inspect.mockResolvedValue({
      ...inspection,
      capabilities: { ...inspection.capabilities, operations: [listCollectionOfferingsOperation] },
    });

    try {
      await __testing.runOfferingSearch(resource, {
        ...emptyPageInput,
        collectionId: 'compute',
        query: 'gpu',
      });
      throw new Error('Expected Offering search to reject an unadvertised operation.');
    } catch (error) {
      expect(error).toBeInstanceOf(OdpCommandError);
      if (error instanceof OdpCommandError) {
        expect(error.detail.code).toBe('ODP_OPERATION_NOT_SUPPORTED');
        expect(error.detail.message).toContain('inflow odp offerings list <service> --collection-id <collection-id>');
        expect(error.detail.retryable).toBe(false);
      }
    }
    expect(service.searchOfferings).not.toHaveBeenCalled();
  });

  it('delegates opaque Offering continuations to the client', async () => {
    const { resource, service } = offeringResource();
    await __testing.runOfferingSearch(resource, {
      ...emptyPageInput,
      next: '/odp/offerings/search?cursor=opaque',
    });
    expect(service.continueSearchOfferings).toHaveBeenCalledWith('/odp/offerings/search?cursor=opaque', {
      maxPages: 1,
      representation: 'terse',
    });
  });

  it('gets enriched full Offering details', async () => {
    const { resource, service } = offeringResource();
    await expect(__testing.runOfferingGet(resource, 'https://compute.example', 'gpu-a100', undefined)).resolves.toEqual(
      {
        offering: { ...offering, odp_version: '1.0' },
        service_origin: 'https://compute.example',
      },
    );
    expect(service.getOffering).toHaveBeenCalledWith('gpu-a100', { representation: 'full' });
  });

  it('discovers across selected Services and silently drops issue events', async () => {
    const service = directoryService;
    const searchOfferingsAcrossServices = vi.fn(() =>
      events([
        { offering, service, type: 'offering' },
        { issue: { cause: new Error('offline'), message: 'offline' }, service, type: 'issue' },
      ]),
    );
    const resource = { searchOfferingsAcrossServices, service: vi.fn() };

    const result = await __testing.runOfferingDiscovery(resource, {
      collectionId: undefined,
      concurrency: 4,
      filters: [],
      includeDescendants: undefined,
      keywords: ['gpu'],
      maxOfferingsPerService: 5,
      maxServices: 10,
      withAep: true,
      operations: ['search-offerings'],
      payments: ['mpp:inflow', 'mpp:tempo'],
      query: 'a100',
      refinements: [],
      serviceQuery: 'compute',
      sort: undefined,
    });

    expect(result).toEqual({ items: [{ offering, service }] });
    expect(searchOfferingsAcrossServices).toHaveBeenCalledWith({
      concurrency: 4,
      maxOfferingsPerService: 5,
      maxServices: 10,
      offerings: { query: 'a100' },
      services: {
        filters: {
          enrollment: [{ name: 'aep' }],
          keywords: ['gpu'],
          operations: [{ name: 'search-offerings' }],
          payments: [{ name: 'mpp', options: ['inflow', 'tempo'] }],
        },
        query: 'compute',
      },
    });
  });

  it('rejects malformed filter JSON before calling a Service', () => {
    try {
      __testing.parseFilters(['not-json']);
      throw new Error('Expected filter parsing to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(OdpCommandError);
      if (error instanceof OdpCommandError) expect(error.detail.code).toBe('ODP_FILTER_JSON_INVALID');
    }
  });

  it('derives the directory operation for aggregate Offering discovery', async () => {
    const { resource } = offeringResource();

    await __testing.runOfferingDiscovery(resource, {
      collectionId: 'compute',
      concurrency: undefined,
      withAep: false,
      filters: [],
      includeDescendants: undefined,
      keywords: [],
      maxOfferingsPerService: undefined,
      maxServices: undefined,
      operations: [],
      payments: [],
      query: undefined,
      refinements: [],
      serviceQuery: undefined,
      sort: undefined,
    });

    expect(resource.searchOfferingsAcrossServices).toHaveBeenCalledWith({
      offerings: { collection_id: 'compute' },
      services: { filters: { operations: [{ name: 'list-collection-offerings' }] } },
    });
  });

  it('renders Offering lists and enriched details for interactive terminals', () => {
    const page = render(
      <OfferingsView
        command="list"
        next="/odp/offerings?cursor=next"
        offerings={[{ ...offering, price: { amount: '0.014', currency: 'USDC', type: 'fixed' } }]}
        service="https://compute.example/catalog"
      />,
    ).lastFrame();
    expect(page).toContain('A100 GPU');
    expect(page).toContain('0.014 USDC');
    expect(page).toContain('On-demand accelerator capacity.');
    expect(page).toMatch(/Name\s+Price\s+Description\s+ID/u);
    expect(page).toContain("inflow odp offerings list 'https://compute.example/catalog' --next");
    expect(
      render(<OfferingsView command="list" offerings={[]} service="https://compute.example" />).lastFrame(),
    ).toContain('No Offerings found');
    const details = render(
      <OfferingView
        offering={{
          ...offering,
          actions: [
            {
              authentication: 'required',
              id: 'purchase',
              rel: 'purchase',
              target: { kind: 'http', method: 'POST', url: 'https://compute.example/actions/purchase' },
            },
          ],
          attribute_schema: {
            $defs: { image: { format: 'uri-reference', title: 'Image', type: 'string' } },
            properties: { image: { $ref: '#/$defs/image' } },
            type: 'object',
          },
          attributes: { image: '/images/a100.png' },
          description: 'On-demand GPU',
          images: [
            {
              alt: 'A100 GPU front view',
              height: 800,
              src: '/images/a100-front.webp',
              type: 'image/webp',
              width: 1200,
            },
            { src: 'https://cdn.example/a100-back.webp' },
          ],
          odp_version: '1.0',
          price: { amount: '0.014', currency: 'USDC', type: 'fixed' },
        }}
        serviceOrigin="https://compute.example"
      />,
    ).lastFrame();
    expect(details).toContain('On-demand GPU');
    expect(details).toContain('https://compute.example/images/a100.png');
    expect(details).toContain('Images');
    expect(details).toContain('A100 GPU front view');
    expect(details).toContain('1200 x 800');
    expect(details).toContain('image/webp');
    expect(details).toContain('https://compute.example/images/a100-front.webp');
    expect(details).toContain('https://cdn.example/a100-back.webp');
    expect(details).toContain('Price Preview');
    expect(details).toContain('fixed - one advertised price');
    expect(details).toContain('Available Actions');
    expect(details).toContain('Action ID');
    expect(details).toContain('https://compute.example/actions/purchase');
    const discovery = render(<DiscoveryView items={[{ offering, service: directoryService }]} />).lastFrame();
    expect(discovery).toContain('Compute');
    expect(discovery).toContain('https://compute.example');
  });

  it('renders Offering search filters, sorts, and capability issues', () => {
    const capabilities = render(
      <OfferingCapabilitiesView
        result={{
          filters: [
            {
              description: 'GPU memory',
              id: 'memory',
              operators: ['gte'],
              title: 'Memory',
              type: 'number',
              unit: { code: 'GiBy', system: 'ucum' },
            },
          ],
          issues: [{ kind: 'sorts', message: 'Collection sort document was unavailable.', scope: 'collection' }],
          service_origin: 'https://compute.example',
          sorts: [
            {
              description: 'Highest memory first',
              filters: [],
              id: 'memory-highest',
              keys: [{ direction: 'descending', filter_id: 'memory', missing: 'last' }],
              title: 'Highest memory',
            },
          ],
        }}
      />,
    ).lastFrame();

    expect(capabilities).toContain('Filters');
    expect(capabilities).toContain('GiBy');
    expect(capabilities).toContain('Sorts');
    expect(capabilities).toContain('memory descending');
    expect(capabilities).toContain('Issues');
    expect(capabilities).toContain('Collection sort document was unavailable.');

    const empty = render(
      <OfferingCapabilitiesView
        result={{ filters: [], issues: [], service_origin: 'https://compute.example', sorts: [] }}
      />,
    ).lastFrame();
    expect(empty).toContain('No filters advertised.');
    expect(empty).toContain('No sorts advertised.');
  });

  it.each([
    ['capabilities', ['capabilities', 'https://compute.example', '--format', 'json'], 'memory'],
    ['list', ['list', 'https://compute.example', '--format', 'json'], 'gpu-a100'],
    ['search', ['search', 'https://compute.example', 'gpu', '--format', 'json'], 'gpu-a100'],
    ['get', ['get', 'https://compute.example', 'gpu-a100', '--format', 'json'], 'gpu-a100'],
    ['discover', ['discover', 'gpu', '--format', 'json'], 'gpu-a100'],
  ] as const)('dispatches the registered %s command in agent mode', async (_name, argv, expected) => {
    const { resource } = offeringResource();
    const output: string[] = [];

    await createOfferingsCli(resource).serve([...argv], {
      exit: vi.fn(),
      stdout(chunk) {
        output.push(chunk);
      },
    });

    expect(output.join('')).toContain(expected);
  });

  it.each([
    ['capabilities', ['capabilities', 'https://compute.example'], 'ODP_OFFERING_CAPABILITIES_FAILED'],
    ['list', ['list', 'https://compute.example'], 'ODP_OFFERING_LIST_FAILED'],
    ['search', ['search', 'https://compute.example', 'gpu'], 'ODP_OFFERING_SEARCH_FAILED'],
    ['get', ['get', 'https://compute.example', 'gpu-a100'], 'ODP_OFFERING_GET_FAILED'],
    ['discover', ['discover', 'gpu'], 'ODP_OFFERING_DISCOVERY_FAILED'],
  ] as const)('returns a stable %s failure', async (_name, argv, code) => {
    const output: string[] = [];
    const exit = vi.fn();
    const failure = failingSequence();
    const service = {
      continueListOfferings: vi.fn(() => failure),
      continueSearchOfferings: vi.fn(() => failure),
      getOffering: vi.fn(() => Promise.reject(new TypeError('private Offering failure'))),
      getOfferingSearchCapabilities: vi.fn(() => Promise.reject(new TypeError('private Offering failure'))),
      inspect: vi.fn(() => Promise.resolve(inspection)),
      listCollectionOfferings: vi.fn(() => failure),
      listOfferings: vi.fn(() => failure),
      searchOfferings: vi.fn(() => failure),
    };
    const resource = {
      searchOfferingsAcrossServices: vi.fn(() => failingEvents()),
      service: vi.fn(() => service),
    };

    await createOfferingsCli(resource).serve([...argv], {
      exit,
      stdout(chunk) {
        output.push(chunk);
      },
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(output.join('')).toContain(code);
    expect(output.join('')).not.toContain('private Offering failure');
  });
});
