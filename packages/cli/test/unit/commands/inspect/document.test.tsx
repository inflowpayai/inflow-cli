import {
  Inflow,
  MemoryStorage,
  PublicSourceDocuments,
  SourceDiscovery,
  SourceDiscoveryError,
  type PublicSourceCache,
  type SourceDiscoveryResult,
} from '@inflowpayai/inflow-core';
import { Cli } from 'incur';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInspectCommand,
  runCombinedInspectCommand,
  type InspectCommandContext,
} from '../../../../src/commands/inspect/index.js';
import { DocumentView, inspectDocument } from '../../../../src/commands/inspect/document.js';
import { isDocumentInspect } from '../../../../src/commands/inspect/routing.js';
import {
  isPublicDocumentInspect,
  shouldConfigureOdpServiceTransport,
  shouldStartVaultDaemon,
  shouldReconcileVaultDaemon,
  shouldUnlockVault,
} from '../../../../src/startup-vault.js';
import * as renderer from '../../../../src/utils/render-ink-until-exit.js';

afterEach(() => vi.restoreAllMocks());

const api = {
  openapi: '3.1.0',
  info: { title: 'Weather' },
  paths: { '/weather': { get: { security: [{ siwx: [] }] } } },
  components: { securitySchemes: { siwx: { type: 'http', scheme: 'siwx' } } },
};

function setup(native = false) {
  const entries = new Map<string, unknown>();
  const cache: PublicSourceCache = {
    get: (kind, key) => entries.get(kind + key),
    set: (kind, key, value) => {
      entries.set(kind + key, value);
    },
    delete: (kind, key) => {
      entries.delete(kind + key);
    },
  };
  const fetch = vi.fn((url: URL) =>
    Promise.resolve(
      url.pathname === '/openapi.json'
        ? Response.json(api)
        : native && url.pathname === '/.well-known/odp'
          ? Response.json({
              odp_version: '1.0',
              name: 'Weather',
              description: 'Weather reports',
              language: 'en',
              localizations: ['en'],
              http: { endpoint_base: '/odp' },
              operations: [
                { name: 'list-offerings', authentication: 'not-required' },
                { name: 'get-offering', authentication: 'not-required' },
              ],
            })
          : new Response(null, { status: 404 }),
    ),
  );
  return { fetch, discovery: new SourceDiscovery(new PublicSourceDocuments(cache, fetch)) };
}

function context(url = 'https://weather.test/openapi.json'): InspectCommandContext {
  return {
    args: { url },
    options: { header: [] },
    agent: true,
    formatExplicit: true,
    error: (error) => {
      throw Object.assign(new Error(error.message), { code: error.code });
    },
  };
}

describe('automatic inspection routing', () => {
  it.each([
    'https://example.com',
    'https://example.com/',
    'https://example.com/?v=1',
    'https://example.com/.well-known/odp',
    'https://example.com/.well-known/x402.json',
    'https://example.com/v1/OpenAPI.JSON',
  ])('routes %s as a public document', (url) => {
    expect(isDocumentInspect(url, { header: [] })).toBe(true);
    const argv = ['node', 'inflow', 'inspect', url];
    expect(isPublicDocumentInspect(argv)).toBe(true);
    for (const decision of [
      shouldConfigureOdpServiceTransport,
      shouldStartVaultDaemon,
      shouldReconcileVaultDaemon,
      shouldUnlockVault,
    ])
      expect(decision(argv)).toBe(false);
  });
  it.each([
    'https://example.com/data',
    'https://example.com/.well-known/aep',
    'https://example.com/.well-known/other',
    'not a url',
  ])('preserves endpoint routing for %s', (url) => {
    expect(isDocumentInspect(url, { header: [] })).toBe(false);
  });
  it.each([
    ['--method', 'GET'],
    ['--data', ''],
    ['--header', 'Accept: application/json'],
    ['--method=GET'],
    ['--data={}'],
    ['--header=X-Test: value'],
  ])('keeps explicit request option %s in the probe flow', (...flags) => {
    for (const args of [
      ['inspect', 'https://example.com', ...flags],
      ['inspect', ...flags, 'https://example.com'],
    ]) {
      const argv = ['node', 'inflow', ...args];
      expect(isPublicDocumentInspect(argv)).toBe(false);
      expect(shouldConfigureOdpServiceTransport(argv)).toBe(true);
    }
  });
  it('uses explicit options in parsed CLI and MCP inputs', () => {
    for (const options of [
      { method: 'GET', header: [] },
      { data: '', header: [] },
      { header: ['Accept: application/json'] },
    ])
      expect(isDocumentInspect('https://example.com', options)).toBe(false);
    expect(isPublicDocumentInspect(['node', 'cli', 'inspect'])).toBe(false);
    expect(isPublicDocumentInspect(['node', 'cli', 'openapi', 'https://example.com'])).toBe(false);
  });
});

