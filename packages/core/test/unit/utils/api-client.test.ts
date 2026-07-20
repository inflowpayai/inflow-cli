import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on 503 with exponential backoff up to total attempts', async () => {
    const { fetch, calls } = makeFetchRecorder([
      { status: 503 },
      { status: 503 },
      { status: 200, bodyJson: { ok: true } },
    ]);
    const c = makeConfig({ fetch, apiBaseUrl: 'https://api.test' });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    const p = client.get('/v1/x');
    await vi.advanceTimersByTimeAsync(700);
    const res = await p;
    expect(res.status).toBe(200);
    expect(calls.length).toBe(3);
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
    });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    await client.postForm('/v1/auth', { client_id: 'cid', scope: 'a b' });
    expect(calls[0]?.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(calls[0]?.body).toBe('client_id=cid&scope=a+b');
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
  it('redacts Authorization and X-API-KEY headers, plus body fields', async () => {
    const { fetch } = makeFetchRecorder([{ status: 200, bodyJson: {} }]);
    const lines: string[] = [];
    const c = makeConfig({
      fetch,
      apiBaseUrl: 'https://api.test',
      accessToken: 'super-secret',
      verbose: true,
      logger: { debug: (m) => lines.push(m) },
    });
    const client = new InflowApiClient(c, c.apiBaseUrl);
    await client.post('/v1/x', { refresh_token: 'sensitive', other: 'public' });
    const joined = lines.join('\n');
    expect(joined).toContain('Bearer <redacted>');
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
});
