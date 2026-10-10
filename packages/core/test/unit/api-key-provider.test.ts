import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Inflow, InflowAuthenticationError, MemoryStorage } from '../../src/index.js';
import { resolveInflowSdkConfig } from '../../src/config.js';
import { InflowApiClient } from '../../src/utils/api-client.js';

const requests: Array<{ path: string; key: string | undefined; bearer: string | undefined }> = [];
let baseUrl = '';
let retry = false;
const server = createServer((req, res) => {
  requests.push({ path: req.url ?? '', key: req.headers['x-api-key']?.toString(), bearer: req.headers.authorization });
  res.setHeader('Content-Type', 'application/json');
  if (retry) {
    retry = false;
    res.writeHead(503);
  }
  res.end(
    JSON.stringify(req.url?.endsWith('supported') ? { kinds: [] } : { transactionId: 'test', status: 'SETTLED' }),
  );
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing test listener');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('API-key providers through retained clients', () => {
  it('reads current credentials for shared, MPP, and x402 requests without retaining a successful read', async () => {
    const storage = new MemoryStorage();
    storage.setApiKey('first');
    let failure: Error | undefined;
    const provider = vi.fn(() => {
      if (failure !== undefined) throw failure;
      const key = storage.getApiKey();
      if (key === null) throw new InflowAuthenticationError('No saved key');
      return Promise.resolve(key);
    });
    const client = new Inflow({ apiKey: provider, apiBaseUrl: baseUrl });
    expect(client.hasApiKey()).toBe(true);
    expect(provider).not.toHaveBeenCalled();
    const mpp = await client.mpp.client();
    const x402 = await client.x402.client();
    const shared = new InflowApiClient(resolveInflowSdkConfig({ apiKey: provider }), baseUrl);
    const operations = [
      () => shared.get('/v1/transactions/test'),
      () => mpp.getPaymentStatus('test'),
      () => x402.getPaymentStatus('test'),
    ];
    for (const operation of operations) {
      storage.setApiKey('first');
      await operation();
      expect(requests.at(-1)).toMatchObject({ key: 'first', bearer: undefined });
      storage.setApiKey('replacement');
      await operation();
      expect(requests.at(-1)).toMatchObject({ key: 'replacement', bearer: undefined });
      const before = requests.length;
      failure = new Error('Credential store locked');
      await expect(operation()).rejects.toThrow(failure);
      expect(requests).toHaveLength(before);
      failure = undefined;
      storage.clearApiKey();
      await expect(operation()).rejects.toThrow('No saved key');
      expect(requests).toHaveLength(before);
    }
    storage.setApiKey('platform');
    expect(await client.platformAuthenticationHeaders()).toMatchObject({ 'X-API-KEY': 'platform' });
  });

  it('resolves again for a retry and keeps concurrent request credentials separate', async () => {
    let sequence = 0;
    const provider = vi.fn(() => Promise.resolve(`key-${++sequence}`));
    const client = new InflowApiClient(resolveInflowSdkConfig({ apiKey: provider }), baseUrl);
    const before = requests.length;
    retry = true;
    await client.get('/v1/transactions/test', { retries: 2 });
    expect(requests.slice(before).map((request) => request.key)).toEqual(['key-1', 'key-2']);
    await Promise.all([client.get('/v1/transactions/test'), client.get('/v1/transactions/test')]);
    expect(
      requests
        .slice(before)
        .map((request) => request.key)
        .sort(),
    ).toEqual(['key-1', 'key-2', 'key-3', 'key-4']);
    await client.get('/public', { skipAuth: true });
    expect(requests.at(-1)?.key).toBeUndefined();
    expect(provider).toHaveBeenCalledTimes(4);
  });

  it.each(['', 123])('rejects an invalid provider value (%s) before sending', async (value) => {
    // A JavaScript caller can violate the declared provider result type.
    const provider = () => Promise.resolve(value as string);
    const client = new InflowApiClient(resolveInflowSdkConfig({ apiKey: provider }), baseUrl);
    const before = requests.length;
    await expect(client.get('/private')).rejects.toThrow('apiKey resolved to a non-string or empty value');
    expect(requests).toHaveLength(before);
  });

  it('keeps API-key and bearer modes mutually exclusive', () => {
    expect(() => new Inflow({ apiKey: () => Promise.resolve('key'), accessToken: 'token' })).toThrow();
  });
});
