import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTapFetch,
  createTapRequestTransport,
  InflowApiError,
  InflowTransportError,
  type ICliCapabilitiesResource,
  type ITapResource,
  type TapSignatureResponse,
} from '../../src/index.js';

interface TapVector {
  readonly id: string;
  readonly request: {
    readonly authority: string;
    readonly bodyBase64?: string;
    readonly contentDigest?: string;
    readonly contentType?: string;
    readonly method: string;
    readonly path: string;
    readonly query: string;
  };
}

interface TapVectors {
  readonly positive: readonly TapVector[];
}

// JSON.parse is the boundary for the checked-in, independently verified conformance artifact.
const tapVectors = JSON.parse(
  await readFile(new URL('../fixtures/tap/request-signing-vectors.json', import.meta.url), 'utf8'),
) as TapVectors;

function capabilities(enabled: boolean): ICliCapabilitiesResource {
  return {
    get: vi.fn(() => Promise.resolve({ features: enabled ? ['visa_tap'] : [], minimumSupportedVersion: '0.12.1' })),
    has: vi.fn(() => Promise.resolve(enabled)),
  };
}

function signature(overrides: Partial<TapSignatureResponse> = {}): TapSignatureResponse {
  return {
    created: 1,
    expires: 301,
    keyid: 'key',
    nonce: 'nonce',
    signature: 'sig2=:value:',
    signatureInput: 'sig2=("@method")',
    ...overrides,
  };
}

function tap(): {
  finalize: ReturnType<typeof vi.fn<ITapResource['finalize']>>;
  resource: ITapResource;
  sign: ReturnType<typeof vi.fn<ITapResource['sign']>>;
} {
  const finalize = vi.fn<ITapResource['finalize']>(() => Promise.resolve(signature({ tapEvidenceId: 'evidence' })));
  const sign = vi.fn<ITapResource['sign']>(() => Promise.resolve(signature({ signingRequestId: 'prepared' })));
  return { finalize, resource: { finalize, sign }, sign };
}

afterEach(() => vi.restoreAllMocks());

