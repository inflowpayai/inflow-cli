import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolveInflowSdkConfig, type ResolvedInflowSdkConfig } from '../../../src/config.js';
import { InflowTransportError } from '../../../src/errors.js';
import { InflowApiClient } from '../../../src/utils/api-client.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function makeFetchRecorder(responses: Array<{ status: number; body?: string; bodyJson?: unknown }>): {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetch = ((input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body,
    });
    const r = responses[index] ?? responses[responses.length - 1];
    index += 1;
    if (!r) {
      return Promise.resolve(new Response('', { status: 500 }));
    }
    const text = r.bodyJson !== undefined ? JSON.stringify(r.bodyJson) : (r.body ?? '');
    return Promise.resolve(new Response(text, { status: r.status }));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function makeConfig(overrides: Partial<Parameters<typeof resolveInflowSdkConfig>[0]>): ResolvedInflowSdkConfig {
  return resolveInflowSdkConfig(overrides);
}

describe('InflowApiClient — base URL handling', () => {
  it('rejects relative path without leading slash', async () => {
    const { fetch } = makeFetchRecorder([{ status: 200, bodyJson: {} }]);
    const c = makeConfig({ fetch, apiBaseUrl: 'https://api.test' });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    await expect(client.get('balances')).rejects.toBeInstanceOf(InflowTransportError);
  });

  it('strips trailing slashes from baseUrl', async () => {
    const { fetch, calls } = makeFetchRecorder([{ status: 200, bodyJson: {} }]);
    const c = makeConfig({ fetch, apiBaseUrl: 'https://api.test/' });
    const client = new InflowApiClient(c, 'https://api.test///');
    await client.get('/v1/x');
    expect(calls[0]?.url).toBe('https://api.test/v1/x');
  });
});

describe('InflowApiClient — auth modes', () => {
  it('apiKey mode sends X-API-KEY header and no Authorization', async () => {
    const { fetch, calls } = makeFetchRecorder([{ status: 200, bodyJson: {} }]);
    const c = makeConfig({
      fetch,
      apiBaseUrl: 'https://api.test',
      apiKey: 'sk-1',
    });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    await client.get('/v1/x');
    expect(calls[0]?.headers.get('X-API-KEY')).toBe('sk-1');
    expect(calls[0]?.headers.get('Authorization')).toBeNull();
  });

  it('static-Bearer sends Authorization and no X-API-KEY', async () => {
    const { fetch, calls } = makeFetchRecorder([{ status: 200, bodyJson: {} }]);
    const c = makeConfig({
      fetch,
      apiBaseUrl: 'https://api.test',
      accessToken: 'static-token',
    });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    await client.get('/v1/x');
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer static-token');
    expect(calls[0]?.headers.get('X-API-KEY')).toBeNull();
  });

  it('dynamic-Bearer invokes callback per request', async () => {
    const { fetch, calls } = makeFetchRecorder([
      { status: 200, bodyJson: {} },
      { status: 200, bodyJson: {} },
    ]);
    const cb = vi.fn(() => Promise.resolve('dynamic-token'));
    const c = makeConfig({
      fetch,
      apiBaseUrl: 'https://api.test',
      getAccessToken: cb,
    });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    await client.get('/v1/x');
    await client.get('/v1/y');
    expect(cb).toHaveBeenCalledTimes(2);
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer dynamic-token');
  });

  it('anonymous sends neither Authorization nor X-API-KEY', async () => {
    const { fetch, calls } = makeFetchRecorder([{ status: 200, bodyJson: {} }]);
    const c = makeConfig({ fetch, apiBaseUrl: 'https://api.test' });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    await client.get('/v1/x');
    expect(calls[0]?.headers.get('Authorization')).toBeNull();
    expect(calls[0]?.headers.get('X-API-KEY')).toBeNull();
  });

  it('rejects when getAccessToken returns empty string', async () => {
    const { fetch } = makeFetchRecorder([{ status: 200, bodyJson: {} }]);
    const c = makeConfig({
      fetch,
      apiBaseUrl: 'https://api.test',
      getAccessToken: () => Promise.resolve(''),
    });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    await expect(client.get('/v1/x')).rejects.toBeInstanceOf(InflowTransportError);
  });
});

