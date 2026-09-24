import {
  PublicSourceDocuments,
  SourceDiscovery,
  SourceDiscoveryError,
  type PublicSourceCache,
  type OpenApiDescription,
  type OpenApiOperation,
} from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import {
  createOpenApiCli,
  OperationView,
  OperationsView,
  PreparedRequestView,
} from '../../../src/commands/openapi/index.js';
import { prepareOpenApiRequest, previewOpenApiRequest } from '@inflowpayai/inflow-core';
import * as renderer from '../../../src/utils/render-ink-until-exit.js';

function setup() {
  const values = new Map<string, unknown>();
  const cache: PublicSourceCache = {
    get: (kind, url) => values.get(`${kind}:${url}`),
    set: (kind, url, value) => {
      values.set(`${kind}:${url}`, value);
    },
    delete: (kind, url) => {
      values.delete(`${kind}:${url}`);
    },
  };
  const fetch = vi.fn((url: URL) =>
    Promise.resolve(
      url.pathname === '/v1/openapi.json'
        ? Response.json({
            openapi: '3.1.0',
            info: { title: '\u001b[31mWeather' },
            paths: {
              '/search': {
                post: {
                  operationId: 'search',
                  summary: 'Search forecasts',
                  requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
                },
              },
              '/items': { get: {} },
            },
          })
        : new Response(null, { status: 404 }),
    ),
  );
  const discovery = new SourceDiscovery(new PublicSourceDocuments(cache, fetch));
  return { fetch, discovery };
}

async function run(discovery: Pick<SourceDiscovery, 'inspect'>, args: string[]) {
  const output: string[] = [];
  const exit = vi.fn();
  await createOpenApiCli(discovery).serve(['operations', ...args, '--format', 'json'], {
    exit,
    stdout: (chunk) => {
      output.push(chunk);
    },
  });
  return { exit, value: JSON.parse(output.join('')) as unknown, text: output.join('') };
}

