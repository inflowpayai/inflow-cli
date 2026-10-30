import {
  OdpInspectionError,
  OdpResource,
  type OdpServiceOptions,
  OdpRequestError,
  type ResolvedAction,
  SecureStorageError,
  type ServiceInspection,
} from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { actionOutput } from '../../../src/commands/odp/schema.js';
import { ActionView, __testing, createActionsCli } from '../../../src/commands/odp/actions.js';
import { OdpCommandError } from '../../../src/commands/odp/command.js';
import * as renderer from '../../../src/utils/render-ink-until-exit.js';

const resolved: ResolvedAction = {
  action: {
    authentication: 'not-required',
    id: 'download-dataset',
    rel: 'download',
    target: { kind: 'http', method: 'GET', url: 'https://data.example/actions/dataset' },
  },
};

const inspection: ServiceInspection = {
  capabilities: {
    enrollment: [],
    operations: [{ authentication: 'not-required', name: 'get-offering' }],
    payments: [],
    trust: [],
  },
  document: {
    description: 'Data catalog',
    http: { endpoint_base: '/odp' },
    language: 'en',
    localizations: ['en'],
    name: 'Data',
    odp_version: '1.0',
    operations: [{ authentication: 'not-required', name: 'get-offering' }],
    protocols: {},
  },
  finalUrl: new URL('https://data.example/.well-known/odp'),
  freshness: 'fetched',
  requestedUrl: new URL('https://data.example/.well-known/odp'),
  serviceOrigin: 'https://data.example',
};

function actionResource(result: ResolvedAction = resolved) {
  const client = {
    inspect: vi.fn(() => Promise.resolve(inspection)),
    resolveAction: vi.fn(() => Promise.resolve(result)),
  };
  return { client, resource: { service: vi.fn(() => client) } };
}

