import { isRecord, readJson } from './documents.js';
import type { OpenApiDescription, OpenApiOperation } from './reader.js';

export class OpenApiCollectionError extends Error {
  constructor(
    readonly code: 'OPENAPI_COLLECTION_UNAVAILABLE' | 'OPENAPI_COLLECTION_LOOKUP_FAILED' | 'OPENAPI_COLLECTION_STALE',
    message: string,
  ) {
    super(message);
    this.name = 'OpenApiCollectionError';
  }
}

export class OpenApiCollections {
  constructor(
    private readonly baseUrl: string,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async operations(document: OpenApiDescription, collectionId: string): Promise<OpenApiOperation[]> {
    let response: Response;
    let value: unknown;
    try {
      response = await this.fetch(new URL('/v1/directory/collections/operations', this.baseUrl), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection_id: collectionId, source_url: document.sourceUrl }),
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      value = JSON.parse(await readJson(response));
    } catch {
      throw new OpenApiCollectionError(
        'OPENAPI_COLLECTION_LOOKUP_FAILED',
        'Unable to retrieve Collection operations from the Directory.',
      );
    }
    if (response.status === 400 && isRecord(value) && value['code'] === 'collection_unavailable')
      throw new OpenApiCollectionError(
        'OPENAPI_COLLECTION_UNAVAILABLE',
        'The OpenAPI Collection is not published in this Directory.',
      );
    if (
      !response.ok ||
      !isRecord(value) ||
      value['source_url'] !== document.sourceUrl ||
      value['collection_id'] !== collectionId ||
      !Array.isArray(value['items'])
    )
      throw new OpenApiCollectionError(
        'OPENAPI_COLLECTION_LOOKUP_FAILED',
        'The Directory returned an invalid Collection response.',
      );
    const selected = new Set<string>();
    for (const item of value['items']) {
      if (!isRecord(item) || typeof item['method'] !== 'string' || typeof item['path'] !== 'string')
        throw new OpenApiCollectionError(
          'OPENAPI_COLLECTION_LOOKUP_FAILED',
          'The Directory returned an invalid operation reference.',
        );
      selected.add(`${item['method']} ${item['path']}`);
    }
    const operations = document.operations.filter((operation) => selected.has(`${operation.method} ${operation.path}`));
    if (operations.length !== selected.size)
      throw new OpenApiCollectionError(
        'OPENAPI_COLLECTION_STALE',
        'Some Collection operations are absent from the provider document. Retry with --refresh; the Directory may also need to refresh this Service.',
      );
    return operations;
  }
}
