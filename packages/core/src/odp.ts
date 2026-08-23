import {
  createOdpAgent,
  createOdpServiceClient,
  inspectService,
  type FederatedOfferingSearchRequest,
  type FederatedDiscoveryEvent,
  type InspectServiceOptions,
  type OdpAgent,
  type OdpServiceClient,
  type OdpServiceClientOptions,
  type ServiceInspection,
} from '@offering-protocol/agent';
import {
  createDirectoryClient,
  type DirectoryClient,
  type DirectoryIterationOptions,
  type DirectorySearchRequest,
  type DirectorySearchSequence,
  type DirectorySuggestionRequest,
} from '@offering-protocol/directory';
import type { InflowEnvironment } from './config.js';
import { sanitizeDeep } from './utils/sanitize-text.js';

export { PAYMENT_OPTIONS } from '@offering-protocol/core';
export { OdpInspectionError, OdpRequestError } from '@offering-protocol/agent';
export { DirectoryRequestError } from '@offering-protocol/directory';

export type {
  DirectorySearchPage,
  DirectorySearchRequest,
  DirectoryService,
  DirectoryServiceFilters,
  DirectorySuggestionRequest,
} from '@offering-protocol/directory';
export type {
  CollectionGetOptions,
  CollectionListOptions,
  CollectionSearchOptions,
  CollectionSequence,
  ContinuationOptions,
  OdpServiceClient,
  FederatedDiscoveryEvent,
  FederatedOfferingSearchRequest,
  OfferingDetails,
  OfferingGetOptions,
  OfferingListOptions,
  OfferingSearchOptions,
  ResolvedSortDefinition,
  SearchCapabilityCatalog,
  ResolvedAction,
  ServiceInspection,
} from '@offering-protocol/agent';
export type {
  Collection,
  FilterDefinition,
  McpEndpoint,
  Offering,
  OfferingPage,
  PageEnvelope,
  PaymentOption,
  PaymentProtocol,
  TerseCollection,
  TerseOffering,
} from '@offering-protocol/core';

export interface OdpServiceOptions extends Omit<OdpServiceClientOptions, 'serviceUrl' | 'transport'> {
  serviceUrl: string | URL;
  transport?: typeof globalThis.fetch;
}

export interface OdpInspectOptions extends Omit<InspectServiceOptions, 'fetch'> {
  fetch?: typeof globalThis.fetch;
}

export interface OdpServiceTransportOptions {
  cachePartition?: string;
  transport: typeof globalThis.fetch;
}

export interface IOdpResource {
  readonly environment: InflowEnvironment;
  searchServices(request?: DirectorySearchRequest): DirectorySearchSequence;
  continueSearchServices(next: string, options?: DirectoryIterationOptions): DirectorySearchSequence;
  suggestServices(request: DirectorySuggestionRequest): Promise<string[]>;
  searchOfferingsAcrossServices(request?: FederatedOfferingSearchRequest): AsyncIterable<FederatedDiscoveryEvent>;
  inspect(options: OdpInspectOptions): Promise<ServiceInspection>;
  service(options: OdpServiceOptions): OdpServiceClient;
  withServiceTransport(options: OdpServiceTransportOptions): IOdpResource;
}

export class OdpResource implements IOdpResource {
  readonly environment: InflowEnvironment;
  private readonly directory: DirectoryClient;
  private readonly agent: OdpAgent;
  private readonly transport: typeof globalThis.fetch;
  private readonly serviceTransport: typeof globalThis.fetch;
  private readonly serviceCachePartition: string | undefined;

  constructor(
    environment: InflowEnvironment,
    transport: typeof globalThis.fetch,
    serviceOptions?: OdpServiceTransportOptions,
  ) {
    this.environment = environment;
    this.transport = transport;
    this.serviceTransport = serviceOptions?.transport ?? transport;
    this.serviceCachePartition = serviceOptions?.cachePartition;
    this.directory = createDirectoryClient({ environment, transport });
    this.agent = createOdpAgent({
      environment,
      directoryTransport: transport,
      serviceClient: (service) =>
        createOdpServiceClient({
          serviceUrl: service.service_origin,
          transport: this.serviceTransport,
          ...(this.serviceCachePartition === undefined ? {} : { cachePartition: this.serviceCachePartition }),
        }),
    });
  }

  searchServices(request?: DirectorySearchRequest): DirectorySearchSequence {
    const sequence = this.directory.searchServices(request);
    return sanitizeSequence(sequence);
  }

  continueSearchServices(next: string, options?: DirectoryIterationOptions): DirectorySearchSequence {
    return sanitizeSequence(this.directory.continueSearchServices(next, options));
  }

  suggestServices(request: DirectorySuggestionRequest): Promise<string[]> {
    return this.directory.suggestServices(request).then(sanitizeDeep);
  }

  searchOfferingsAcrossServices(request?: FederatedOfferingSearchRequest): AsyncIterable<FederatedDiscoveryEvent> {
    return sanitizeIterable(this.agent.searchOfferingsAcrossServices(request));
  }

  inspect(options: OdpInspectOptions): Promise<ServiceInspection> {
    return inspectService({ ...options, fetch: options.fetch ?? this.transport }).then(sanitizeDeep);
  }

  service(options: OdpServiceOptions): OdpServiceClient {
    const usesConfiguredTransport = options.transport === undefined;
    return sanitizeServiceClient(
      createOdpServiceClient({
        ...options,
        transport: options.transport ?? this.serviceTransport,
        ...(usesConfiguredTransport && options.cachePartition === undefined && this.serviceCachePartition !== undefined
          ? { cachePartition: this.serviceCachePartition }
          : {}),
      }),
    );
  }

  withServiceTransport(options: OdpServiceTransportOptions): IOdpResource {
    return new OdpResource(this.environment, this.transport, options);
  }
}

function sanitizeSequence(sequence: DirectorySearchSequence): DirectorySearchSequence {
  return {
    items: sanitizeIterable(sequence.items),
    pages: sanitizeIterable(sequence.pages),
  };
}

function sanitizeIterable<Value>(source: AsyncIterable<Value>): AsyncIterable<Value> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const value of source) yield sanitizeDeep(value);
    },
  };
}

function sanitizeServiceClient(client: OdpServiceClient): OdpServiceClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => sanitizeOperationResult(method.apply(target, args));
    },
  });
}

function sanitizeOperationResult(result: unknown): unknown {
  if (result instanceof Promise) return result.then(sanitizeDeep);
  if (isSequence(result)) {
    return {
      items: sanitizeIterable(result.items),
      pages: sanitizeIterable(result.pages),
    };
  }
  return result;
}

function isSequence(value: unknown): value is {
  items: AsyncIterable<unknown>;
  pages: AsyncIterable<unknown>;
} {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { items?: unknown; pages?: unknown };
  return isAsyncIterable(candidate.items) && isAsyncIterable(candidate.pages);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === 'object' && Symbol.asyncIterator in value;
}