describe('ODP Action commands', () => {
  it.each([
    [
      'invalid OpenAPI component name',
      {
        openapi: '3.1.0',
        info: { title: 'Catalog', version: '1' },
        paths: {},
        components: { securitySchemes: { 'API/Key': { type: 'http', scheme: 'bearer' } } },
      },
      "The service's advertised OpenAPI document is invalid.",
    ],
    [
      'unsupported OpenAPI version',
      { openapi: '3.0.0', info: { title: 'Catalog', version: '1' }, paths: {} },
      "The service's advertised action requires an OpenAPI 3.1 document.",
    ],
    [
      'missing JSON Schema dialect',
      { type: 'object', properties: {} },
      'The service\'s request or attribute schema must declare "$schema": "https://json-schema.org/draft/2020-12/schema".',
    ],
  ])('explains SDK validation of %s through the registered command', async (_name, document, reason) => {
    const target =
      'openapi' in document
        ? { openapi: { url: '/document.json', operation_id: 'download' } }
        : { http: { href: '/download', method: 'POST', request: { schema: { url: '/document.json' } } } };
    const requests: string[] = [];
    const transport: typeof globalThis.fetch = (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push(url.pathname);
      if (url.pathname === '/.well-known/odp')
        return Promise.resolve(
          Response.json(
            {
              odp_version: '1.0',
              name: 'Catalog',
              description: 'Catalog description',
              language: 'en',
              localizations: ['en'],
              http: { endpoint_base: '/odp' },
              operations: [
                { name: 'get-offering', authentication: 'not-required' },
                { name: 'list-offerings', authentication: 'not-required' },
              ],
            },
            { headers: { 'content-type': 'application/odp+json' } },
          ),
        );
      if (url.pathname === '/odp/offerings/dataset')
        return Promise.resolve(
          Response.json(
            {
              odp_version: '1.0',
              id: 'dataset',
              name: 'Dataset',
              actions: [{ authentication: 'not-required', id: 'download', rel: 'download', ...target }],
            },
            { headers: { 'content-type': 'application/odp+json' } },
          ),
        );
      if (url.pathname === '/document.json')
        return Promise.resolve(
          Response.json(document, {
            headers: { 'content-type': 'openapi' in document ? 'application/json' : 'application/schema+json' },
          }),
        );
      throw new Error(`Unexpected request: ${url.pathname}`);
    };
    const output: string[] = [];
    const exit = vi.fn();
    const resource = new OdpResource('production', transport);
    await createActionsCli({
      service: (options: OdpServiceOptions) => resource.service({ ...options, supportingTransport: transport }),
    }).serve(['resolve', 'https://data.example', 'dataset', 'download', '--format', 'json'], {
      exit,
      stdout: (chunk) => {
        output.push(chunk);
      },
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(output.join(''))).toMatchObject({
      code: 'ODP_ACTION_RESOLVE_FAILED',
      message: `ODP Action resolution failed. ${reason}`,
      retryable: false,
    });
    expect(requests).toContain('/document.json');
    expect(requests).not.toContain('/download');
  });

  it('renders a resolved Action in a human terminal without invoking it', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const rendered = vi.spyOn(renderer, 'renderInkUntilExit').mockResolvedValue(undefined);
    const { resource, client } = actionResource();
    try {
      await createActionsCli(resource).serve(['resolve', 'https://data.example', 'dataset', 'download-dataset'], {
        exit: vi.fn(),
        stdout: vi.fn(),
      });
      expect(rendered).toHaveBeenCalledOnce();
      expect(client.resolveAction).toHaveBeenCalledWith('dataset', 'download-dataset');
      const element = rendered.mock.calls[0]?.[0];
      if (element === undefined) throw new Error('Missing Action view');
      const view = render(element);
      expect(view.lastFrame()).toContain('https://data.example/actions/dataset');
      view.unmount();
    } finally {
      rendered.mockRestore();
      if (descriptor === undefined) Reflect.deleteProperty(process.stdout, 'isTTY');
      else Object.defineProperty(process.stdout, 'isTTY', descriptor);
    }
  });

  it('renders optional authentication and unconstrained request properties without inventing requirements', () => {
    const view = render(
      <ActionView
        resolution={{
          offering_id: 'dataset',
          service_origin: 'https://data.example',
          action: {
            ...resolved.action,
            authentication: 'optional',
            description: 'Download a subset.',
            target: { kind: 'http', method: 'POST', url: '/download', response_content_types: ['application/json'] },
          },
          request_schema: { type: 'object', properties: { query: { type: 'string' }, extensions: true } },
        }}
      />,
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Optional');
    expect(frame).toContain('Download a subset.');
    expect(frame).toContain('https://data.example/download');
    expect(frame).toContain('Not constrained');
    expect(frame).toContain('Not advertised');
    expect(frame).toMatch(/query\s+string\s+No/);
    expect(frame).toContain('application/json');
    view.unmount();
  });

  it('resolves an Action without invoking its target', async () => {
    const { client, resource } = actionResource();
    await expect(
      __testing.runActionResolve(resource, 'https://data.example/catalog', 'dataset', 'download-dataset'),
    ).resolves.toEqual({ ...resolved, offering_id: 'dataset', service_origin: 'https://data.example' });
    expect(resource.service).toHaveBeenCalledWith({ serviceUrl: 'https://data.example/catalog' });
    expect(client.resolveAction).toHaveBeenCalledWith('dataset', 'download-dataset');
  });

  it('renders direct and OpenAPI targets', () => {
    const direct =
      render(
        <ActionView resolution={{ ...resolved, offering_id: 'dataset', service_origin: 'https://data.example' }} />,
      ).lastFrame() ?? '';
    expect(direct).toContain('Action ID');
    expect(direct).toContain('Offering ID');
    expect(direct).toContain('https://data.example/actions/dataset');

    const selectable: ResolvedAction = {
      action: {
        authentication: 'required',
        id: 'purchase',
        rel: 'purchase',
        target: {
          kind: 'http',
          method: 'POST',
          request: { content_type: 'application/json', schema: { url: 'https://data.example/schemas/purchase' } },
          url: 'https://data.example/actions/purchase',
        },
      },
      request_schema: {
        properties: {
          color: { description: 'The selected pot color.', enum: ['Black', 'White'], type: 'string' },
        },
        required: ['color'],
        type: 'object',
      },
    };
    const selectableOutput =
      render(
        <ActionView
          resolution={{ ...selectable, offering_id: 'rubber-plant', service_origin: 'https://data.example' }}
        />,
      ).lastFrame() ?? '';
    expect(selectableOutput).toContain('Action Inputs');
    expect(selectableOutput).toContain('Black, White');
    expect(selectableOutput).toContain('The selected pot color.');

    const openapi: ResolvedAction = {
      action: {
        authentication: 'required',
        id: 'quote',
        rel: 'quote',
        target: { kind: 'openapi', operation_id: 'createQuote', url: 'https://data.example/openapi.json' },
      },
      openapi_document: { openapi: '3.1.0' },
      operation: { responses: { '200': { description: 'Quote' } } },
    };
    expect(
      render(
        <ActionView resolution={{ ...openapi, offering_id: 'dataset', service_origin: 'https://data.example' }} />,
      ).lastFrame(),
    ).toContain('createQuote');
  });

  it.each([
    [new OdpInspectionError('invalid', 'validation_failed'), 'ODP_INSPECT_FAILED', false],
    [new OdpInspectionError('missing', 'http_error', 404), 'ODP_INSPECT_FAILED', false],
    [new OdpInspectionError('unavailable', 'http_error', 503), 'ODP_INSPECT_FAILED', true],
    [new OdpRequestError(new Response(undefined, { status: 503 })), 'ODP_SERVICE_HTTP_ERROR', true],
    [new SecureStorageError('vault_locked', 'Unlock the vault.'), 'VAULT_LOCKED', undefined],
    [new TypeError('invalid URL'), 'ODP_ACTION_RESOLVE_FAILED', false],
    [new Error('unsupported operation'), 'ODP_ACTION_RESOLVE_FAILED', false],
  ] as const)('maps resolution failures without exposing Service details', async (error, code, retryable) => {
    const client = {
      inspect: vi.fn(() => Promise.resolve(inspection)),
      resolveAction: vi.fn(() => Promise.reject(error)),
    };
    const resource = { service: vi.fn(() => client) };
    try {
      await __testing.runActionResolve(resource, 'https://data.example', 'dataset', 'download-dataset');
      throw new Error('Expected Action resolution to fail.');
    } catch (caught) {
      expect(caught).toBeInstanceOf(OdpCommandError);
      if (caught instanceof OdpCommandError) {
        expect(caught.detail.code).toBe(code);
        expect(caught.detail.retryable).toBe(retryable);
      }
    }
  });

  it('dispatches the registered resolve command in agent mode', async () => {
    const { resource } = actionResource();
    const output: string[] = [];
    await createActionsCli(resource).serve(
      ['resolve', 'https://data.example', 'dataset', 'download-dataset', '--format', 'json'],
      {
        exit: vi.fn(),
        stdout(chunk) {
          output.push(chunk);
        },
      },
    );
    expect(output.join('')).toContain('download-dataset');
    expect(actionOutput.safeParse(JSON.parse(output.join(''))).error).toBeUndefined();
    expect(output.join('')).toContain('https://data.example/actions/dataset');
  });

  it('returns a stable resolve failure from the registered command', async () => {
    const output: string[] = [];
    const exit = vi.fn();
    const client = {
      inspect: vi.fn(() => Promise.resolve(inspection)),
      resolveAction: vi.fn(() => Promise.reject(new TypeError('private Action failure'))),
    };

    await createActionsCli({ service: vi.fn(() => client) }).serve(
      ['resolve', 'https://data.example', 'dataset', 'download-dataset'],
      {
        exit,
        stdout(chunk) {
          output.push(chunk);
        },
      },
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(output.join('')).toContain('ODP_ACTION_RESOLVE_FAILED');
    expect(output.join('')).not.toContain('private Action failure');
  });
});
