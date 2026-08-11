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
  capabilities: { enrollment: [], operations, payments: [] },
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
  it.each(priceCases)('describes the %s Price Preview type', (price, description) => {
    expect(pricePreviewDetails(price).map((row) => row.value)).toContain(description);
  });

  it('omits a Price Preview when none is advertised', () => {
    expect(pricePreviewDetails(undefined)).toEqual([]);
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
      enrollment: [],
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
      enrollment: [],
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
          odp_version: '1.0',
          price: { amount: '0.014', currency: 'USDC', type: 'fixed' },
        }}
        serviceOrigin="https://compute.example"
      />,
    ).lastFrame();
    expect(details).toContain('On-demand GPU');
    expect(details).toContain('https://compute.example/images/a100.png');
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