describe('public document inspection', () => {
  it('renders a shell-quoted JSON body in the generated command reference', async () => {
    const cli = Cli.create('inflow');
    cli.command('inspect', createInspectCommand(new Inflow()));
    const stdout = vi.fn();
    await cli.serve(['--llms-full'], { stdout, exit: vi.fn() });
    expect(stdout.mock.calls.flat().join('')).toContain(
      'inflow inspect https://api.foo.dev/widgets --method POST --data \'{"sku":"widget-1"}\'',
    );
  });

  it.each([true, false])('preserves a single default GET endpoint probe (agent=%s)', async (agent) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('public', { status: 200 }));
    if (!agent)
      vi.spyOn(renderer, 'renderInkUntilExit').mockImplementation(async (element) => {
        const view = render(element);
        try {
          await vi.waitFor(() => expect(view.lastFrame()).toContain('200'));
        } finally {
          view.unmount();
        }
      });
    const result = await runCombinedInspectCommand({
      ...context('https://weather.test/weather'),
      agent,
      formatExplicit: agent,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://weather.test/weather', expect.objectContaining({ method: 'GET' }));
    if (agent) expect(result).toMatchObject({ method: 'GET', status: 200, outcome: 'no-payment-required' });
  });
  it.each([false, true])('discovers an origin without probing or accessing credentials (native=%s)', async (native) => {
    const { discovery, fetch } = setup(native);
    const storage = new MemoryStorage();
    const inflow = new Inflow({ authStorage: storage });
    const probe = vi.spyOn(inflow.odp, 'inspect').mockRejectedValue(new Error('Must not probe'));
    const cli = Cli.create('inflow');
    cli.command('inspect', createInspectCommand(inflow, storage, undefined, discovery));
    const stdout = vi.fn();
    await cli.serve(['inspect', 'https://weather.test', '--format', 'json'], { stdout, exit: vi.fn() });
    const result = JSON.parse(stdout.mock.calls.flat().join('')) as {
      outcome: string;
      source: { type: string };
      operation_count?: number;
    };
    expect(result).toMatchObject({ outcome: 'document-inspected' });
    expect(result.source.type).toBe(native ? 'odp' : 'openapi');
    expect(probe).not.toHaveBeenCalled();
    expect(fetch.mock.calls.every(([url]) => url.pathname !== '/' && url.pathname !== '/weather')).toBe(true);
    if (!native) expect(result.operation_count).toBe(1);
  });
  it('fetches an exact document once and does not fall back on failure', async () => {
    const { discovery, fetch } = setup();
    const result = await inspectDocument(context(), discovery);
    expect(result['source']).toEqual({ type: 'openapi', url: 'https://weather.test/openapi.json' });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(inspectDocument(context('https://weather.test/bad-openapi'), discovery)).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('renders public documents and forwards refresh', async () => {
    const { discovery } = setup();
    const inspect = vi.spyOn(discovery, 'inspect');
    const renderSpy = vi.spyOn(renderer, 'renderInkUntilExit').mockResolvedValue(undefined);
    await inspectDocument(
      { ...context(), agent: false, formatExplicit: false, options: { header: [], refresh: true } },
      discovery,
    );
    expect(inspect).toHaveBeenCalledWith(context().args.url, expect.objectContaining({ refresh: true }));
    expect(renderSpy).toHaveBeenCalledOnce();
    const result = await discovery.inspect(context().args.url);
    const frame = render(<DocumentView result={result} />).lastFrame();
    expect(frame).toContain('siwx');
    expect(frame).toContain('Operation count: 1');
    const empty: SourceDiscoveryResult = {
      sourceType: 'openapi',
      sourceUrl: result.sourceUrl,
      document: {
        sourceUrl: result.sourceUrl,
        retrievalUrl: result.sourceUrl,
        title: 'Empty',
        version: '3.1.0',
        operations: [],
        limitations: [],
      },
    };
    expect(render(<DocumentView result={empty} />).lastFrame()).toContain('None');
  });
  it('renders native metadata without fabricating missing declarations', () => {
    const result = {
      sourceType: 'odp',
      sourceUrl: 'https://weather.test/.well-known/odp',
      document: {
        odp_version: '1.0',
        name: 'Weather',
        description: 'Weather reports',
        language: 'en',
        localizations: ['en'],
        http: { endpoint_base: '/odp' },
        operations: [],
      },
    } satisfies SourceDiscoveryResult;
    expect(render(<DocumentView result={result} />).lastFrame()).toContain('Weather');
    expect(render(<DocumentView result={result} />).lastFrame()).toContain('None');
    expect(
      render(
        <DocumentView
          result={{
            ...result,
            document: {
              ...result.document,
              name: 'Weather',
              operations: [{ name: 'list-offerings', authentication: 'not-required' }],
              protocols: { payments: [{ name: 'x402', authentication: 'required' }] },
            },
          }}
        />,
      ).lastFrame(),
    ).toContain('x402');
  });
  it.each([
    new Error('private fetch failure'),
    new SourceDiscoveryError('SOURCE_AMBIGUOUS', 'Choose a document.', ['https://weather.test/openapi.json']),
  ])('reports discovery failure without probing', async (error) => {
    await expect(inspectDocument(context(), { inspect: vi.fn().mockRejectedValue(error) })).rejects.toMatchObject({
      code: error instanceof SourceDiscoveryError ? 'SOURCE_AMBIGUOUS' : 'INSPECT_DOCUMENT_FAILED',
    });
  });
  it('rejects refresh in endpoint probing mode', async () => {
    const { discovery } = setup();
    const inspect = vi.spyOn(discovery, 'inspect');
    await expect(
      createInspectCommand(new Inflow({ authStorage: new MemoryStorage() }), undefined, undefined, discovery).run({
        ...context(),
        options: { method: 'GET', header: [], refresh: true },
      }),
    ).rejects.toMatchObject({ code: 'INSPECT_REFRESH_REQUIRES_DOCUMENT' });
    expect(inspect).not.toHaveBeenCalled();
  });
});
