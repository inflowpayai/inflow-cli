import { describe, expect, it, vi } from 'vitest';
import { createTapFetch, Inflow } from '../../src/index.js';
import type { ICliCapabilitiesResource, ITapResource } from '../../src/index.js';

const serviceDocument = {
  odp_version: '1.0',
  name: 'Compute',
  description: 'Compute catalog',
  language: 'en',
  localizations: ['en'],
  operations: [
    { authentication: 'not-required', name: 'get-offering' },
    { authentication: 'not-required', name: 'list-offerings' },
  ],
  http: { endpoint_base: '/odp' },
};

describe('Inflow.odp', () => {
  it('accepts an empty suggestion result from the directory', async () => {
    const fetch: typeof globalThis.fetch = () => Promise.resolve(Response.json({ items: [] }));
    const inflow = new Inflow({ fetch });

    await expect(inflow.odp.suggestServices({ prefix: 'unmatched' })).resolves.toEqual([]);
  });

  it('uses the canonical sandbox directory and sanitizes directory results', async () => {
    const calls: Request[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return Promise.resolve(
        Response.json({
          items: [
            {
              service_id: 'eb825701-7eab-42a4-ad1f-c73c7f163c8c',
              service_origin: 'https://compute.example',
              name: '\u001b[31mCompute\u001b[0m',
              description: 'Compute catalog',
              language: 'en',
              localizations: ['en'],
              operations: [
                { authentication: 'not-required', name: 'get-offering' },
                { authentication: 'not-required', name: 'list-offerings' },
              ],
              indexed_at: '2026-08-03T00:00:00Z',
            },
          ],
        }),
      );
    };
    const inflow = new Inflow({ environment: 'sandbox', fetch });
    const services = [];
    for await (const service of inflow.odp.searchServices().items) services.push(service);

    expect(calls[0]?.url).toBe('https://sandbox.inflowpay.ai/v1/services/search');
    expect(services[0]?.name).toBe('Compute');
    expect(services[0]?.['service_id']).toBe('eb825701-7eab-42a4-ad1f-c73c7f163c8c');
    expect(inflow.odp.environment).toBe('sandbox');
  });

  it('uses the configured transport for Service inspection and clients', async () => {
    const calls: Request[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      if (new URL(request.url).pathname !== '/.well-known/odp') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              odp_version: '1.0',
              items: [{ id: 'gpu', name: '\u001b[31mGPU\u001b[0m' }],
            }),
            { headers: { 'content-type': 'application/odp+json' } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(serviceDocument), {
          headers: { 'content-type': 'application/odp+json' },
        }),
      );
    };
    const inflow = new Inflow({ fetch });
    const inspection = await inflow.odp.inspect({ serviceUrl: 'https://compute.example' });

    expect(calls[0]?.url).toBe('https://compute.example/.well-known/odp');
    expect(inspection.document.name).toBe('Compute');
    const service = inflow.odp.service({ serviceUrl: 'https://compute.example' });
    const offerings = [];
    for await (const offering of service.listOfferings().items) offerings.push(offering);
    expect(offerings[0]?.name).toBe('GPU');
  });

  it('keeps public inspection separate and requires an access partition to cache catalog responses', async () => {
    const publicCalls: Request[] = [];
    const publicFetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      publicCalls.push(request);
      return Promise.resolve(
        new Response(JSON.stringify(serviceDocument), {
          headers: { 'content-type': 'application/odp+json' },
        }),
      );
    };
    const authenticatedCalls: Request[] = [];
    const authenticatedFetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      authenticatedCalls.push(request);
      const body =
        new URL(request.url).pathname === '/.well-known/odp'
          ? serviceDocument
          : { id: 'gpu', name: 'GPU', odp_version: '1.0' };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/odp+json' },
        }),
      );
    };
    const inflow = new Inflow({ fetch: publicFetch });
    const partitioned = inflow.odp.withServiceTransport({
      cachePartition: 'principal:one',
      transport: authenticatedFetch,
    });

    await partitioned.inspect({ serviceUrl: 'https://compute.example' });
    const partitionedClient = partitioned.service({ serviceUrl: 'https://compute.example' });
    await partitionedClient.getOffering('gpu', { representation: 'full' });
    await partitionedClient.getOffering('gpu', { representation: 'full' });

    expect(publicCalls).toHaveLength(2);
    expect(authenticatedCalls.map(({ url }) => new URL(url).pathname)).toEqual(['/odp/offerings/gpu']);

    authenticatedCalls.length = 0;
    const unpartitionedClient = inflow.odp
      .withServiceTransport({ transport: authenticatedFetch })
      .service({ serviceUrl: 'https://compute.example' });
    await unpartitionedClient.getOffering('gpu', { representation: 'full' });
    await unpartitionedClient.getOffering('gpu', { representation: 'full' });
    expect(publicCalls).toHaveLength(3);
    expect(authenticatedCalls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/odp/offerings/gpu',
      '/odp/offerings/gpu',
    ]);
  });

  it('allows inspection and service operations to use distinct configured transports', async () => {
    const inspectionFetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(serviceDocument), {
          headers: { 'content-type': 'application/odp+json' },
        }),
      ),
    );
    const serviceFetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'gpu', name: 'GPU', odp_version: '1.0' }), {
          headers: { 'content-type': 'application/odp+json' },
        }),
      ),
    );
    const resource = new Inflow({ fetch: vi.fn<typeof globalThis.fetch>() }).odp.withServiceTransport({
      inspectionTransport: inspectionFetch,
      transport: serviceFetch,
    });

    await resource.inspect({ serviceUrl: 'https://compute.example' });
    await resource.service({ serviceUrl: 'https://compute.example' }).getOffering('gpu', { representation: 'full' });

    expect(inspectionFetch).toHaveBeenCalledTimes(2);
    expect(serviceFetch).toHaveBeenCalledOnce();
  });

  it('signs actual ODP inspection and catalog requests as browsing attempts', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init);
      const body =
        new URL(request.url).pathname === '/.well-known/odp'
          ? serviceDocument
          : { odp_version: '1.0', items: [{ id: 'gpu', name: 'GPU' }] };
      return Promise.resolve(
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/odp+json' } }),
      );
    });
    const sign = vi.fn<ITapResource['sign']>((request) =>
      Promise.resolve({
        created: 1,
        expires: 301,
        keyid: 'key',
        nonce: request.targetUrl,
        signature: `sig2=:${request.targetUrl}:`,
        signatureInput: 'sig2=("@method")',
      }),
    );
    const tapFetch = createTapFetch({
      capabilities: enabledTapCapabilities(),
      fetch,
      operation: 'odp.browse',
      tap: { finalize: vi.fn<ITapResource['finalize']>(), sign },
    });
    const odp = new Inflow({ fetch }).odp.withServiceTransport({
      inspectionTransport: tapFetch,
      transport: tapFetch,
    });

    const offerings = [];
    for await (const offering of odp.service({ serviceUrl: 'https://compute.example' }).listOfferings().items) {
      offerings.push(offering);
    }

    const transmitted = fetch.mock.calls.map(([input, init]) => new Request(input, init));
    expect(offerings).toHaveLength(1);
    expect(sign.mock.calls.map(([request]) => request)).toEqual(
      transmitted.map((request) => ({
        method: 'GET',
        operation: 'odp.browse',
        targetUrl: request.url,
      })),
    );
    expect(transmitted.map(({ url }) => new URL(url).pathname)).toEqual(['/.well-known/odp', '/odp/offerings']);
    expect(transmitted.every(({ headers }) => headers.has('Signature'))).toBe(true);
  });

  it('lets ODP enforce redirects and signs each accepted request attempt independently', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { headers: { Location: '/odp-document' }, status: 307 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(serviceDocument), { headers: { 'content-type': 'application/odp+json' } }),
      );
    const sign = vi.fn<ITapResource['sign']>(() =>
      Promise.resolve({
        created: 1,
        expires: 301,
        keyid: 'key',
        nonce: 'nonce',
        signature: 'sig2=:value:',
        signatureInput: 'sig2=("@method")',
      }),
    );
    const tapFetch = createTapFetch({
      capabilities: enabledTapCapabilities(),
      fetch,
      operation: 'odp.browse',
      tap: { finalize: vi.fn<ITapResource['finalize']>(), sign },
    });
    const odp = new Inflow({ fetch }).odp.withServiceTransport({ inspectionTransport: tapFetch, transport: tapFetch });

    await odp.inspect({ serviceUrl: 'https://compute.example' });

    expect(sign.mock.calls.map(([request]) => request.targetUrl)).toEqual([
      'https://compute.example/.well-known/odp',
      'https://compute.example/odp-document',
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

function enabledTapCapabilities(): ICliCapabilitiesResource {
  return {
    get: vi.fn(() => Promise.resolve({ features: ['visa_tap'], minimumSupportedVersion: '0.12.1' })),
    has: vi.fn(() => Promise.resolve(true)),
  };
}
