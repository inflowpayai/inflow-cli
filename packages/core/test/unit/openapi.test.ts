import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SqlitePublicSourceCache, type PublicSourceCache } from '../../src/openapi/cache.js';
import { SourceDiscovery } from '../../src/openapi/discovery.js';
import { PublicSourceDocuments } from '../../src/openapi/documents.js';
import { fetchPublicDocument, isPublicAddress, publicDocumentUrl } from '../../src/openapi/public-fetch.js';
import { SecureSqliteRepository } from '../../src/secure-storage/sqlite.js';

const origin = 'https://service.example';
const contract = {
  openapi: '3.2.7',
  info: { title: 'Search' },
  paths: { '/search': { get: { operationId: 'search', responses: {} } } },
};
const odp = {
  odp_version: '1.0',
  name: 'Search',
  description: 'Public search',
  language: 'en',
  localizations: ['en'],
  operations: [
    { name: 'get-offering', authentication: 'not-required' },
    { name: 'list-offerings', authentication: 'not-required' },
  ],
  http: { endpoint_base: '/odp', openapi: { url: '/custom.json' } },
};

class MemoryCache implements PublicSourceCache {
  readonly values = new Map<string, unknown>();
  delete(kind: string, url: string): void {
    this.values.delete(`${kind}:${url}`);
  }
  get(kind: string, url: string): unknown {
    return structuredClone(this.values.get(`${kind}:${url}`));
  }
  set(kind: string, url: string, value: unknown): void {
    this.values.set(`${kind}:${url}`, structuredClone(value));
  }
}

