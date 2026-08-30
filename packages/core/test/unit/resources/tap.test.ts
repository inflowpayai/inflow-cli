import { afterEach, describe, expect, it, vi } from 'vitest';
import { Inflow } from '../../../src/index.js';

afterEach(() => vi.restoreAllMocks());

describe('TAP resource', () => {
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