describe('TAP request transport', () => {
  it('signs one exact fetch attempt and leaves redirects to the composing protocol', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { headers: { Location: '/next' }, status: 307 }));
    const signer = tap();
    const tapFetch = createTapFetch({
      capabilities: capabilities(true),
      fetch,
      operation: 'odp.browse',
      tap: signer.resource,
    });

    const response = await tapFetch('https://seller.example/catalog', { redirect: 'follow' });

    expect(response.status).toBe(307);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('manual');
    const signOptions = signer.sign.mock.calls[0]?.[1];
    expect(signOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(signer.sign).toHaveBeenCalledWith(
      { method: 'GET', operation: 'odp.browse', targetUrl: 'https://seller.example/catalog' },
      signOptions,
    );
  });

  it('signs the exact request body bytes used by the fetch adapter', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'));
    const signer = tap();
    const tapFetch = createTapFetch({
      capabilities: capabilities(true),
      fetch,
      operation: 'odp.browse',
      tap: signer.resource,
    });

    await tapFetch('https://seller.example/search', {
      body: '{"query":"gpu"}',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const finalizeOptions = signer.finalize.mock.calls[0]?.[3];
    expect(finalizeOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(signer.finalize).toHaveBeenCalledWith(
      'prepared',
      'sha-256=:zJekw5mRfQeNa28kvGZRAAFKvNpGWquB3QrjTJR1mSo=:',
      'application/json',
      finalizeOptions,
    );
    expect(Buffer.from(fetch.mock.calls[0]?.[1]?.body as Uint8Array).toString()).toBe('{"query":"gpu"}');
  });

  it('sends unsigned requests when the server capability is disabled', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'));
    const signer = tap();
    const transport = createTapRequestTransport({ capabilities: capabilities(false), fetch, tap: signer.resource });

    await transport.request({ method: 'GET', operation: 'odp.browse', url: 'https://seller.example/catalog' });

    expect(signer.sign).not.toHaveBeenCalled();
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.has('Signature')).toBe(false);
  });

  it('prepares and finalizes the shared payment-json-body vector before transmitting it', async () => {
    const vector = tapVectors.positive.find(({ id }) => id === 'payment-json-body');
    if (vector?.request.bodyBase64 === undefined) throw new Error('The payment TAP vector is missing its body.');
    if (vector.request.contentDigest === undefined || vector.request.contentType === undefined) {
      throw new Error('The payment TAP vector is missing its body fields.');
    }
    const body = Buffer.from(vector.request.bodyBase64, 'base64').toString();
    const url = `https://${vector.request.authority}${vector.request.path}${vector.request.query}`;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'));
    const signer = tap();
    const transport = createTapRequestTransport({ capabilities: capabilities(true), fetch, tap: signer.resource });

    const result = await transport.request({
      body,
      headers: { 'Content-Type': vector.request.contentType },
      method: vector.request.method,
      operation: 'mpp.payment',
      transactionId: 'transaction',
      url,
    });

    expect(signer.sign).toHaveBeenCalledWith(
      {
        method: vector.request.method,
        operation: 'mpp.payment',
        prepare: true,
        targetUrl: url,
        transactionId: 'transaction',
      },
      {},
    );
    expect(signer.finalize).toHaveBeenCalledWith(
      'prepared',
      vector.request.contentDigest,
      vector.request.contentType,
      {},
    );
    const [, init] = fetch.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(init?.body).toBe(body);
    expect(init?.redirect).toBe('manual');
    expect(headers.get('Content-Digest')).toBe(vector.request.contentDigest);
    expect(headers.get('Signature')).toBe('sig2=:value:');
    expect(result.tapEvidenceId).toBe('evidence');
  });

  it('creates a fresh signature for an allowed redirect target', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { headers: { Location: '/final' }, status: 307 }))
      .mockResolvedValueOnce(new Response('ok'));
    const signer = tap();
    const transport = createTapRequestTransport({ capabilities: capabilities(true), fetch, tap: signer.resource });

    await transport.request({
      headers: {
        'AEP-Authorization': 'Bearer aep',
        Authorization: 'Payment credential',
        Cookie: 'session=secret',
        'PAYMENT-SIGNATURE': 'payment',
      },
      method: 'GET',
      operation: 'mpp.inspect',
      url: 'https://seller.example/start',
    });

    expect(signer.sign).toHaveBeenNthCalledWith(
      1,
      { method: 'GET', operation: 'mpp.inspect', targetUrl: 'https://seller.example/start' },
      {},
    );
    expect(signer.sign).toHaveBeenNthCalledWith(
      2,
      { method: 'GET', operation: 'mpp.inspect', targetUrl: 'https://seller.example/final' },
      {},
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    const redirectedHeaders = new Headers(fetch.mock.calls[1]?.[1]?.headers);
    expect(redirectedHeaders.has('AEP-Authorization')).toBe(false);
    expect(redirectedHeaders.has('Authorization')).toBe(false);
    expect(redirectedHeaders.has('Cookie')).toBe(false);
    expect(redirectedHeaders.has('PAYMENT-SIGNATURE')).toBe(false);
  });

  it('returns a signed redirect attempt for the composing protocol to handle', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { headers: { Location: 'https://other.example/final' }, status: 307 }));
    const signer = tap();
    signer.sign.mockResolvedValue(signature({ tapEvidenceId: 'evidence' }));
    const transport = createTapRequestTransport({
      capabilities: capabilities(true),
      fetch,
      followRedirects: false,
      tap: signer.resource,
    });

    const result = await transport.request({
      method: 'GET',
      operation: 'mpp.inspect',
      url: 'https://seller.example/start',
    });

    expect(result.response.status).toBe(307);
    expect(result.tapEvidenceId).toBe('evidence');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signer.sign).toHaveBeenCalledTimes(1);
  });

  it('applies HTTP redirect method semantics before obtaining the next signature', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { headers: { Location: '/final' }, status: 303 }))
      .mockResolvedValueOnce(new Response('ok'));
    const signer = tap();
    const transport = createTapRequestTransport({ capabilities: capabilities(true), fetch, tap: signer.resource });

    await transport.request({
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      operation: 'aep.mutate',
      url: 'https://seller.example/start',
    });

    expect(signer.sign).toHaveBeenNthCalledWith(
      2,
      { method: 'GET', operation: 'aep.mutate', targetUrl: 'https://seller.example/final' },
      {},
    );
    expect(fetch.mock.calls[1]?.[1]?.body).toBeUndefined();
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).has('Content-Digest')).toBe(false);
  });

  it('strips credentials when the underlying policy permits a cross-origin redirect', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { headers: { Location: 'https://other.example/final' }, status: 307 }))
      .mockResolvedValueOnce(new Response('ok'));
    const transport = createTapRequestTransport({
      capabilities: capabilities(false),
      fetch,
      tap: tap().resource,
    });

    await transport.request({
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer secret',
        Cookie: 'session=secret',
        'PAYMENT-SIGNATURE': 'payment',
      },
      method: 'GET',
      operation: 'x402.payment',
      url: 'https://seller.example/start',
    });

    const headers = new Headers(fetch.mock.calls[1]?.[1]?.headers);
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.has('Authorization')).toBe(false);
    expect(headers.has('Cookie')).toBe(false);
    expect(headers.has('PAYMENT-SIGNATURE')).toBe(false);
  });

  it('honors an underlying redirect rejection and rejects caller-supplied signatures', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { headers: { Location: 'https://other.example/final' }, status: 302 }));
    const transport = createTapRequestTransport({
      capabilities: capabilities(true),
      fetch,
      redirectAllowed: () => false,
      tap: tap().resource,
    });

    await expect(
      transport.request({ method: 'GET', operation: 'x402.inspect', url: 'https://seller.example/start' }),
    ).rejects.toBeInstanceOf(InflowTransportError);
    await expect(
      transport.request({
        headers: { Signature: 'caller' },
        method: 'GET',
        operation: 'x402.inspect',
        url: 'https://seller.example/start',
      }),
    ).rejects.toThrow('TAP signature headers are managed by InFlow.');
  });

  it('continues unsigned only when the server reports an ineligible Service', async () => {
    const signer = tap();
    signer.sign.mockRejectedValue(new InflowApiError('not eligible', { code: 'TAP_NOT_ELIGIBLE', status: 403 }));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'));
    const transport = createTapRequestTransport({ capabilities: capabilities(true), fetch, tap: signer.resource });

    await transport.request({ method: 'GET', operation: 'odp.browse', url: 'https://seller.example/' });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('Signature')).toBe(false);

    signer.sign.mockRejectedValue(new InflowApiError('unavailable', { code: 'TAP_SIGNING_UNAVAILABLE', status: 503 }));
    await expect(
      transport.request({ method: 'GET', operation: 'odp.browse', url: 'https://seller.example/' }),
    ).rejects.toMatchObject({ code: 'TAP_SIGNING_UNAVAILABLE' });
  });

  it('rejects requests whose body metadata or wire method cannot be signed exactly', async () => {
    const transport = createTapRequestTransport({
      capabilities: capabilities(true),
      fetch: vi.fn<typeof globalThis.fetch>(),
      tap: tap().resource,
    });

    await expect(
      transport.request({ body: '{}', method: 'POST', operation: 'odp.browse', url: 'https://seller.example/' }),
    ).rejects.toThrow('requires Content-Type');
    await expect(
      transport.request({
        headers: { 'Content-Digest': 'sha-256=:value:' },
        method: 'GET',
        operation: 'odp.browse',
        url: 'https://seller.example/',
      }),
    ).rejects.toThrow('without a body cannot supply Content-Digest');
    await expect(
      transport.request({ method: 'get', operation: 'odp.browse', url: 'https://seller.example/' }),
    ).rejects.toThrow('exact uppercase wire representation');
  });

  it('rejects unsafe request URLs and invalid redirect configuration', async () => {
    const signer = tap();
    const options = { capabilities: capabilities(true), fetch: vi.fn<typeof globalThis.fetch>(), tap: signer.resource };

    expect(() => createTapRequestTransport({ ...options, maxRedirects: -1 })).toThrow('TAP maxRedirects must be >= 0.');
    await expect(
      createTapRequestTransport(options).request({
        method: 'GET',
        operation: 'odp.browse',
        url: 'https://user:secret@seller.example/catalog',
      }),
    ).rejects.toThrow('TAP request URL cannot contain credentials or a fragment.');
    await expect(
      createTapRequestTransport(options).request({
        method: 'GET',
        operation: 'odp.browse',
        url: 'https://seller.example/catalog#section',
      }),
    ).rejects.toThrow('TAP request URL cannot contain credentials or a fragment.');
  });

  it('returns redirect responses without a location and enforces the redirect limit', async () => {
    const signer = tap();
    const missingLocationFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 307 }));
    const missingLocation = createTapRequestTransport({
      capabilities: capabilities(true),
      fetch: missingLocationFetch,
      tap: signer.resource,
    });

    const result = await missingLocation.request({
      method: 'GET',
      operation: 'odp.browse',
      url: 'https://seller.example/catalog',
    });
    expect(result.response.status).toBe(307);

    const redirectedFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { headers: { Location: '/next' }, status: 307 }));
    const limited = createTapRequestTransport({
      capabilities: capabilities(true),
      fetch: redirectedFetch,
      maxRedirects: 0,
      tap: signer.resource,
    });
    await expect(
      limited.request({ method: 'GET', operation: 'odp.browse', url: 'https://seller.example/catalog' }),
    ).rejects.toThrow('TAP request exceeded its redirect limit.');
  });

  it('detects redirect loops after signing each distinct target once', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { headers: { Location: '/second' }, status: 307 }))
      .mockResolvedValueOnce(new Response(null, { headers: { Location: '/first' }, status: 307 }));
    const transport = createTapRequestTransport({ capabilities: capabilities(true), fetch, tap: tap().resource });

    await expect(
      transport.request({ method: 'GET', operation: 'odp.browse', url: 'https://seller.example/first' }),
    ).rejects.toThrow('TAP request redirect loop detected.');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects mismatched body digests and incomplete signing responses', async () => {
    const signer = tap();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'));
    const request = {
      body: '{}',
      headers: { 'Content-Digest': 'sha-256=:incorrect:', 'Content-Type': 'application/json' },
      method: 'POST',
      operation: 'aep.mutate' as const,
      url: 'https://seller.example/enroll',
    };

    await expect(
      createTapRequestTransport({ capabilities: capabilities(true), fetch, tap: signer.resource }).request(request),
    ).rejects.toThrow('The supplied Content-Digest does not match the TAP request body.');

    signer.sign.mockResolvedValue(signature());
    await expect(
      createTapRequestTransport({ capabilities: capabilities(true), fetch, tap: signer.resource }).request({
        ...request,
        headers: { 'Content-Type': 'application/json' },
      }),
    ).rejects.toThrow('The TAP signing response is missing signingRequestId.');

    const { signature: _signature, ...missingSignature } = signature();
    signer.sign.mockResolvedValue(missingSignature);
    await expect(
      createTapRequestTransport({ capabilities: capabilities(true), fetch, tap: signer.resource }).request({
        method: 'GET',
        operation: 'odp.browse',
        url: 'https://seller.example/catalog',
      }),
    ).rejects.toThrow('The TAP signing response is missing signature fields.');
  });
});