function setup(routes: Record<string, () => Response>, cache = new MemoryCache()) {
  let now = 1_000_000;
  const fetch = vi.fn((url: URL, _init: RequestInit) =>
    Promise.resolve(routes[url.href]?.() ?? new Response(null, { status: 404 })),
  );
  const documents = new PublicSourceDocuments(cache, fetch, () => now);
  const discovery = new SourceDiscovery(documents, () => now);
  return {
    cache,
    documents,
    discovery,
    fetch,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe('public source discovery', () => {
  it('discovers /v1/openapi.json anonymously, caches locations, refreshes, and sanitizes display values', async () => {
    const state = setup({
      [`${origin}/v1/openapi.json`]: () => Response.json({ ...contract, info: { title: '\u001b[31mSearch' } }),
    });
    const result = await state.discovery.inspect(origin);
    expect(result).toMatchObject({
      sourceType: 'openapi',
      sourceUrl: `${origin}/v1/openapi.json`,
      document: { title: 'Search', operations: [{ method: 'GET', path: '/search' }] },
    });
    expect(state.fetch).toHaveBeenCalledTimes(4);
    await state.discovery.inspect(origin);
    expect(state.fetch).toHaveBeenCalledTimes(4);
    await state.discovery.inspect(origin, { refresh: true });
    expect(state.fetch).toHaveBeenCalledTimes(8);
    for (const [, init] of state.fetch.mock.calls) {
      expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual' });
      expect(Object.keys(init.headers ?? {})).toEqual(['Accept']);
    }
  });

  it('prefers native ODP, but explicit OpenAPI discovery follows its advertised link', async () => {
    const state = setup({
      [`${origin}/.well-known/odp`]: () => Response.json(odp),
      [`${origin}/custom.json`]: () => Response.json(contract),
    });
    expect(await state.discovery.inspect(origin)).toMatchObject({ sourceType: 'odp' });
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(await state.discovery.inspect(origin)).toMatchObject({ sourceType: 'odp' });
    expect(await state.discovery.inspect(origin, { format: 'openapi' })).toMatchObject({
      sourceType: 'openapi',
      sourceUrl: `${origin}/custom.json`,
    });
    expect(await state.discovery.inspect(`${origin}/.well-known/odp`)).toMatchObject({ sourceType: 'odp' });
    await expect(state.discovery.inspect(`${origin}/.well-known/odp`, { format: 'openapi' })).rejects.toThrow(
      'OpenAPI',
    );
  });

  it('does not hide an invalid or unavailable ODP document behind fallback', async () => {
    for (const response of [() => Response.json({}), () => new Response(null, { status: 503 })]) {
      const state = setup({
        [`${origin}/.well-known/odp`]: response,
        [`${origin}/openapi.json`]: () => Response.json(contract),
      });
      await expect(state.discovery.inspect(origin)).rejects.toThrow();
      expect(state.fetch).toHaveBeenCalledTimes(1);
      expect(state.cache.values.size).toBeLessThanOrEqual(1);
    }
  });

  it('reports all candidates, does not choose the last exact document, and rediscovers after expiry', async () => {
    const state = setup({
      [`${origin}/openapi.json`]: () => Response.json(contract),
      [`${origin}/v1/openapi.json`]: () => Response.json(contract),
    });
    await state.discovery.inspect(`${origin}/openapi.json`);
    await expect(state.discovery.inspect(origin)).rejects.toMatchObject({
      code: 'SOURCE_AMBIGUOUS',
      candidates: [`${origin}/openapi.json`, `${origin}/v1/openapi.json`],
    });
    const calls = state.fetch.mock.calls.length;
    await expect(state.discovery.inspect(origin)).rejects.toMatchObject({ code: 'SOURCE_AMBIGUOUS' });
    expect(state.fetch).toHaveBeenCalledTimes(calls);
    state.advance(600_001);
    await expect(state.discovery.inspect(origin)).rejects.toMatchObject({ code: 'SOURCE_AMBIGUOUS' });
    expect(state.fetch).toHaveBeenCalledTimes(calls + 4);
  });

  it('keeps path/query identity and never substitutes another document after exact-URL failure', async () => {
    const state = setup({
      [`${origin}/spec?version=3`]: () => Response.json(contract),
      [`${origin}/openapi.json`]: () => Response.json(contract),
    });
    expect(await state.discovery.inspect(`${origin}/spec?version=3`)).toMatchObject({
      sourceUrl: `${origin}/spec?version=3`,
    });
    await expect(state.discovery.inspect(`${origin}/missing.json`)).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    expect(state.fetch).toHaveBeenCalledTimes(2);
  });

  it('supports explicit and discovered x402 OpenAPI links relative to their retrieval URL', async () => {
    const state = setup({
      [`${origin}/.well-known/x402.json`]: () => Response.json({ openapi: '/contracts/api' }),
      [`${origin}/contracts/api`]: () => Response.json(contract),
    });
    expect(await state.discovery.inspect(`${origin}/.well-known/x402.json`)).toMatchObject({
      sourceUrl: `${origin}/contracts/api`,
    });
    expect(await state.discovery.inspect(origin)).toMatchObject({ sourceUrl: `${origin}/contracts/api` });
    const missing = setup({ [`${origin}/.well-known/x402.json`]: () => Response.json({ openapi: '/missing' }) });
    await expect(missing.discovery.inspect(`${origin}/.well-known/x402.json`)).rejects.toThrow('linked');
  });

  it('distinguishes missing documents and does not treat Swagger or unrelated JSON as OpenAPI', async () => {
    const state = setup({
      [`${origin}/openapi.json`]: () => Response.json({ swagger: '2.0', info: { title: 'Old' } }),
    });
    await expect(state.discovery.inspect(origin)).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    await expect(state.discovery.inspect(`${origin}/openapi.json`)).rejects.toThrow('3.x');
    expect([...state.cache.values.keys()].some((key) => key.startsWith('location:'))).toBe(false);
  });
});

describe('public document HTTP cache', () => {
  it.each(['max-age=invalid', 'max-age=600, max-age=0'])(
    'revalidates ambiguous or malformed freshness: %s',
    async (control) => {
      const state = setup({
        [`${origin}/spec`]: () => Response.json(contract, { headers: { 'Cache-Control': control } }),
      });
      await state.documents.get(`${origin}/spec`);
      await state.documents.get(`${origin}/spec`);
      expect(state.fetch).toHaveBeenCalledTimes(2);
    },
  );
  it('revalidates stale entries, preserves 304 metadata, and never stores cookies', async () => {
    let status = 200;
    const state = setup({
      [`${origin}/openapi.json`]: () =>
        status === 200
          ? Response.json(contract, {
              headers: {
                ETag: '"one"',
                'Last-Modified': 'yesterday',
                'Cache-Control': 'max-age=1',
                'Set-Cookie': 'secret=value',
              },
            })
          : new Response(null, { status, headers: { 'Cache-Control': 'max-age=60' } }),
    });
    const first = await state.documents.get(`${origin}/openapi.json`);
    expect(first.headers['set-cookie']).toBeUndefined();
    first.value = null;
    expect((await state.documents.get(`${origin}/openapi.json`)).value).toEqual(contract);
    state.advance(1001);
    status = 304;
    expect((await state.documents.get(`${origin}/openapi.json`)).value).toEqual(contract);
    expect(state.fetch.mock.lastCall?.[1].headers).toMatchObject({
      'If-None-Match': '"one"',
      'If-Modified-Since': 'yesterday',
    });
    state.advance(1000);
    await state.documents.get(`${origin}/openapi.json`);
    expect(state.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['no-store', 'private', 'no-cache', 'max-age=0'])(
    'honors %s for documents and location mappings',
    async (directive) => {
      const state = setup({
        [`${origin}/openapi.json`]: () => Response.json(contract, { headers: { 'Cache-Control': directive } }),
      });
      await state.discovery.inspect(origin);
      await state.discovery.inspect(origin);
      expect(state.fetch).toHaveBeenCalledTimes(8);
      expect([...state.cache.values.keys()].some((key) => key.startsWith('location:'))).toBe(false);
      expect(state.cache.values.size).toBe(directive === 'no-store' || directive === 'private' ? 0 : 1);
    },
  );

  it('honors Expires, Date and Age instead of treating old responses as newly fresh', async () => {
    const state = setup({
      [`${origin}/spec`]: () =>
        Response.json(contract, {
          headers: { Date: new Date(1_000_000).toUTCString(), Expires: new Date(1_060_000).toUTCString(), Age: '50' },
        }),
    });
    await state.documents.get(`${origin}/spec`);
    state.advance(9000);
    await state.documents.get(`${origin}/spec`);
    expect(state.fetch).toHaveBeenCalledTimes(1);
    state.advance(2000);
    await state.documents.get(`${origin}/spec`);
    expect(state.fetch).toHaveBeenCalledTimes(2);
  });

  it('retains submitted identity across redirects and validates each hop', async () => {
    const state = setup({
      [`${origin}/start`]: () => new Response(null, { status: 302, headers: { Location: 'https://cdn.example/spec' } }),
      'https://cdn.example/spec': () => Response.json(contract),
    });
    expect(await state.documents.get(`${origin}/start`)).toMatchObject({
      sourceUrl: `${origin}/start`,
      finalUrl: 'https://cdn.example/spec',
    });
    expect([...state.cache.values.keys()]).toEqual([`document:${origin}/start`]);
    for (const target of [
      'http://remote.example/spec',
      'https://127.0.0.1/spec',
      'https://user:pass@remote.example/spec',
    ]) {
      const unsafe = setup({
        [`${origin}/start`]: () => new Response(null, { status: 302, headers: { Location: target } }),
      });
      await expect(unsafe.documents.get(`${origin}/start`)).rejects.toThrow('HTTPS');
      expect(unsafe.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects missing redirect targets, redirect loops, unexpected 304 and stale retrieval failures', async () => {
    const noLocation = setup({ [`${origin}/spec`]: () => new Response(null, { status: 302 }) });
    await expect(noLocation.documents.get(`${origin}/spec`)).rejects.toThrow('redirect');
    const loop = setup({
      [`${origin}/spec`]: () => new Response(null, { status: 302, headers: { Location: '/spec' } }),
    });
    await expect(loop.documents.get(`${origin}/spec`)).rejects.toThrow('five');
    expect(loop.fetch).toHaveBeenCalledTimes(6);
    const unexpected = setup({ [`${origin}/spec`]: () => new Response(null, { status: 304 }) });
    await expect(unexpected.documents.get(`${origin}/spec`)).rejects.toThrow('304');
    let fail = false;
    const stale = setup({
      [`${origin}/spec`]: () => (fail ? new Response(null, { status: 503 }) : Response.json(contract)),
    });
    await stale.documents.get(`${origin}/spec`);
    fail = true;
    stale.advance(600_001);
    await expect(stale.documents.get(`${origin}/spec`)).rejects.toThrow('503');
  });

  it('rejects malformed JSON, invalid UTF-8, empty and oversized documents, and cancellation', async () => {
    for (const response of [
      () => new Response('{'),
      () => new Response(new Uint8Array([255])),
      () => new Response(null),
      () => new Response('x'.repeat(4 * 1024 * 1024 + 1)),
    ]) {
      const state = setup({ [`${origin}/spec`]: response });
      await expect(state.documents.get(`${origin}/spec`)).rejects.toThrow();
      expect(state.cache.values.size).toBe(0);
    }
    const state = setup({});
    await expect(state.documents.get(`${origin}/spec`, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(state.fetch).not.toHaveBeenCalled();
  });
});

describe('public address boundary', () => {
  it.each([
    '127.0.0.1',
    '10.1.1.1',
    '172.16.1.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.1.1',
    '::1',
    '::ffff:127.0.0.1',
    'fe80::1',
    '2001:db8::1',
    'invalid',
  ])('rejects %s', (address) => expect(isPublicAddress(address)).toBe(false));
  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('accepts public %s', (address) =>
    expect(isPublicAddress(address)).toBe(true),
  );
  it.each([
    'http://example.com',
    'https://example.com/#fragment',
    'https://user@example.com',
    'https://2130706433',
    'https://[::1]',
  ])('rejects unsafe URL %s', (url) => expect(() => publicDocumentUrl(url)).toThrow());
  it('uses the real DNS boundary to refuse localhost, without a listener or vault', async () => {
    await expect(
      fetchPublicDocument(new URL('https://localhost/spec'), { signal: AbortSignal.timeout(5000) }),
    ).rejects.toThrow();
  });
});

describe('OpenAPI interpretation', () => {
  it('preserves operation tags without inheriting top-level tag declarations', async () => {
    const tags = ['Weather', 'Weather', 'Forecast'];
    const state = setup({
      [`${origin}/openapi.json`]: () =>
        Response.json({
          ...contract,
          tags: [{ name: 'Global' }],
          paths: { '/weather': { get: { tags } }, '/other': { get: {} } },
        }),
    });
    const result = await state.discovery.inspect(`${origin}/openapi.json`, { format: 'openapi' });
    if (result.sourceType !== 'openapi') throw new Error('Expected OpenAPI');
    expect(result.document.operations[0]?.tags).toEqual(['Weather', 'Forecast']);
    expect(result.document.operations[1]?.tags).toBeUndefined();
    expect(tags).toEqual(['Weather', 'Weather', 'Forecast']);
  });
  it.each([null, 'Weather', [1]])('rejects malformed operation tags %j', async (tags) => {
    const state = setup({
      [`${origin}/openapi.json`]: () => Response.json({ ...contract, paths: { '/weather': { get: { tags } } } }),
    });
    await expect(state.discovery.inspect(`${origin}/openapi.json`, { format: 'openapi' })).rejects.toThrow();
  });
  it('preserves arbitrary security scheme names as data, not object prototypes', async () => {
    const schemes = Object.fromEntries([['__proto__', { type: 'http', scheme: 'bearer' }]]);
    const state = setup({
      [`${origin}/spec`]: () => Response.json({ ...contract, components: { securitySchemes: schemes } }),
    });
    const result = await state.discovery.inspect(`${origin}/spec`);
    if (result.sourceType !== 'openapi') throw new Error('Expected OpenAPI');
    const output = result.document.operations[0]?.securitySchemes;
    expect(output).toEqual(schemes);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.hasOwn(output ?? {}, '__proto__')).toBe(true);
  });
  it('retains authentication alternatives and applies operation parameter and server overrides', async () => {
    const raw = {
      ...contract,
      info: { title: 'Search', description: 'Find pages' },
      servers: [{ url: '/api' }],
      security: [{ key: [], siwx: [] }, {}],
      components: {
        securitySchemes: {
          key: { type: 'apiKey', in: 'header', name: 'X-Key' },
          siwx: { type: 'http', scheme: 'siwx' },
        },
      },
      paths: {
        '/search': {
          parameters: [{ name: 'q', in: 'query', required: false }],
          get: {
            operationId: 'search',
            summary: 'Search',
            description: 'Find',
            security: [],
            servers: [
              { url: 'https://{region}.example', variables: { region: { default: 'us', enum: ['us', 'eu'] } } },
            ],
            parameters: [{ name: 'q', in: 'query', required: true }],
            requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
          },
          post: {},
        },
      },
    };
    const state = setup({ [`${origin}/spec`]: () => Response.json(raw) });
    const result = await state.discovery.inspect(`${origin}/spec`);
    expect(result.document).toMatchObject({
      description: 'Find pages',
      operations: [
        {
          security: [],
          parameters: [{ name: 'q', in: 'query', required: true }],
          servers: [{ url: 'https://{region}.example', baseUrl: `${origin}/spec` }],
          requestBody: { content: { 'application/json': {} } },
        },
        { security: [{ key: [], siwx: [] }, {}], servers: [{ url: '/api', baseUrl: `${origin}/spec` }] },
      ],
    });
    expect(raw.paths['/search'].parameters[0]?.required).toBe(false);
  });

  it('resolves local references, escaped pointers and external references relative to redirects', async () => {
    const raw = {
      ...contract,
      components: { securitySchemes: { key: { $ref: '#/definitions/key' } } },
      definitions: { key: { type: 'apiKey' }, 'query/name': { name: 'q', in: 'query' } },
      paths: {
        '/search': {
          get: {
            parameters: [
              { $ref: '#/definitions/query~1name', description: 'The phrase', 'x-provider-note': 'Optional metadata' },
            ],
            requestBody: { $ref: 'https://docs.example/redirect#/body' },
          },
        },
        '/other': { $ref: 'https://docs.example/redirect#/path' },
      },
    };
    const state = setup({
      [`${origin}/spec`]: () => Response.json(raw),
      'https://docs.example/redirect': () => new Response(null, { status: 302, headers: { Location: '/actual/spec' } }),
      'https://docs.example/actual/spec': () =>
        Response.json({ body: { content: { 'application/json': {} } }, path: { $ref: './path' } }),
      'https://docs.example/actual/path': () => Response.json({ get: { servers: [{ url: './api' }] } }),
    });
    expect((await state.discovery.inspect(`${origin}/spec`)).document).toMatchObject({
      operations: [
        { parameters: [{ name: 'q', description: 'The phrase' }], securitySchemes: { key: { type: 'apiKey' } } },
        { servers: [{ baseUrl: 'https://docs.example/actual/path' }] },
      ],
    });
    expect(state.fetch).toHaveBeenCalledTimes(4);
  });

  it('reports unsupported features without invoking them', async () => {
    const raw = {
      ...contract,
      webhooks: {},
      paths: {
        'x-not-an-operation': {},
        '/search': {
          query: {},
          get: {
            callbacks: {},
            parameters: [
              { name: 'cookie', in: 'cookie' },
              { name: 'filter', in: 'query', schema: { type: 'object' } },
            ],
            requestBody: { content: { 'multipart/form-data': {} } },
          },
        },
      },
    };
    const state = setup({ [`${origin}/spec`]: () => Response.json(raw) });
    const result = await state.discovery.inspect(`${origin}/spec`);
    expect(result.document).toMatchObject({
      limitations: [expect.stringContaining('query'), expect.stringContaining('Webhook')],
      operations: [
        {
          limitations: [
            expect.stringContaining('cookie'),
            expect.stringContaining('schema'),
            expect.stringContaining('JSON'),
            expect.stringContaining('Callback'),
          ],
        },
      ],
    });
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ paths: { wrong: {} } }, 'path keys'],
    [{ paths: { '/x': { get: 1 } } }, 'operation'],
    [{ paths: { '/x': { get: { parameters: {} } } } }, 'parameters'],
    [{ paths: { '/x': { get: { parameters: [{}] } } } }, 'name and in'],
    [{ paths: { '/x': { get: { security: [{ key: 'scope' }] } } } }, 'security'],
    [{ servers: {}, paths: { '/x': { get: {} } } }, 'servers'],
    [{ servers: [{}], paths: { '/x': { get: {} } } }, 'server'],
    [{ paths: { '/x': { $ref: 2 } } }, '$ref'],
    [{ paths: { '/x': { $ref: '#/missing' } } }, 'missing'],
    [{ paths: { '/x': { $ref: '#named' } } }, 'pointer'],
    [{ paths: { '/x': { $ref: '#/paths/~9' } } }, 'escape'],
    [{ paths: { '/x': { $ref: '#/paths/~1x' } } }, 'cycle'],
    [{ paths: { '/x': { $ref: '#/info', get: {} } } }, 'siblings'],
    [{ paths: { '/x': null } }, 'object'],
  ])('rejects unsupported or invalid required structures (%s)', async (fields, message) => {
    const state = setup({ [`${origin}/spec`]: () => Response.json({ ...contract, ...fields }) });
    await expect(state.discovery.inspect(`${origin}/spec`)).rejects.toThrow(String(message));
  });

  it('bounds external documents and refuses unavailable reference documents', async () => {
    const paths = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`/path${i}`, { $ref: `https://refs.example/${i}` }]),
    );
    const routes = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`https://refs.example/${i}`, () => Response.json({ get: {} })]),
    );
    const state = setup({ [`${origin}/spec`]: () => Response.json({ ...contract, paths }), ...routes });
    await expect(state.discovery.inspect(`${origin}/spec`)).rejects.toThrow('eight');
    expect(state.fetch).toHaveBeenCalledTimes(9);
    const missing = setup({
      [`${origin}/spec`]: () =>
        Response.json({ ...contract, paths: { '/x': { $ref: 'https://missing.example/ref' } } }),
    });
    await expect(missing.discovery.inspect(`${origin}/spec`)).rejects.toThrow('unavailable');
  });
});

