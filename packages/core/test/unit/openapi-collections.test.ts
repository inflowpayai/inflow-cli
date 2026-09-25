import { describe, expect, it, vi } from 'vitest';
import { OpenApiCollections } from '../../src/openapi/collections.js';
import type { OpenApiDescription } from '../../src/openapi/reader.js';

const document: OpenApiDescription = {
  sourceUrl: 'https://provider.example/openapi.json',
  retrievalUrl: 'https://provider.example/openapi.json',
  version: '3.1.0',
  title: 'Provider',
  limitations: [],
  operations: [
    {
      method: 'GET',
      path: '/weather',
      servers: [],
      parameters: [],
      security: [],
      securitySchemes: {},
      limitations: [],
    },
    {
      method: 'POST',
      path: '/weather',
      servers: [],
      parameters: [],
      security: [],
      securitySchemes: {},
      limitations: [],
    },
  ],
};
const payload = {
  source_url: document.sourceUrl,
  collection_id: 'weather',
  items: [{ method: 'GET', path: '/weather' }],
};

describe('OpenAPI Directory Collection selection', () => {
  it('uses the configured Directory without credentials, redirects, provider calls or mutation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(payload));
    const snapshot = structuredClone(document);
    const result = await new OpenApiCollections('https://sandbox.inflowpay.ai', fetch).operations(document, 'weather');
    expect(result).toEqual([document.operations[0]]);
    expect(document).toEqual(snapshot);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://sandbox.inflowpay.ai/v1/directory/collections/operations'),
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection_id: 'weather', source_url: document.sourceUrl }),
      }),
    );
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it('supports empty selections and deduplicates references', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ ...payload, items: [] }))
      .mockResolvedValueOnce(Response.json({ ...payload, items: [...payload.items, ...payload.items] }));
    const collections = new OpenApiCollections('https://api.inflowpay.ai', fetch);
    expect(await collections.operations(document, 'weather')).toEqual([]);
    expect(await collections.operations(document, 'weather')).toEqual([document.operations[0]]);
  });
  it.each([
    null,
    { ...payload, source_url: 'https://other.example/spec' },
    { ...payload, collection_id: 'other' },
    { ...payload, items: {} },
    { ...payload, items: [null] },
    { ...payload, items: [{ method: 123, path: '/weather' }] },
    { ...payload, items: [{ method: 'GET', path: false }] },
  ])('rejects invalid responses without falling back to the full document: %j', async (value) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(value));
    await expect(
      new OpenApiCollections('https://api.inflowpay.ai', fetch).operations(document, 'weather'),
    ).rejects.toMatchObject({ code: 'OPENAPI_COLLECTION_LOOKUP_FAILED' });
  });
  it('reports stale references rather than hiding missing operations', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ ...payload, items: [{ method: 'GET', path: '/removed' }] }));
    await expect(
      new OpenApiCollections('https://api.inflowpay.ai', fetch).operations(document, 'weather'),
    ).rejects.toMatchObject({ code: 'OPENAPI_COLLECTION_STALE' });
  });
  it('distinguishes unavailable Collections from server failures', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ code: 'collection_unavailable' }, { status: 400 }))
      .mockResolvedValueOnce(Response.json(payload, { status: 503 }));
    const collections = new OpenApiCollections('https://api.inflowpay.ai', fetch);
    await expect(collections.operations(document, 'weather')).rejects.toMatchObject({
      code: 'OPENAPI_COLLECTION_UNAVAILABLE',
    });
    await expect(collections.operations(document, 'weather')).rejects.toMatchObject({
      code: 'OPENAPI_COLLECTION_LOOKUP_FAILED',
    });
  });
  it('handles transport failures, invalid JSON and oversized responses', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(new Response('invalid'))
      .mockResolvedValueOnce(new Response('x'.repeat(4 * 1024 * 1024 + 1)));
    const collections = new OpenApiCollections('https://api.inflowpay.ai', fetch);
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(collections.operations(document, 'weather')).rejects.toMatchObject({
        code: 'OPENAPI_COLLECTION_LOOKUP_FAILED',
      });
  });
});
