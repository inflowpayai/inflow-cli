import { type PublicSourceCache, SqlitePublicSourceCache } from './cache.js';
import { fetchPublicDocument, publicDocumentUrl, type PublicDocumentFetch } from './public-fetch.js';

export interface SourceDocument {
  cacheable: boolean;
  expiresAt: number;
  finalUrl: string;
  headers: Record<string, string>;
  sourceUrl: string;
  status: number;
  value: unknown;
}

export interface SourceOptions {
  refresh?: boolean;
  signal?: AbortSignal;
}

export class PublicSourceDocuments {
  constructor(
    readonly cache: PublicSourceCache = new SqlitePublicSourceCache(),
    private readonly fetch: PublicDocumentFetch = fetchPublicDocument,
    private readonly clock: () => number = Date.now,
  ) {}

  async get(input: string, options: SourceOptions = {}): Promise<SourceDocument> {
    const sourceUrl = publicDocumentUrl(input).href;
    const stored = this.cache.get('document', sourceUrl);
    const cached = isDocument(stored) && stored.sourceUrl === sourceUrl ? stored : undefined;
    options.signal?.throwIfAborted();
    if (cached !== undefined && cached.expiresAt > this.clock() && !options.refresh) return structuredClone(cached);
    const signal = AbortSignal.any([
      AbortSignal.timeout(15_000),
      ...(options.signal === undefined ? [] : [options.signal]),
    ]);
    let url = publicDocumentUrl(sourceUrl);
    for (let redirects = 0; ; redirects++) {
      const headers: Record<string, string> = { Accept: 'application/json, application/*+json' };
      if (cached !== undefined && cached.finalUrl === url.href) {
        if (cached.headers['etag']) headers['If-None-Match'] = cached.headers['etag'];
        if (cached.headers['last-modified']) headers['If-Modified-Since'] = cached.headers['last-modified'];
      }
      const response = await this.fetch(url, { headers, signal, redirect: 'manual', credentials: 'omit' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (redirects >= 5 || location === null)
          throw new TypeError('Public document redirect is invalid or exceeds five hops.');
        url = publicDocumentUrl(location, url.href);
        continue;
      }
      const received: Record<string, string> = {};
      for (const name of ['cache-control', 'etag', 'last-modified', 'date', 'age', 'expires']) {
        const value = response.headers.get(name);
        if (value !== null) received[name] = value;
      }
      if (response.status === 304) {
        await response.body?.cancel();
        if (cached === undefined || cached.finalUrl !== url.href)
          throw new TypeError('Public document returned an unexpected 304.');
        const merged = { ...cached.headers, ...received };
        // Age and Date describe this response, not the previous representation's freshness.
        delete merged['age'];
        delete merged['date'];
        if (received['age']) merged['age'] = received['age'];
        if (received['date']) merged['date'] = received['date'];
        return this.store({ ...cached, headers: merged, ...freshness(merged, this.clock()) });
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404 || response.status === 410) {
          this.cache.delete('document', sourceUrl);
          return {
            sourceUrl,
            finalUrl: url.href,
            headers: received,
            status: response.status,
            value: null,
            ...freshness(received, this.clock()),
          };
        }
        throw new Error(`Public document retrieval failed with HTTP ${response.status}: ${sourceUrl}`);
      }
      const value: unknown = JSON.parse(await readJson(response));
      return this.store({
        sourceUrl,
        finalUrl: url.href,
        headers: received,
        status: response.status,
        value,
        ...freshness(received, this.clock()),
      });
    }
  }

  private store(document: SourceDocument): SourceDocument {
    if (document.cacheable) this.cache.set('document', document.sourceUrl, document);
    else this.cache.delete('document', document.sourceUrl);
    return structuredClone(document);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDocument(value: unknown): value is SourceDocument {
  return (
    isRecord(value) &&
    typeof value['sourceUrl'] === 'string' &&
    typeof value['finalUrl'] === 'string' &&
    typeof value['expiresAt'] === 'number' &&
    typeof value['cacheable'] === 'boolean' &&
    typeof value['status'] === 'number' &&
    isRecord(value['headers']) &&
    Object.values(value['headers']).every((item) => typeof item === 'string')
  );
}

function freshness(headers: Record<string, string>, now: number): { cacheable: boolean; expiresAt: number } {
  const control = headers['cache-control'] ?? '';
  const cacheable = !/(?:^|,)\s*(?:no-store|private)(?:\s|,|=|$)/i.test(control);
  const ageDirectives = control.split(',').filter((part) => /^\s*max-age(?:\s|=|$)/i.test(part));
  const maxAge =
    ageDirectives.length === 1 ? /^\s*max-age\s*=\s*"?(\d+)"?\s*$/i.exec(ageDirectives[0] ?? '')?.[1] : undefined;
  const date = Date.parse(headers['date'] ?? '');
  const expires = Date.parse(headers['expires'] ?? '');
  const lifetime =
    ageDirectives.length > 0
      ? maxAge === undefined
        ? 0
        : Number(maxAge) * 1000
      : headers['expires'] !== undefined
        ? Number.isFinite(expires)
          ? expires - (Number.isFinite(date) ? date : now)
          : 0
        : 600_000;
  const age = Math.max(Number(headers['age'] ?? 0) * 1000, Number.isFinite(date) ? Math.max(0, now - date) : 0);
  const expiresAt =
    cacheable && !/(?:^|,)\s*no-cache(?:\s|,|=|$)/i.test(control) && Number.isFinite(lifetime) && Number.isFinite(age)
      ? now + Math.max(0, lifetime - age)
      : now;
  return { cacheable, expiresAt };
}

async function readJson(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new TypeError('Public document is empty.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array)) throw new TypeError('Public document stream is not bytes.');
      length += bytes.byteLength;
      if (length > 4 * 1024 * 1024) throw new TypeError('Public document exceeds 4 MiB.');
      chunks.push(bytes);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