describe('InflowApiClient — retry behavior', () => {
  it('passes an already-cancelled signal to the transport and does not retry', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      expect(init?.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('Request aborted.', 'AbortError'));
    });
    const c = makeConfig({ fetch, apiBaseUrl: 'https://api.test' });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    await expect(client.get('/v1/x', { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels retry backoff without transmitting another authenticated request', async () => {
    const controller = new AbortController();
    const { fetch, calls } = makeFetchRecorder([{ status: 503 }]);
    const c = makeConfig({ fetch, apiBaseUrl: 'https://api.test', apiKey: 'test-key' });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    const result = client.get('/v1/x', { signal: controller.signal }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    controller.abort();
    await expect(result).resolves.toMatchObject({ message: 'Request aborted.' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries on 503 with exponential backoff up to total attempts', async () => {
    const { fetch, calls } = makeFetchRecorder([
      { status: 503 },
      { status: 503 },
      { status: 200, bodyJson: { ok: true } },
    ]);
    const c = makeConfig({ fetch, apiBaseUrl: 'https://api.test' });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    const signal = new AbortController().signal;
    const removeListener = vi.spyOn(signal, 'removeEventListener');
    const p = client.get('/v1/x', { signal });
    await vi.advanceTimersByTimeAsync(700);
    const res = await p;
    expect(res.status).toBe(200);
    expect(calls.length).toBe(3);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    removeListener.mockRestore();
  });

  it('does not retry on 4xx other than 429', async () => {
    const { fetch, calls } = makeFetchRecorder([{ status: 400 }]);
    const c = makeConfig({ fetch, apiBaseUrl: 'https://api.test' });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    const res = await client.get('/v1/x');
    expect(res.status).toBe(400);
    expect(calls.length).toBe(1);
  });

  it('retries on transport error and surfaces last error after budget', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('network down'))) as unknown as typeof globalThis.fetch;
    const c = makeConfig({ fetch, apiBaseUrl: 'https://api.test' });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    const captured = client.get('/v1/x').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);
    const error = await captured;
    expect(error).toBeInstanceOf(InflowTransportError);
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(3);
  });

  it('rejects when retries < 1', async () => {
    const { fetch } = makeFetchRecorder([{ status: 200, bodyJson: {} }]);
    const c = makeConfig({ fetch, apiBaseUrl: 'https://api.test' });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    await expect(client.get('/v1/x', { retries: 0 })).rejects.toBeInstanceOf(InflowTransportError);
  });
});

describe('InflowApiClient — 401 retry-with-forced-refresh', () => {
  it('retries once with forced refresh in dynamic-Bearer mode', async () => {
    const { fetch, calls } = makeFetchRecorder([{ status: 401 }, { status: 200, bodyJson: { ok: true } }]);
    const cb = vi.fn((opts?: { forceRefresh?: boolean }) =>
      Promise.resolve(opts?.forceRefresh ? 'new-token' : 'old-token'),
    );
    const c = makeConfig({
      fetch,
      apiBaseUrl: 'https://api.test',
      getAccessToken: cb,
    });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    const res = await client.get('/v1/x');
    expect(res.status).toBe(200);
    expect(cb).toHaveBeenCalledWith({ forceRefresh: true });
    expect(calls[1]?.headers.get('Authorization')).toBe('Bearer new-token');
  });

  it('surfaces 401 on the second attempt without further retries', async () => {
    const { fetch, calls } = makeFetchRecorder([{ status: 401 }, { status: 401 }]);
    const cb = vi.fn(() => Promise.resolve('token'));
    const c = makeConfig({
      fetch,
      apiBaseUrl: 'https://api.test',
      getAccessToken: cb,
    });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    const res = await client.get('/v1/x');
    expect(res.status).toBe(401);
    expect(calls.length).toBe(2);
  });

  it('does not retry on 401 in apiKey mode', async () => {
    const { fetch, calls } = makeFetchRecorder([{ status: 401 }]);
    const c = makeConfig({
      fetch,
      apiBaseUrl: 'https://api.test',
      apiKey: 'sk-1',
    });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    const res = await client.get('/v1/x');
    expect(res.status).toBe(401);
    expect(calls.length).toBe(1);
  });

  it('does not retry on 401 in static-Bearer mode', async () => {
    const { fetch, calls } = makeFetchRecorder([{ status: 401 }]);
    const c = makeConfig({
      fetch,
      apiBaseUrl: 'https://api.test',
      accessToken: 'tk',
    });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    const res = await client.get('/v1/x');
    expect(res.status).toBe(401);
    expect(calls.length).toBe(1);
  });

  it('does not retry on 401 in anonymous mode', async () => {
    const { fetch, calls } = makeFetchRecorder([{ status: 401 }]);
    const c = makeConfig({ fetch, apiBaseUrl: 'https://api.test' });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    const res = await client.get('/v1/x');
    expect(res.status).toBe(401);
    expect(calls.length).toBe(1);
  });
});