describe('OpenAPI commands', () => {
  it('sanitizes input names in preparation errors', async () => {
    const { discovery } = setup();
    const result = await run(discovery, [
      'prepare',
      'https://example.com',
      '--operation-id',
      'search',
      '--parameters',
      JSON.stringify({ query: { '\u001b[31munknown': 'value' } }),
    ]);
    expect(result.text).toContain('Unknown query parameter: unknown');
    expect(result.text).not.toContain('\\u001b');
  });
  it('prepares from a cold document through real discovery without invoking or persisting the request', async () => {
    const { discovery, fetch } = setup();
    const result = await run(discovery, [
      'prepare',
      'https://example.com',
      '--operation-id',
      'search',
      '--data',
      '{"query":"weather"}',
      '--header',
      'Authorization: Bearer secret',
    ]);
    expect(result.value).toMatchObject({
      outcome: 'request-prepared',
      source: { type: 'openapi', url: 'https://example.com/v1/openapi.json' },
      operation: { method: 'POST', path: '/search', operationId: 'search' },
      request: {
        method: 'POST',
        url: 'https://example.com/search',
        headers: { authorization: '[REDACTED]', 'content-type': 'application/json' },
        body: '{"query":"weather"}',
      },
      redactions: [{ location: 'header', name: 'authorization' }],
      authentication: { requirements: [], verified: false },
    });
    expect(result.text).not.toContain('secret');
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.every(([url]) => !['/search', '/items'].includes(url.pathname))).toBe(true);
    const without = await run(discovery, ['prepare', 'https://example.com', '--operation-id', 'search']);
    expect(without.value).toMatchObject({ request: { headers: {} }, redactions: [] });
    expect(without.text).not.toContain('weather');
  });
  it.each([
    [['--parameters', '{secret'], '--parameters must contain a JSON object'],
    [['--parameters', '[]'], '--parameters must contain a JSON object'],
    [['--parameters', 'null'], '--parameters must contain a JSON object'],
    [['--server-variables', '1'], '--server-variables must contain a JSON object'],
    [['--header', 'secret'], 'Use --header'],
    [['--header', 'X-Key: secret', '--header', 'x-key: secret'], 'only once'],
    [['--data', '{secret'], '--data must contain valid JSON'],
    [['--header', 'X-Test: a\r\nsecret'], 'valid printable'],
    [['--parameters', '{"query":{"unknown":"secret"}}'], 'Unknown query parameter'],
    [['--server', '2'], 'advertised server'],
  ])('reports invalid preparation inputs without exposing values %j', async (options, message) => {
    const { discovery } = setup();
    const result = await run(discovery, ['prepare', 'https://example.com', '--operation-id', 'search', ...options]);
    expect(result.text).toContain(message);
    expect(result.text).not.toContain('secret');
    expect(result.exit).toHaveBeenCalledWith(1);
  });
  it('accepts parsed parameters and server variables and displays a redacted human preview', async () => {
    const { discovery } = setup();
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const rendered = vi.spyOn(renderer, 'renderInkUntilExit').mockResolvedValue(undefined);
    try {
      await createOpenApiCli(discovery).serve(
        [
          'operations',
          'prepare',
          'https://example.com',
          '--operation-id',
          'search',
          '--parameters',
          '{}',
          '--server-variables',
          '{}',
          '--server',
          '1',
          '--data',
          '{}',
        ],
        { exit: vi.fn(), stdout: vi.fn() },
      );
      expect(rendered).toHaveBeenCalledTimes(1);
    } finally {
      rendered.mockRestore();
      if (descriptor === undefined) Reflect.deleteProperty(process.stdout, 'isTTY');
      else Object.defineProperty(process.stdout, 'isTTY', descriptor);
    }
    const result = await discovery.inspect('https://example.com', { format: 'openapi' });
    if (result.sourceType !== 'openapi') throw new Error('Expected OpenAPI');
    const operation = result.document.operations[0];
    if (operation === undefined) throw new Error('Expected operation');
    for (const data of [undefined, '{}']) {
      const prepared = prepareOpenApiRequest(result.document, {
        operationId: 'search',
        data,
        headers: { authorization: 'secret' },
      });
      const text = render(<PreparedRequestView preview={previewOpenApiRequest(prepared, operation)} />).lastFrame();
      expect(text).toContain('Prepared request');
      expect(text).toContain('Redacted header: authorization');
      expect(text).not.toContain('secret');
    }
  });
  it('renders both read commands in human mode', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const rendered = vi.spyOn(renderer, 'renderInkUntilExit').mockResolvedValue(undefined);
    try {
      const { discovery } = setup();
      for (const args of [
        ['list', 'https://example.com'],
        ['get', 'https://example.com', '--operation-id', 'search'],
      ]) {
        await createOpenApiCli(discovery).serve(['operations', ...args], { exit: vi.fn(), stdout: vi.fn() });
      }
      expect(rendered).toHaveBeenCalledTimes(2);
    } finally {
      rendered.mockRestore();
      if (descriptor === undefined) Reflect.deleteProperty(process.stdout, 'isTTY');
      else Object.defineProperty(process.stdout, 'isTTY', descriptor);
    }
  });
  it('discovers cold origins and reuses the exact document without requesting operations', async () => {
    const { discovery, fetch } = setup();
    const listed = await run(discovery, ['list', 'https://example.com']);
    expect(listed.value).toEqual({
      source: { type: 'openapi', url: 'https://example.com/v1/openapi.json' },
      title: 'Weather',
      openapi: '3.1.0',
      items: [
        { method: 'POST', path: '/search', operationId: 'search', summary: 'Search forecasts' },
        { method: 'GET', path: '/items' },
      ],
      limitations: [],
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    const detail = await run(discovery, [
      'get',
      'https://example.com/v1/openapi.json',
      '--method',
      'POST',
      '--path',
      '/search',
    ]);
    expect(detail.value).toMatchObject({
      source: { type: 'openapi', url: 'https://example.com/v1/openapi.json' },
      operation: { method: 'POST', path: '/search', requestBody: { content: { 'application/json': {} } } },
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    await run(discovery, ['get', 'https://example.com/v1/openapi.json', '--operation-id', 'search', '--refresh']);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.every(([url]) => !['/search', '/items'].includes(url.pathname))).toBe(true);
  });
  it('reports selector errors and exact missing documents without origin fallback', async () => {
    const { discovery, fetch } = setup();
    expect((await run(discovery, ['get', 'https://example.com/v1/openapi.json'])).text).toContain(
      'OPENAPI_SELECTOR_INVALID',
    );
    expect(
      (await run(discovery, ['get', 'https://example.com/v1/openapi.json', '--operation-id', 'absent'])).text,
    ).toContain('OPENAPI_OPERATION_NOT_FOUND');
    fetch.mockClear();
    expect((await run(discovery, ['list', 'https://example.com/missing.json'])).text).toContain('SOURCE_NOT_FOUND');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [
      new SourceDiscoveryError('SOURCE_AMBIGUOUS', 'Choose a document.', [
        'https://example.com/a',
        'https://example.com/b',
      ]),
      'https://example.com/b',
    ],
    [new Error('private transport details'), 'OPENAPI_READ_FAILED'],
  ])('reports actionable read failures without leaking private failures', async (error, text) => {
    const result = await run({ inspect: vi.fn(() => Promise.reject(error)) }, ['list', 'https://example.com']);
    expect(result.text).toContain(text);
    expect(result.text).not.toContain('private transport details');
    expect(result.exit).toHaveBeenCalledWith(1);
  });
  it('renders metadata, authentication, bodies and limitations without claiming execution support', () => {
    const operation: OpenApiOperation = {
      method: 'GET',
      path: '/items',
      servers: [],
      parameters: [],
      security: [],
      securitySchemes: {},
      limitations: ['Cookie input unsupported'],
    };
    const document: OpenApiDescription = {
      sourceUrl: 'https://example.com/spec',
      retrievalUrl: 'https://example.com/spec',
      title: 'Items',
      version: '3.1.0',
      operations: [operation],
      limitations: ['Webhooks unsupported'],
    };
    expect(render(<OperationView operation={operation} />).lastFrame()).toContain('Not declared');
    expect(
      render(
        <OperationView
          operation={{
            ...operation,
            operationId: 'items',
            summary: 'List',
            description: 'Full description',
            requestBody: { content: {} },
          }}
        />,
      ).lastFrame(),
    ).toContain('Full description');
    expect(render(<OperationsView document={document} />).lastFrame()).toContain('Webhooks unsupported');
    expect(render(<OperationsView document={{ ...document, operations: [] }} />).lastFrame()).toContain(
      'No operations declared',
    );
  });
});
