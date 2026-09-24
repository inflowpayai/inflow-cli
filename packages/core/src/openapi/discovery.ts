import { parseAgentServiceDocument, type ServiceDocument } from '@offering-protocol/core';
import { sanitizeDeep } from '../utils/sanitize-text.js';
import { isRecord, PublicSourceDocuments, type SourceDocument, type SourceOptions } from './documents.js';
import { publicDocumentUrl } from './public-fetch.js';
import { openApiDocument, readOpenApi, type OpenApiDescription } from './reader.js';

export type SourceDiscoveryResult =
  | { sourceType: 'odp'; sourceUrl: string; document: ServiceDocument }
  | { sourceType: 'openapi'; sourceUrl: string; document: OpenApiDescription };

export interface SourceDiscoveryOptions extends SourceOptions {
  format?: 'auto' | 'openapi';
}

export class SourceDiscoveryError extends Error {
  constructor(
    readonly code: 'SOURCE_NOT_FOUND' | 'SOURCE_AMBIGUOUS' | 'SOURCE_UNAVAILABLE',
    message: string,
    readonly candidates: string[] = [],
  ) {
    super(message);
    this.name = 'SourceDiscoveryError';
  }
}

export class SourceDiscovery {
  constructor(
    private readonly documents = new PublicSourceDocuments(),
    private readonly clock: () => number = Date.now,
  ) {}

  async inspect(input: string, options: SourceDiscoveryOptions = {}): Promise<SourceDiscoveryResult> {
    const url = publicDocumentUrl(input);
    const exact = url.pathname !== '/' || url.search !== '';
    if (exact) {
      const document = await this.documents.get(url.href, options);
      if (options.format !== 'openapi' && isRecord(document.value) && document.value['odp_version'] !== undefined) {
        return sanitizeDeep(this.odp(document));
      }
      return sanitizeDeep(await this.openapi(document, options));
    }
    const locationKey = `${options.format ?? 'auto'}:${url.origin}`;
    const location = this.documents.cache.get('location', locationKey);
    if (
      !options.refresh &&
      isRecord(location) &&
      typeof location['expiresAt'] === 'number' &&
      location['expiresAt'] > this.clock() &&
      Array.isArray(location['candidates']) &&
      location['candidates'].every((entry: unknown) => typeof entry === 'string')
    ) {
      const candidates = location['candidates'];
      if (candidates.length > 1) throw ambiguous(candidates);
      const first = candidates[0];
      if (first !== undefined) {
        const document = await this.documents.get(first, options);
        return sanitizeDeep(
          location['sourceType'] === 'odp' ? this.odp(document) : await this.openapi(document, options),
        );
      }
    }
    this.documents.cache.delete('location', locationKey);
    const evidence: SourceDocument[] = [];
    const native = await this.documents.get(`${url.origin}/.well-known/odp`, options);
    evidence.push(native);
    if (native.status === 200 && options.format !== 'openapi') {
      const result = this.odp(native);
      this.remember(locationKey, 'odp', [native.sourceUrl], evidence);
      return sanitizeDeep(result);
    }
    const candidates = new Set([`${url.origin}/openapi.json`, `${url.origin}/v1/openapi.json`]);
    if (native.status === 200) {
      const odp = parseAgentServiceDocument(native.value);
      if (odp.http.openapi !== undefined) candidates.add(publicDocumentUrl(odp.http.openapi.url, native.finalUrl).href);
    }
    const x402 = await this.documents.get(`${url.origin}/.well-known/x402.json`, options);
    evidence.push(x402);
    if (
      x402.status === 200 &&
      isRecord(x402.value) &&
      !isRecord(x402.value['info']) &&
      typeof x402.value['openapi'] === 'string'
    ) {
      candidates.add(publicDocumentUrl(x402.value['openapi'], x402.finalUrl).href);
    }
    const found: SourceDocument[] = [];
    for (const candidate of candidates) {
      const document = await this.documents.get(candidate, options);
      evidence.push(document);
      if (document.status !== 200) continue;
      try {
        openApiDocument(document.value);
        found.push(document);
      } catch {
        /* A conventional location can contain a different JSON document. */
      }
    }
    const urls = found.map((document) => document.sourceUrl);
    if (found.length > 1) {
      this.remember(locationKey, 'openapi', urls, evidence);
      throw ambiguous(urls);
    }
    const selected = found[0];
    if (selected === undefined)
      throw new SourceDiscoveryError(
        'SOURCE_NOT_FOUND',
        'No public OpenAPI document was found. Supply its exact HTTPS URL.',
      );
    const result = await this.openapi(selected, options);
    this.remember(locationKey, 'openapi', urls, evidence);
    return sanitizeDeep(result);
  }

  private odp(document: SourceDocument): SourceDiscoveryResult {
    if (document.status !== 200)
      throw new SourceDiscoveryError('SOURCE_UNAVAILABLE', 'The ODP document is unavailable.');
    return { sourceType: 'odp', sourceUrl: document.sourceUrl, document: parseAgentServiceDocument(document.value) };
  }

  private async openapi(document: SourceDocument, options: SourceOptions): Promise<SourceDiscoveryResult> {
    if (document.status !== 200)
      throw new SourceDiscoveryError('SOURCE_NOT_FOUND', 'The exact public document URL was not found.');
    // A submitted x402 discovery URL identifies its explicitly linked OpenAPI document.
    if (
      new URL(document.sourceUrl).pathname === '/.well-known/x402.json' &&
      isRecord(document.value) &&
      !isRecord(document.value['info']) &&
      typeof document.value['openapi'] === 'string'
    ) {
      document = await this.documents.get(
        publicDocumentUrl(document.value['openapi'], document.finalUrl).href,
        options,
      );
      if (document.status !== 200)
        throw new SourceDiscoveryError('SOURCE_NOT_FOUND', 'The linked OpenAPI document was not found.');
    }
    return {
      sourceType: 'openapi',
      sourceUrl: document.sourceUrl,
      document: await readOpenApi(document, this.documents, options),
    };
  }

  private remember(key: string, sourceType: 'odp' | 'openapi', candidates: string[], evidence: SourceDocument[]): void {
    if (evidence.some((document) => !document.cacheable)) return;
    const expiresAt = Math.min(this.clock() + 600_000, ...evidence.map((document) => document.expiresAt));
    if (expiresAt > this.clock()) this.documents.cache.set('location', key, { sourceType, candidates, expiresAt });
  }
}

function ambiguous(candidates: string[]): SourceDiscoveryError {
  return new SourceDiscoveryError(
    'SOURCE_AMBIGUOUS',
    'Multiple OpenAPI documents were found. Supply an exact document URL.',
    candidates,
  );
}
