import { describe, expect, it } from 'vitest';
import { Inflow } from '../../src/index.js';

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

    expect(publicCalls).toHaveLength(1);
    expect(authenticatedCalls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/.well-known/odp',
      '/odp/offerings/gpu',
    ]);

    authenticatedCalls.length = 0;
    const unpartitionedClient = inflow.odp
      .withServiceTransport({ transport: authenticatedFetch })
      .service({ serviceUrl: 'https://compute.example' });
    await unpartitionedClient.getOffering('gpu', { representation: 'full' });
    await unpartitionedClient.getOffering('gpu', { representation: 'full' });
    expect(authenticatedCalls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/.well-known/odp',
      '/odp/offerings/gpu',
      '/odp/offerings/gpu',
    ]);
  });
});
