import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), fetch: vi.fn(), close: vi.fn(), destroy: vi.fn(), agent: vi.fn() }));
vi.mock('node:dns', () => ({ lookup: mocks.lookup }));
vi.mock('undici', () => ({
  fetch: mocks.fetch,
  Agent: class {
    constructor(options: unknown) {
      mocks.agent(options);
    }
    close = mocks.close;
    destroy = mocks.destroy;
  },
}));

import { fetchPublicDocument, fetchPublicRequest } from '../../src/openapi/public-fetch.js';

describe('public document transport ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.close.mockResolvedValue(undefined);
    mocks.destroy.mockResolvedValue(undefined);
  });

  it('sends only GET with supplied public headers, then closes after the body', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ public: true }));
    const response = await fetchPublicDocument(new URL('https://public.example/spec'), {
      method: 'POST',
      body: 'secret',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    expect(await response.json()).toEqual({ public: true });
    expect(mocks.fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      redirect: 'manual',
      headers: { accept: 'application/json' },
    });
    expect(mocks.fetch.mock.calls[0]?.[1]).not.toHaveProperty('body');
    expect(mocks.close).toHaveBeenCalled();
  });
  it('sends an explicit operation method, body and headers without following redirects', async () => {
    mocks.fetch.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }),
    );
    await fetchPublicRequest(new URL('https://public.example/search'), {
      method: 'POST',
      body: '{"q":"weather"}',
      headers: { authorization: 'Bearer secret' },
      redirect: 'follow',
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: '{"q":"weather"}',
      headers: { authorization: 'Bearer secret' },
      redirect: 'manual',
      credentials: 'omit',
    });
    mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }));
    await fetchPublicRequest(new URL('https://public.example'), {});
    expect(mocks.fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('closes a bodyless response and destroys rejected requests and cancelled streams', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect((await fetchPublicDocument(new URL('https://public.example'), {})).status).toBe(304);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    mocks.fetch.mockRejectedValueOnce(new Error('network'));
    await expect(fetchPublicDocument(new URL('https://public.example'), {})).rejects.toThrow('network');
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    mocks.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
        }),
      ),
    );
    const response = await fetchPublicDocument(new URL('https://public.example'), {});
    await response.body?.cancel();
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });

  it('propagates stream errors and destroys their dispatcher', async () => {
    mocks.fetch.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('body failure'));
          },
        }),
      ),
    );
    const response = await fetchPublicDocument(new URL('https://public.example'), {});
    await expect(response.text()).rejects.toThrow('body failure');
    expect(mocks.destroy).toHaveBeenCalled();
  });

  it('pins only public DNS answers into the connection callback, for single and multiple address requests', async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }));
    await fetchPublicDocument(new URL('https://public.example'), {});
    const options: unknown = mocks.agent.mock.calls[0]?.[0];
    // Inspect the actual connector supplied to undici, rather than a replacement URL validator.
    const connector = options as {
      connect: { lookup: (host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => void };
    };
    const publicAddresses = [
      { address: '1.1.1.1', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    for (const all of [true, false]) {
      mocks.lookup.mockImplementation(
        (_host: string, _options: unknown, done: (error: Error | null, addresses: typeof publicAddresses) => void) =>
          done(null, publicAddresses),
      );
      const callback = vi.fn();
      connector.connect.lookup('public.example', { all }, callback);
      if (all) expect(callback).toHaveBeenCalledWith(null, publicAddresses);
      else expect(callback).toHaveBeenCalledWith(null, '1.1.1.1', 4);
    }
    for (const addresses of [[], [...publicAddresses, { address: '127.0.0.1', family: 4 }]]) {
      mocks.lookup.mockImplementation(
        (_host: string, _options: unknown, done: (error: Error | null, addresses: typeof publicAddresses) => void) =>
          done(null, addresses),
      );
      const callback = vi.fn();
      connector.connect.lookup('public.example', {}, callback);
      expect(callback).toHaveBeenCalledWith(expect.any(Error), [], 4);
    }
    mocks.lookup.mockImplementation((_host: string, _options: unknown, done: (error: Error) => void) =>
      done(new Error('DNS failure')),
    );
    const callback = vi.fn();
    connector.connect.lookup('public.example', {}, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ message: 'DNS failure' }), [], 4);
  });
});