describe('persistent anonymous cache', () => {
  it('persists independently of secret lifecycle and keeps AEP entries separate', () => {
    const folder = mkdtempSync(join(tmpdir(), 'inflow-public-source-'));
    const databasePath = join(folder, 'cache.sqlite3');
    try {
      const cache = new SqlitePublicSourceCache(databasePath);
      cache.set('document', 'https://service.example/spec', { value: 'public' });
      expect(new SqlitePublicSourceCache(databasePath).get('document', 'https://service.example/spec')).toEqual({
        value: 'public',
      });
      const repository = new SecureSqliteRepository({ databasePath });
      repository.initialize();
      expect(repository.listPublicDocuments('openapi')).toEqual([]);
      repository.close();
      cache.delete('document', 'https://service.example/spec');
      expect(cache.get('document', 'https://service.example/spec')).toBeUndefined();
      for (let i = 0; i < 130; i++) cache.set('location', String(i), { candidates: ['public'] });
      const reader = new SecureSqliteRepository({ databasePath });
      reader.initialize();
      expect(reader.listPublicDocuments('source-location')).toHaveLength(128);
      reader.close();
      cache.set('document', 'large', 'x'.repeat(4 * 1024 * 1024));
      expect(cache.get('document', 'large')).toBeUndefined();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