describe('InflowApiClient — request bodies & headers', () => {
  it('preserves a caller-supplied string body and content type', async () => {
    const { fetch, calls } = makeFetchRecorder([{ status: 200, bodyJson: {} }]);
    const config = makeConfig({ fetch, apiBaseUrl: 'https://api.test' });
    const client = new InflowApiClient(config, config.apiBaseUrl);
    await client.post('/v1/x', 'raw=request&value=one', { headers: { 'Content-Type': 'application/custom' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe('raw=request&value=one');
    expect(calls[0]?.headers.get('Content-Type')).toBe('application/custom');
  });
  it('JSON post sets Content-Type and serializes body', async () => {
    const { fetch, calls } = makeFetchRecorder([{ status: 200, bodyJson: {} }]);
    const c = makeConfig({ fetch, apiBaseUrl: 'https://api.test' });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    await client.post('/v1/x', { hello: 'world' });
    expect(calls[0]?.headers.get('Content-Type')).toBe('application/json');
    expect(calls[0]?.body).toBe('{"hello":"world"}');
  });

  it('postForm sets x-www-form-urlencoded and skips auth by default', async () => {
    const { fetch, calls } = makeFetchRecorder([{ status: 200, bodyJson: {} }]);
    const c = makeConfig({
      fetch,
      apiBaseUrl: 'https://api.test',
      accessToken: 'tk',
      defaultHeaders: { 'InFlow-CLI-Version': '1.2.3' },
    });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    await client.postForm('/v1/auth', { client_id: 'cid', scope: 'a b' });
    expect(calls[0]?.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(calls[0]?.body).toBe('client_id=cid&scope=a+b');
    expect(calls[0]?.headers.get('InFlow-CLI-Version')).toBe('1.2.3');
    expect(calls[0]?.headers.get('Authorization')).toBeNull();
  });

  it('sets default Accept and User-Agent headers', async () => {
    const { fetch, calls } = makeFetchRecorder([{ status: 200, bodyJson: {} }]);
    const c = makeConfig({
      fetch,
      apiBaseUrl: 'https://api.test',
      defaultHeaders: { 'InFlow-CLI-Version': '1.2.3' },
    });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    await client.get('/v1/x');
    expect(calls[0]?.headers.get('Accept')).toBe('application/json');
    expect(calls[0]?.headers.get('User-Agent')).toContain('@inflowpayai/inflow-core');
    expect(calls[0]?.headers.get('InFlow-CLI-Version')).toBe('1.2.3');
  });

  it('includes default headers in direct authentication header helpers', async () => {
    const { fetch } = makeFetchRecorder([{ status: 200, bodyJson: {} }]);
    const c = makeConfig({
      fetch,
      apiBaseUrl: 'https://api.test',
      apiKey: 'sk-1',
      defaultHeaders: { 'InFlow-CLI-Version': '1.2.3' },
    });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    await expect(client.authenticationHeaders()).resolves.toEqual({
      'InFlow-CLI-Version': '1.2.3',
      'X-API-KEY': 'sk-1',
    });
  });

  it('returns rawBody alongside parsed data', async () => {
    const { fetch } = makeFetchRecorder([{ status: 200, bodyJson: { x: 1 } }]);
    const c = makeConfig({ fetch, apiBaseUrl: 'https://api.test' });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    const res = await client.get('/v1/x');
    expect(res.data).toEqual({ x: 1 });
    expect(res.rawBody).toBe('{"x":1}');
  });

  it('falls back to raw text when body is not JSON', async () => {
    const { fetch } = makeFetchRecorder([{ status: 502, body: 'gateway timeout html' }]);
    const c = makeConfig({ fetch, apiBaseUrl: 'https://api.test' });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    const res = await client.get('/v1/x', { retries: 1 });
    expect(res.data).toBeNull();
    expect(res.rawBody).toBe('gateway timeout html');
  });
});

describe('InflowApiClient — timeout', () => {
  it.each(['timeout', 'cancel'] as const)(
    'interrupts a stalled response body after headers arrive: %s',
    async (mode) => {
      vi.useRealTimers();
      let headersReceived = false;
      let requests = 0;
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"pending":');
        requests += 1;
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');
      const config = makeConfig({
        apiBaseUrl: `http://127.0.0.1:${address.port}`,
        fetch: async (input, init) => {
          const response = await globalThis.fetch(input, init);
          headersReceived = true;
          return response;
        },
      });
      const client = new InflowApiClient(config, config.apiBaseUrl);
      const controller = new AbortController();
      let settled = false;
      const result = client
        .get('/slow', {
          signal: controller.signal,
          timeoutMs: mode === 'timeout' ? 500 : 5000,
          retries: mode === 'timeout' ? 1 : 3,
        })
        .then(
          (value) => {
            settled = true;
            return value;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
      try {
        await vi.waitFor(() => expect(headersReceived).toBe(true));
        if (mode === 'cancel') controller.abort();
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1000 });
        expect(await result).toBeInstanceOf(InflowTransportError);
        expect(requests).toBe(1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        await result;
      }
    },
  );

  it('aborts the underlying fetch when timeout elapses', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    ) as unknown as typeof globalThis.fetch;
    const c = makeConfig({ fetch, apiBaseUrl: 'https://api.test' });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    const captured = client.get('/v1/x', { timeoutMs: 10, retries: 1 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20);
    const error = await captured;
    expect(error).toBeInstanceOf(InflowTransportError);
    vi.useRealTimers();
  });
});

describe('InflowApiClient — verbose logging', () => {
  it('does not print a non-JSON response body that could contain credentials', async () => {
    const body = 'secret returned in a proxy error';
    const { fetch } = makeFetchRecorder([{ status: 502, body }]);
    const lines: string[] = [];
    const c = makeConfig({
      fetch,
      apiBaseUrl: 'https://api.test',
      verbose: true,
      logger: { debug: (line) => lines.push(line) },
    });
    const response = await new InflowApiClient(c, c.apiBaseUrl).get('/v1/x', { retries: 1 });
    expect(response.rawBody).toBe(body);
    expect(lines.join('\n')).not.toContain(body);
    expect(lines).toContain(`<non-JSON body, ${String(body.length)} bytes>`);
  });

  it.each(['bearer', 'api-key'] as const)('redacts %s credentials and body fields in verbose output', async (mode) => {
    const { fetch } = makeFetchRecorder([{ status: 200, bodyJson: {} }]);
    const lines: string[] = [];
    const c = makeConfig({
      fetch,
      apiBaseUrl: 'https://api.test',
      ...(mode === 'bearer' ? { accessToken: 'super-secret' } : { apiKey: 'super-secret' }),
      verbose: true,
      logger: { debug: (m) => lines.push(m) },
    });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    await client.post('/v1/x', { refresh_token: 'sensitive', other: 'public' });
    const joined = lines.join('\n');
    expect(joined).toContain(mode === 'bearer' ? 'Bearer <redacted>' : 'X-API-KEY');
    expect(joined).not.toContain('super-secret');
    expect(joined).toContain('<redacted>');
    expect(joined).not.toContain('sensitive');
    expect(joined).toContain('public');
  });

  it('postForm verbose redacts device_code / token fields', async () => {
    const { fetch } = makeFetchRecorder([{ status: 200, bodyJson: {} }]);
    const lines: string[] = [];
    const c = makeConfig({
      fetch,
      apiBaseUrl: 'https://api.test',
      verbose: true,
      logger: { debug: (m) => lines.push(m) },
    });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    await client.postForm('/v1/oauth2/device/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'secret-device-code',
      client_id: 'cid',
    });
    const joined = lines.join('\n');
    expect(joined).not.toContain('secret-device-code');
    expect(joined).toContain('<redacted>');
  });

  it('redacts TAP authorization material from verbose responses', async () => {
    const { fetch } = makeFetchRecorder([
      {
        status: 200,
        bodyJson: {
          signature: 'secret-signature',
          credential: 'secret-payment-credential',
          encryptedPayload: 'secret-encrypted-card',
          signatureInput: 'public-signature-input',
          signingRequestId: 'secret-request-id',
          tapEvidenceId: 'secret-evidence-id',
        },
      },
    ]);
    const lines: string[] = [];
    const c = makeConfig({
      fetch,
      apiBaseUrl: 'https://api.test',
      verbose: true,
      logger: { debug: (message) => lines.push(message) },
    });
    const client = new InflowApiClient(c, c.apiBaseUrl);

    await client.get('/v1/tap/signatures');

    const joined = lines.join('\n');
    expect(joined).not.toContain('secret-signature');
    expect(joined).not.toContain('secret-payment-credential');
    expect(joined).not.toContain('secret-encrypted-card');
    expect(joined).not.toContain('secret-request-id');
    expect(joined).not.toContain('secret-evidence-id');
    expect(joined).toContain('public-signature-input');
  });
});
