import { describe, expect, it, vi } from 'vitest';
import { PublicSourceDocuments } from '../../src/openapi/documents.js';
import type { PublicSourceCache } from '../../src/openapi/cache.js';
import { SourceDiscovery } from '../../src/openapi/discovery.js';
import {
  prepareOpenApiRequest,
  previewOpenApiRequest,
  type OpenApiPreparationInput,
} from '../../src/openapi/prepare.js';
import type { OpenApiDescription, OpenApiOperation } from '../../src/openapi/reader.js';

function document(overrides: Partial<OpenApiOperation> = {}): OpenApiDescription {
  return {
    sourceUrl: 'https://example.com/openapi.json',
    retrievalUrl: 'https://example.com/spec/openapi.json',
    title: 'Example',
    version: '3.1.0',
    limitations: [],
    operations: [
      {
        method: 'POST',
        path: '/items/{id}',
        operationId: 'create',
        servers: [{ url: '/v1' }],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        security: [],
        securitySchemes: {},
        limitations: [],
        ...overrides,
      },
    ],
  };
}
const input: OpenApiPreparationInput = { operationId: 'create', parameters: { path: { id: 'one' } } };
const prepare = (operation: Partial<OpenApiOperation> = {}, options: Partial<OpenApiPreparationInput> = {}) =>
  prepareOpenApiRequest(document(operation), { ...input, ...options });

