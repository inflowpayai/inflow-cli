import { afterEach, describe, expect, it, vi } from 'vitest';
import { Inflow, MemoryStorage, createTapFetch } from '../../../src/index.js';

afterEach(() => vi.restoreAllMocks());

describe('TAP resource', () => {
  it('uses unsigned requests for missing device credentials and API keys without calling platform APIs', async () => {
    const storage = new MemoryStorage();
    for (const options of [{}, { authStorage: storage }, { apiKey: 'key', authStorage: storage }]) {
      const platform = vi.fn<typeof globalThis.fetch>();
      const inflow = new Inflow({ ...options, fetch: platform });
      expect(inflow.tap.canSign()).toBe(false);
      const remote = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('public'));
      const request = createTapFetch({
        capabilities: inflow.capabilities,
        tap: inflow.tap,
        operation: 'odp.browse',
        fetch: remote,
      });
      expect(await (await request('https://service.example/.well-known/odp')).text()).toBe('public');
      expect(platform).not.toHaveBeenCalled();
      expect(new Headers(remote.mock.calls[0]?.[1]?.headers).has('Signature')).toBe(false);
    }
  });

  it('rechecks stored login state and does not classify unreadable credentials as absent', () => {
    const storage = new MemoryStorage();
    const inflow = new Inflow({ authStorage: storage });
    expect(inflow.tap.canSign()).toBe(false);
    storage.setAuth({ access_token: 'token', refresh_token: 'refresh', expires_in: 3600, token_type: 'Bearer' });
    expect(inflow.tap.canSign()).toBe(true);
    expect(new Inflow({ apiKey: 'key', authStorage: storage }).tap.canSign()).toBe(false);
    const locked = new Error('locked');
    vi.spyOn(storage, 'getAuth').mockImplementation(() => {
      throw locked;
    });
    expect(() => inflow.tap.canSign()).toThrow(locked);
    expect(new Inflow({ accessToken: 'token' }).tap.canSign()).toBe(true);
    expect(new Inflow({ getAccessToken: () => Promise.resolve('token') }).tap.canSign()).toBe(true);
  });

  it('refreshes expired device tokens for signing and never downgrades rejected authentication', async () => {
    const storage = new MemoryStorage();
    storage.setAuth({
      access_token: 'expired',
      refresh_token: 'refresh',
      expires_in: 0,
      expires_at: 0,
      token_type: 'Bearer',
    });
    const platform = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ access_token: 'fresh', refresh_token: 'refresh2', expires_in: 3600, token_type: 'Bearer' }),
      )
      .mockResolvedValueOnce(
        Response.json({
          created: 1,
          expires: 301,
          keyid: 'key',
          nonce: 'nonce',
          signature: 'signed',
          signatureInput: 'input',
        }),
      );
    const inflow = new Inflow({ authStorage: storage, cliClientId: 'test-client', fetch: platform });
    const remote = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'));
    const request = createTapFetch({
      capabilities: {
        has: () => Promise.resolve(true),
        get: () => Promise.resolve({ features: ['visa_tap'], minimumSupportedVersion: '' }),
      },
      tap: inflow.tap,
      operation: 'odp.browse',
      fetch: remote,
    });
    await request('https://service.example/.well-known/odp');
    expect(platform).toHaveBeenCalledTimes(2);
    expect(new Headers(platform.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe('Bearer fresh');
    expect(new Headers(remote.mock.calls[0]?.[1]?.headers).get('Signature')).toBe('signed');
    platform.mockReset().mockResolvedValue(new Response(null, { status: 401 }));
    await expect(request('https://service.example/.well-known/odp')).rejects.toMatchObject({ name: 'TapSigningError' });
    expect(remote).toHaveBeenCalledTimes(1);
  });
  it('issues and finalizes signatures with the authenticated platform client', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          created: 1,
          expires: 301,
          keyid: 'key',
          nonce: 'nonce',
          signingRequestId: 'prepared',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          created: 1,
          expires: 301,
          keyid: 'key',
          nonce: 'nonce',
          signature: 'sig2=:value:',
          signatureInput: 'sig2=("@method")',
        }),
      );
    const inflow = new Inflow({ accessToken: 'token', apiBaseUrl: 'https://platform.example', fetch });

    await inflow.tap.sign({
      method: 'POST',
      operation: 'aep.mutate',
      prepare: true,
      targetUrl: 'https://seller.example/enroll',
    });
    await inflow.tap.finalize('prepared', 'sha-256=:digest:', 'application/json');

    const [issueUrl, issueInit] = fetch.mock.calls[0] ?? [];
    expect(issueUrl).toBe('https://platform.example/v1/tap/signatures');
    expect(new Headers(issueInit?.headers).get('Authorization')).toBe('Bearer token');
    expect(parseJsonBody(issueInit)).toEqual({
      method: 'POST',
      operation: 'aep.mutate',
      prepare: true,
      targetUrl: 'https://seller.example/enroll',
    });

    const [finalizeUrl, finalizeInit] = fetch.mock.calls[1] ?? [];
    expect(finalizeUrl).toBe('https://platform.example/v1/tap/signatures/prepared/finalize');
    expect(parseJsonBody(finalizeInit)).toEqual({
      contentDigest: 'sha-256=:digest:',
      contentType: 'application/json',
    });
  });

  it('rejects malformed successful responses', async () => {
    const inflow = new Inflow({
      accessToken: 'token',
      apiBaseUrl: 'https://platform.example',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ created: 1 })),
    });

    await expect(
      inflow.tap.sign({ method: 'GET', operation: 'odp.browse', targetUrl: 'https://seller.example/' }),
    ).rejects.toThrow('Failed to issue TAP signature');
  });

  it('preserves TAP problem codes and details', async () => {
    const inflow = new Inflow({
      accessToken: 'token',
      apiBaseUrl: 'https://platform.example',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json(
          {
            code: 'TAP_NOT_ELIGIBLE',
            detail: 'The target Service is not eligible for TAP.',
            status: 403,
            title: 'Forbidden',
            type: 'about:blank',
          },
          { status: 403 },
        ),
      ),
    });

    await expect(
      inflow.tap.sign({ method: 'GET', operation: 'odp.browse', targetUrl: 'https://seller.example/' }),
    ).rejects.toMatchObject({
      code: 'TAP_NOT_ELIGIBLE',
      message: 'The target Service is not eligible for TAP.',
      status: 403,
    });
  });

  it('uses the standard API error for unstructured failures', async () => {
    const inflow = new Inflow({
      accessToken: 'token',
      apiBaseUrl: 'https://platform.example',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 503 })),
    });

    await expect(
      inflow.tap.sign({ method: 'GET', operation: 'odp.browse', targetUrl: 'https://seller.example/' }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('preserves a TAP problem code when no detail is provided', async () => {
    const inflow = new Inflow({
      accessToken: 'token',
      apiBaseUrl: 'https://platform.example',
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json({ code: 'TAP_SIGNING_UNAVAILABLE' }, { status: 403 })),
    });

    await expect(
      inflow.tap.sign({ method: 'GET', operation: 'odp.browse', targetUrl: 'https://seller.example/' }),
    ).rejects.toMatchObject({ code: 'TAP_SIGNING_UNAVAILABLE', status: 403 });
  });
});

function parseJsonBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new TypeError('Expected a string request body.');
  return JSON.parse(init.body) as unknown;
}
