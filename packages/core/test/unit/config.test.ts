import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveInflowSdkConfig, requireFetchImplementation } from '../../src/config.js';
import { InflowConfigurationError } from '../../src/errors.js';

describe('resolveInflowSdkConfig', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.INFLOW_BASE_URL;
    delete process.env.INFLOW_AUTH_BASE_URL;
    delete process.env.INFLOW_CLI_CLIENT_ID;
    delete process.env.INFLOW_HTTP_PROXY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('defaults environment to production and apiBaseUrl', () => {
    const c = resolveInflowSdkConfig();
    expect(c.environment).toBe('production');
    expect(c.apiBaseUrl).toBe('https://api.inflowpay.ai');
    expect(c.authBaseUrl).toBe('https://app.inflowpay.ai');
    expect(c.clientName).toBe('InFlow');
  });

  it('resolves sandbox environment to sandbox host', () => {
    const c = resolveInflowSdkConfig({ environment: 'sandbox' });
    expect(c.apiBaseUrl).toBe('https://sandbox.inflowpay.ai');
  });

  it('apiBaseUrl option beats env and environment', () => {
    process.env.INFLOW_BASE_URL = 'https://env-host';
    const c = resolveInflowSdkConfig({ apiBaseUrl: 'https://opt-host' });
    expect(c.apiBaseUrl).toBe('https://opt-host');
  });

  it('INFLOW_BASE_URL env beats environment default', () => {
    process.env.INFLOW_BASE_URL = 'https://env-host';
    const c = resolveInflowSdkConfig();
    expect(c.apiBaseUrl).toBe('https://env-host');
  });

  it('authBaseUrl falls back to apiBaseUrl', () => {
    const c = resolveInflowSdkConfig({ apiBaseUrl: 'https://opt' });
    expect(c.authBaseUrl).toBe('https://opt');
  });

  it('authBaseUrl env overrides default', () => {
    process.env.INFLOW_AUTH_BASE_URL = 'https://auth.test';
    const c = resolveInflowSdkConfig();
    expect(c.authBaseUrl).toBe('https://auth.test');
  });

  it('cliClientId resolves from INFLOW_CLI_CLIENT_ID', () => {
    process.env.INFLOW_CLI_CLIENT_ID = 'env-client';
    const c = resolveInflowSdkConfig();
    expect(c.cliClientId).toBe('env-client');
  });

  it('cliClientId option beats env', () => {
    process.env.INFLOW_CLI_CLIENT_ID = 'env-client';
    const c = resolveInflowSdkConfig({ cliClientId: 'opt-client' });
    expect(c.cliClientId).toBe('opt-client');
  });

  it('cliClientId absent stays undefined', () => {
    const c = resolveInflowSdkConfig();
    expect(c.cliClientId).toBeUndefined();
  });

  it('resolves apiKey-only mode', () => {
    const c = resolveInflowSdkConfig({ apiKey: 'sk-1' });
    expect(c.authMode).toEqual({ type: 'apiKey', apiKey: 'sk-1' });
  });

  it('resolves accessToken-only mode as staticBearer', () => {
    const c = resolveInflowSdkConfig({ accessToken: 'tk-1' });
    expect(c.authMode).toEqual({ type: 'staticBearer', accessToken: 'tk-1' });
  });

  it('resolves getAccessToken-only mode as dynamicBearer', () => {
    const cb = (): Promise<string> => Promise.resolve('dynamic');
    const c = resolveInflowSdkConfig({ getAccessToken: cb });
    expect(c.authMode.type).toBe('dynamicBearer');
  });

  it('resolves anonymous mode when none set', () => {
    const c = resolveInflowSdkConfig();
    expect(c.authMode.type).toBe('anonymous');
  });

  it('throws on apiKey + accessToken', () => {
    expect(() => resolveInflowSdkConfig({ apiKey: 'k', accessToken: 't' })).toThrow(InflowConfigurationError);
  });

  it('throws on apiKey + getAccessToken', () => {
    expect(() =>
      resolveInflowSdkConfig({
        apiKey: 'k',
        getAccessToken: () => Promise.resolve('x'),
      }),
    ).toThrow(InflowConfigurationError);
  });

  it('throws on accessToken + getAccessToken', () => {
    expect(() =>
      resolveInflowSdkConfig({
        accessToken: 't',
        getAccessToken: () => Promise.resolve('x'),
      }),
    ).toThrow(InflowConfigurationError);
  });

  it('throws on all three set', () => {
    expect(() =>
      resolveInflowSdkConfig({
        apiKey: 'k',
        accessToken: 't',
        getAccessToken: () => Promise.resolve('x'),
      }),
    ).toThrow(InflowConfigurationError);
  });

  it('wraps fetch with default-headers wrapper when present', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const stubFetch = ((input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push({ url, headers: new Headers(init?.headers) });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof globalThis.fetch;
    const c = resolveInflowSdkConfig({
      fetch: stubFetch,
      defaultHeaders: { 'X-Custom': '1' },
    });
    await c.fetch('https://x/');
    expect(calls[0]?.headers.get('X-Custom')).toBe('1');
  });

  it('default-headers wrapper does not override caller headers', async () => {
    const calls: Array<{ headers: Headers }> = [];
    const stubFetch = ((_input, init) => {
      calls.push({ headers: new Headers(init?.headers) });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof globalThis.fetch;
    const c = resolveInflowSdkConfig({
      fetch: stubFetch,
      defaultHeaders: { 'X-Custom': '1' },
    });
    await c.fetch('https://x/', { headers: { 'X-Custom': 'caller' } });
    expect(calls[0]?.headers.get('X-Custom')).toBe('caller');
  });

  it('proxy-fetch wrapper surfaces InflowConfigurationError when undici import fails', async () => {
    process.env.INFLOW_HTTP_PROXY = 'http://proxy.test';
    const c = resolveInflowSdkConfig();
    await expect(c.fetch('https://x/')).rejects.toBeInstanceOf(InflowConfigurationError);
  });
});

describe('requireFetchImplementation', () => {
  it('returns the fetch when present', () => {
    const stub = (() => Promise.resolve(new Response())) as typeof globalThis.fetch;
    expect(requireFetchImplementation({ fetch: stub })).toBe(stub);
  });

  it('throws when fetch absent', () => {
    expect(() => requireFetchImplementation({})).toThrow(InflowConfigurationError);
  });
});