describe('OpenAPI request preparation', () => {
  it('encodes scalars, array separators and path values without mutating input', () => {
    const doc = document({
      parameters: [
        { in: 'path', name: 'id' },
        { in: 'query', name: 'q' },
        { in: 'query', name: 'tags', schema: { type: 'array', items: { type: 'string' } } },
        { in: 'query', name: 'ids', explode: false },
        { in: 'header', name: 'X-Ids' },
      ],
    });
    const options = {
      operationId: 'create',
      parameters: {
        path: { id: 'a/b ?#é' },
        query: { q: true, tags: ['a,b', 'c'], ids: [1, 2] },
        header: { 'X-Ids': [3, 4] },
      },
    };
    const before = structuredClone({ doc, options });
    expect(prepareOpenApiRequest(doc, options).request).toEqual({
      method: 'POST',
      url: 'https://example.com/v1/items/a%2Fb%20%3F%23%C3%A9?q=true&tags=a%2Cb&tags=c&ids=1,2',
      headers: { 'x-ids': '3,4' },
    });
    expect({ doc, options }).toEqual(before);
    expect(prepare({}, { parameters: { path: { id: "a!'()*" } } }).request.url).toContain('a%21%27%28%29%2A');
    expect(
      prepare({ parameters: [{ in: 'path', name: 'id' }] }, { parameters: { path: { id: [1, 2] } } }).request.url,
    ).toContain('/items/1,2');
  });
  it('requires explicit multi-server selection and applies server variable defaults and overrides', () => {
    const servers = [
      { url: 'https://prod.example.com/{version}', variables: { version: { default: 'v1', enum: ['v1', 'v2'] } } },
      { url: 'https://sandbox.example.com' },
    ];
    expect(() => prepare({ servers })).toThrow(
      '1  https://prod.example.com/{version}\n  2  https://sandbox.example.com',
    );
    expect(prepare({ servers }, { server: 2 }).request.url).toBe('https://sandbox.example.com/items/one');
    expect(prepare({ servers }, { server: 1 }).request.url).toBe('https://prod.example.com/v1/items/one');
    expect(prepare({ servers }, { server: 1, serverVariables: { version: 'v2' } }).request.url).toContain('/v2/items');
    expect(prepare({ servers: [{ url: '../api', baseUrl: 'https://example.org/docs/spec.json' }] }).request.url).toBe(
      'https://example.org/api/items/one',
    );
  });
  it.each<[Partial<OpenApiOperation>, Partial<OpenApiPreparationInput>, string]>([
    [{ servers: [] }, {}, 'advertised server'],
    [{}, { server: 0 }, 'advertised server'],
    [{}, { server: 1.5 }, 'advertised server'],
    [{}, { serverVariables: { unknown: 'x' } }, 'Unknown server variable'],
    [{ servers: [{ url: 'https://example.com/{v}' }] }, {}, 'has no definition'],
    [{ servers: [{ url: 'https://example.com/{v}', variables: { v: {} } }] }, {}, 'Required input'],
    [
      { servers: [{ url: 'https://example.com/{v}', variables: { v: { default: 'v1', enum: ['v2'] } } }] },
      {},
      'advertised choice',
    ],
    [
      { servers: [{ url: 'https://example.com/{v}', variables: { v: { default: 'a?x' } } }] },
      {},
      'unsupported URL characters',
    ],
    [{ servers: [{ url: 'https://example.com/{' }] }, {}, 'unresolved variables'],
    [{ servers: [{ url: 'http://example.com' }] }, {}, 'public HTTPS'],
    [{ servers: [{ url: 'https://user:pass@example.com' }] }, {}, 'public HTTPS'],
    [{ servers: [{ url: 'https://127.0.0.1' }] }, {}, 'public HTTPS'],
    [{ servers: [{ url: 'https://example.com?q=1' }] }, {}, 'query parameters'],
  ])('rejects invalid server choices %j', (operation, options, message) => {
    expect(() => prepare(operation, options)).toThrow(message);
  });
  it.each<[Partial<OpenApiOperation>, Partial<OpenApiPreparationInput>, string]>([
    [{}, { parameters: {} }, 'Required input'],
    [{}, { parameters: { path: { id: '..' } } }, 'dot segments'],
    [{}, { parameters: { path: { id: '\ud800' } } }, 'surrogate'],
    [{}, { parameters: { cookie: {} } }, 'only path, query, and header'],
    [{}, { parameters: { path: [] } }, 'must be an object'],
    [{}, { parameters: { path: { id: 'a', unknown: 'b' } } }, 'Unknown path parameter'],
    [{}, { parameters: { path: { id: 'a' }, query: { unknown: 'b' } } }, 'Unknown query parameter'],
    [{ path: '/{missing}', parameters: [] }, { parameters: {} }, 'unresolved placeholders'],
    [{ path: '/%2e%2e/x', parameters: [] }, {}, 'Unknown path parameter'],
    [{ parameters: [{ in: 'path', name: 'id', style: 'matrix' }] }, {}, 'unsupported style'],
    [{ parameters: [{ in: 'path', name: 'id', allowReserved: true }] }, {}, 'unsupported style'],
    [{ parameters: [{ in: 'path', name: 'id', explode: 'yes' }] }, {}, 'invalid explode'],
    [{ parameters: [{ in: 'path', name: 'id', content: {} }] }, {}, 'content-based'],
    [{ parameters: [{ in: 'path', name: 'id' }] }, { parameters: { path: { id: null } } }, 'scalar'],
    [{ parameters: [{ in: 'path', name: 'id' }] }, { parameters: { path: { id: {} } } }, 'scalar'],
    [{ parameters: [{ in: 'path', name: 'id' }] }, { parameters: { path: { id: [] } } }, 'empty array'],
    [{ parameters: [{ in: 'cookie', name: 'session', required: true }] }, {}, 'unsupported location'],
  ])('rejects missing, unsupported or malformed parameters %j', (operation, options, message) => {
    expect(() => prepare(operation, options)).toThrow(message);
  });
  it('handles optional parameters, ignored special headers and supplied ordinary headers', () => {
    const parameters = [
      { in: 'path', name: 'id' },
      { in: 'query', name: 'optional' },
      { in: 'header', name: 'Authorization', required: true },
      { in: 'header', name: 'X-Count', required: true },
    ];
    expect(prepare({ parameters }, { headers: { 'X-Count': '3' } }).request.headers).toEqual({ 'x-count': '3' });
    expect(
      prepare(
        { parameters: parameters.slice(0, 3) },
        { parameters: { path: { id: 2 }, header: { Authorization: 'Bearer token' } } },
      ).request.headers,
    ).toEqual({ authorization: 'Bearer token' });
    expect(() =>
      prepare(
        { parameters },
        { headers: { 'X-Count': '1' }, parameters: { path: { id: 'x' }, header: { 'X-Count': '2' } } },
      ),
    ).toThrow('both');
  });
  it('handles case-insensitive parameter headers and rejects conflicting names and unused path definitions', () => {
    const parameters = [
      { in: 'path', name: 'id' },
      { in: 'header', name: 'X-Count', required: true },
    ];
    expect(
      prepare({ parameters }, { parameters: { path: { id: 'a' }, header: { 'x-count': 3 } } }).request.headers,
    ).toEqual({ 'x-count': '3' });
    expect(() => prepare({}, { parameters: { path: { id: 'a' }, header: { 'X-Key': 'a', 'x-key': 'b' } } })).toThrow(
      'more than once',
    );
    expect(() => prepare({ path: '/items' })).toThrow('not present in the operation path');
    expect(() => prepare({ path: '/%2e%2e/items', parameters: [] }, { parameters: {} })).toThrow('dot segments');
    expect(() => prepare({}, { parameters: { path: null } })).toThrow('must be an object');
    expect(
      prepare({
        parameters: [
          { in: 'path', name: 'id' },
          { in: 'cookie', name: 'optional' },
        ],
      }).request.headers,
    ).toEqual({});
    expect(() =>
      prepare({ parameters: [{ in: 'path', name: 'id' }] }, { parameters: { path: { id: Infinity } } }),
    ).toThrow('scalar');
    expect(prepare({ path: '/café/{id}' }).request.url).toContain('/caf%C3%A9/one');
    expect(
      prepare({ parameters }, { parameters: { path: { id: 'a' }, header: { 'x-count': ['a,b', 'c d'] } } }).request
        .headers['x-count'],
    ).toBe('a%2Cb,c%20d');
    expect(prepare({ parameters }, { headers: { 'X-Count': 'a,b' } }).request.headers['x-count']).toBe('a,b');
  });
  it.each([
    [{ 'Bad Name': 'value' }, 'valid printable'],
    [{ 'X-Test': 'bad\r\ninjected' }, 'valid printable'],
    [{ Host: 'attacker.example' }, 'not supported'],
    [{ Cookie: 'secret' }, 'not supported'],
    [{ 'Content-Length': '99' }, 'not supported'],
    [{ Authorization: 'a', authorization: 'b' }, 'more than once'],
  ])('rejects unsafe or duplicate headers %j', (headers, message) => {
    expect(() => prepare({}, { headers })).toThrow(message);
  });
  it('preserves JSON body text, chooses a JSON media type and does not insert schema defaults', () => {
    const requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['query', 'generated'],
            properties: {
              query: { type: 'string' },
              generated: { type: 'string', readOnly: true },
              count: { type: 'integer', default: 10 },
            },
          },
        },
      },
    };
    const data = '{ "query": "weather" }';
    expect(prepare({ requestBody }, { data }).request).toMatchObject({
      body: data,
      headers: { 'content-type': 'application/json' },
    });
    expect(() => prepare({ requestBody })).toThrow('request body');
    expect(() => prepare({ requestBody }, { data: '{}' })).toThrow('body.query');
    expect(
      prepare(
        { requestBody: { content: { 'application/a+json': {}, 'application/b+json': {} } } },
        {
          data: 'null',
          headers: { 'Content-Type': 'application/b+json; charset=utf-8' },
        },
      ).request.headers['content-type'],
    ).toBe('application/b+json; charset=utf-8');
    expect(prepare({ requestBody: { content: { 'application/json': {} } } }, { data: 'false' }).request.body).toBe(
      'false',
    );
  });
  it.each([
    [{}, 'No schema body', 'does not declare'],
    [{ method: 'GET' }, '{}', 'GET and HEAD'],
    [{ requestBody: { content: { 'application/json': {} } } }, '{secret', 'valid JSON'],
    [{ requestBody: { content: { 'text/xml': {} } } }, '{}', 'advertised JSON'],
    [{ requestBody: { content: { 'application/json': false } } }, '{}', 'media type is invalid'],
    [{ requestBody: { content: { 'application/a+json': {}, 'application/b+json': {} } } }, '{}', 'advertised JSON'],
  ])('reports body construction problems without echoing data %j', (operation, data, message) => {
    expect(() => prepare(operation, { data })).toThrow(message);
  });
  it.each([
    [{ type: 'integer' }, 1, true],
    [{ type: 'integer' }, 1.5, false],
    [{ type: 'integer' }, 9007199254740992, false],
    [{ type: 'number' }, 1.5, true],
    [{ type: 'boolean' }, false, true],
    [{ type: 'string' }, 'x', true],
    [{ type: 'null' }, null, true],
    [{ type: ['string', 'null'] }, null, true],
    [{ type: 'string', nullable: true }, null, true],
    [{ type: 'object' }, {}, true],
    [{ type: 'array', items: { type: 'number' } }, [1, 2], true],
    [{ type: 'nonsense' }, 1, false],
    [{ enum: ['one'] }, 'two', false],
    [{ enum: [{ a: 1 }] }, { a: 1 }, true],
    [{ const: 1 }, 2, false],
    [{ const: 'a' }, 'a', true],
    [true, 1, true],
    [false, 1, false],
    ['invalid', 1, false],
    [{ $ref: '#/components/schemas/Body' }, {}, false],
    [{ oneOf: [] }, {}, false],
    [{ type: 'object', additionalProperties: false }, { extra: 1 }, false],
  ])('checks the supported schema subset %j', (schema, value, succeeds) => {
    const run = () =>
      prepare({ requestBody: { content: { 'application/json': { schema } } } }, { data: JSON.stringify(value) });
    if (succeeds) expect(run).not.toThrow();
    else expect(run).toThrow();
  });
  it('bounds schema traversal', () => {
    let value: unknown = 'end';
    let schema: unknown = { type: 'string' };
    for (let index = 0; index < 34; index++) {
      value = [value];
      schema = { type: 'array', items: schema };
    }
    expect(() =>
      prepare({ requestBody: { content: { 'application/json': { schema } } } }, { data: JSON.stringify(value) }),
    ).toThrow('nesting depth');
  });
  it('redacts only recognized credential locations without altering the executable request', () => {
    const securitySchemes = {
      key: { type: 'apiKey', in: 'query', name: 'key' },
      headerKey: { type: 'apiKey', in: 'header', name: 'X-Key' },
      bearer: { type: 'http', scheme: 'bearer' },
      ignored: { type: 'apiKey' },
    };
    const doc = document({
      securitySchemes,
      security: [{ key: [] }],
      parameters: [
        { in: 'path', name: 'id' },
        { in: 'query', name: 'q' },
      ],
      requestBody: { content: { 'application/json': {} } },
    });
    const prepared = prepareOpenApiRequest(doc, {
      ...input,
      headers: {
        Authorization: 'Bearer secret',
        'Proxy-Authorization': 'Basic secret',
        'X-Key': 'header-secret',
        'X-Ordinary': 'visible',
      },
      parameters: { path: { id: 'x' }, query: { key: 'query-secret', q: 'a b' } },
      data: '{"card":"not-scanned"}',
    });
    const operation = doc.operations[0];
    if (operation === undefined) throw new Error('Missing fixture operation');
    const preview = previewOpenApiRequest(prepared, operation);
    expect(JSON.stringify(preview)).not.toContain('secret');
    expect(preview.request.url).toContain('q=a%20b&key=%5BREDACTED%5D');
    expect(preview.request.body).toBe('{"card":"not-scanned"}');
    expect(preview.request.headers['x-ordinary']).toBe('visible');
    expect(preview.redactions).toHaveLength(4);
    expect(preview.authentication).toEqual({ requirements: [{ key: [] }], verified: false });
    expect(prepared.request.url).toContain('query-secret');
    expect(prepared.request.headers['authorization']).toContain('secret');
    const basic = document().operations[0];
    if (basic === undefined) throw new Error('Missing fixture operation');
    expect(previewOpenApiRequest(prepare(), basic).redactions).toEqual([]);
  });
  it('redacts repeated declared query credentials without changing ordinary query encoding', () => {
    const doc = document({
      parameters: [
        { in: 'path', name: 'id' },
        { in: 'query', name: 'key' },
        { in: 'query', name: 'ordinary' },
      ],
      securitySchemes: { key: { type: 'apiKey', in: 'query', name: 'key' } },
    });
    const prepared = prepareOpenApiRequest(doc, {
      ...input,
      parameters: { path: { id: 'a' }, query: { key: ['a', 'b'], ordinary: 'a b' } },
    });
    const operation = doc.operations[0];
    if (operation === undefined) throw new Error('Missing fixture operation');
    const preview = previewOpenApiRequest(prepared, operation);
    expect(preview.request.url).toBe(
      'https://example.com/v1/items/a?key=%5BREDACTED%5D&key=%5BREDACTED%5D&ordinary=a%20b',
    );
    expect(preview.redactions).toEqual([{ location: 'query', name: 'key' }]);
    const noId = document();
    for (const item of noId.operations) delete item.operationId;
    expect(
      prepareOpenApiRequest(noId, { method: 'POST', path: '/items/{id}', parameters: input.parameters }).operation,
    ).not.toHaveProperty('operationId');
  });
  it('uses the actual reader for inherited parameters, relative servers and external parameter/body references', async () => {
    const cache: PublicSourceCache = { get: () => undefined, set: () => undefined, delete: () => undefined };
    const fetch = vi.fn((url: URL) =>
      Promise.resolve(
        Response.json(
          url.pathname === '/openapi.json'
            ? {
                openapi: '3.0.3',
                info: { title: 'Example' },
                servers: [{ url: '/v1' }],
                paths: {
                  '/items/{id}': {
                    parameters: [{ $ref: './defs.json#/parameter' }],
                    post: { operationId: 'create', requestBody: { $ref: './defs.json#/body' } },
                  },
                },
              }
            : {
                parameter: { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
                body: {
                  required: true,
                  content: { 'application/json': { schema: { type: 'object', required: ['query'] } } },
                },
              },
        ),
      ),
    );
    const result = await new SourceDiscovery(new PublicSourceDocuments(cache, fetch)).inspect(
      'https://example.com/openapi.json',
    );
    if (result.sourceType !== 'openapi') throw new Error('Expected OpenAPI');
    const prepared = prepareOpenApiRequest(result.document, {
      operationId: 'create',
      parameters: { path: { id: 5 } },
      data: '{"query":"weather"}',
    });
    expect(prepared.request.url).toBe('https://example.com/v1/items/5');
    expect(fetch.mock.calls.map(([url]) => url.pathname)).toEqual(['/openapi.json', '/defs.json']);
  });
});
