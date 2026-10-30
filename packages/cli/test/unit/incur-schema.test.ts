import { Cli, Mcp, Schema, z } from 'incur';
import { OdpResource } from '@inflowpayai/inflow-core';
import { describe, expect, it, vi } from 'vitest';
import { enrollOptions, fetchOptions, grantOptions, inspectOptions } from '../../src/commands/aep/schema.js';
import { enrollOutput, grantOutput, statusOutput } from '../../src/commands/aep/schema.js';
import { directorySearchOutput } from '../../src/commands/directory/schema.js';
import {
  capabilitiesOutput,
  collectionPageOutput,
  discoveryOutput,
  inspectionOutput,
} from '../../src/commands/odp/schema.js';
import { callOutput } from '../../src/commands/openapi/schema.js';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { listOptions as subscriptionListOptions } from '../../src/commands/subscriptions/schema.js';

const options = z.object({
  required: z.string(),
  count: z.coerce.number().int().min(1).max(10).default(5),
  enabled: z.boolean().default(false),
  header: z.array(z.string()).default([]),
  optional: z.string().optional(),
});

describe('Incur schema direction', () => {
  it.each(['ucum', 'service'])('preserves SDK-parsed HTTP and %s unit extensions through MCP', async (system) => {
    const unit = { system, code: 'kg', title: 'Kilograms', extension: { precision: 2 } };
    const document = {
      odp_version: '1.0',
      name: 'Catalog',
      description: 'Catalog description',
      language: 'en',
      localizations: ['en'],
      operations: ['list-offerings', 'get-offering', 'search-offerings'].map((name) => ({
        name,
        authentication: 'not-required',
      })),
      http: { endpoint_base: '/odp', extension: { revision: 'one' } },
      search_capabilities: {
        filters: {
          inline: [{ id: 'weight', title: 'Weight', description: 'Weight', type: 'number', operators: ['eq'], unit }],
        },
      },
    };
    const transport: typeof globalThis.fetch = () =>
      Promise.resolve(Response.json(document, { headers: { 'content-type': 'application/odp+json' } }));
    const client = new OdpResource('production', transport).service({ serviceUrl: 'https://catalog.example' });
    const inspection = await client.inspect();
    expect(inspection.document.http).toEqual(document.http);
    const catalog = await client.getOfferingSearchCapabilities();
    expect(catalog.filters.get('weight')?.unit).toEqual(unit);
    const capabilities = {
      service_origin: inspection.serviceOrigin,
      filters: [...catalog.filters.values()],
      sorts: [...catalog.sorts.values()],
      issues: catalog.issues,
    };
    for (const [schema, result] of [
      [inspectionOutput, inspection],
      [capabilitiesOutput, capabilities],
    ] as const) {
      const value: unknown = JSON.parse(JSON.stringify(result));
      const validated = await fromJsonSchema(Schema.toJsonSchema(schema))['~standard'].validate(value);
      expect(validated).toEqual({ value });
    }
    expect(Schema.toJsonSchema(inspectionOutput)).toMatchObject({
      properties: {
        document: {
          properties: {
            http: { properties: { openapi: { additionalProperties: false } } },
            protocols: { additionalProperties: false },
          },
        },
      },
    });
  });

  it.each(['active', 'ACTIVE', 'Past_Due', 'REvoked', 'unknown'])(
    'describes the actual case-insensitive subscription status input %s',
    async (status) => {
      const parsed = subscriptionListOptions.safeParse({ status });
      const validated = await fromJsonSchema(Schema.toJsonSchema(subscriptionListOptions, { io: 'input' }))[
        '~standard'
      ].validate({ status });
      expect(validated.issues === undefined).toBe(parsed.success);
      if (parsed.success) expect(parsed.data.status).toBe(status.toLowerCase());
    },
  );
  it.each([
    ['pending enrollment without continuation', enrollOutput, { state: 'pending' }],
    [
      'granted credential without an identifier',
      grantOutput,
      { granted: true, service_did: 'did:web:service.example' },
    ],
    ['unknown local enrollment without local metadata', statusOutput, { enrolled: false, service: null }],
    ['directory result without a resource type', directorySearchOutput, { items: [{ name: 'invalid' }] }],
    ['Collection page without its Service origin', collectionPageOutput, { odp_version: '1.0', items: [] }],
    [
      'federated result without Service metadata',
      discoveryOutput,
      { items: [{ offering: { id: 'one', name: 'One' } }] },
    ],
    ['sent OpenAPI response without HTTP status', callOutput, { outcome: 'http-error', sent: true }],
  ] as const)('MCP rejects %s', async (_name, schema, value) => {
    const validated = await fromJsonSchema(Schema.toJsonSchema(schema))['~standard'].validate(value);
    expect(validated.issues?.length).toBeGreaterThan(0);
  });

  it('preserves unknown directory resources and additive page fields through MCP validation', async () => {
    const value = {
      items: [{ type: 'unknown', resource_type: 'future-resource', raw: { custom: [1, 'value'] } }],
      future_page_field: true,
    };
    const validated = await fromJsonSchema(Schema.toJsonSchema(directorySearchOutput))['~standard'].validate(value);
    expect(validated).toEqual({ value });
  });
  it.each([
    ['enroll', enrollOptions, 900],
    ['fetch', fetchOptions, 900],
    ['grant', grantOptions, 900],
    ['inspect', inspectOptions, 300],
  ] as const)(
    'advertises the existing %s timeout limits without replacing handler error checks',
    (_name, schema, maximum) => {
      expect(Schema.toJsonSchema(schema, { io: 'input' })).toMatchObject({
        properties: { timeout: { type: 'number', exclusiveMinimum: 0, maximum } },
      });
      expect(schema.safeParse({ timeout: 0 }).success).toBe(true);
      expect(schema.safeParse({ timeout: maximum + 1 }).success).toBe(true);
    },
  );
  it('describes defaults as optional input without dropping types or limits', () => {
    expect(Schema.toJsonSchema(options, { io: 'input' })).toMatchObject({
      type: 'object',
      required: ['required'],
      properties: {
        count: { type: 'integer', default: 5, minimum: 1, maximum: 10 },
        enabled: { type: 'boolean', default: false },
        header: { type: 'array', default: [], items: { type: 'string' } },
        optional: { type: 'string' },
      },
    });
    expect(options.parse({ required: 'value' })).toEqual({ required: 'value', count: 5, enabled: false, header: [] });
    expect(options.safeParse({ required: 'value', count: 11 }).success).toBe(false);
  });

  it('retains required defaulted fields in output schemas', () => {
    expect(Schema.toJsonSchema(options)).toMatchObject({ required: ['required', 'count', 'enabled', 'header'] });
    expect(Schema.toJsonSchema(options, { io: 'output' })).toEqual(Schema.toJsonSchema(options));
  });

  it('uses input semantics in the MCP command catalog', () => {
    const [tool] = Mcp.collectTools(new Map([['sample', { options, run: () => ({}) }]]), []);
    expect(tool?.inputSchema).toMatchObject({ required: ['required'], properties: { count: { default: 5 } } });
  });

  it.each([['sample', '--schema'], ['--llms-full']])(
    'keeps input and output requirements distinct for %j',
    async (...args) => {
      const run = vi.fn(() => ({ required: 'result', count: 5, enabled: false, header: [] }));
      const cli = Cli.create('test');
      cli.command('sample', { options, output: options, run });
      let text = '';
      await cli.serve([...args, '--format', 'json'], {
        exit: vi.fn(),
        stdout: (value) => {
          text += value;
        },
      });
      const parsed = JSON.parse(text) as {
        options?: { required?: string[] };
        output?: { required?: string[] };
        commands?: { schema: { options?: { required?: string[] }; output?: { required?: string[] } } }[];
      };
      const command = parsed.commands?.[0]?.schema ?? parsed;
      expect(command.options?.required).toEqual(['required']);
      expect(command.output?.required).toEqual(['required', 'count', 'enabled', 'header']);
      expect(run).not.toHaveBeenCalled();
    },
  );
});
