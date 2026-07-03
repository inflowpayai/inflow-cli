import type * as X402BuyerModule from '@inflowpayai/x402-buyer';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Inflow, MemoryStorage } from '../../src/index.js';
import { BASE_URL, balancesHappy, userHappy } from './fixtures/handlers.js';
import { makeServer } from './fixtures/server.js';

vi.mock('@inflowpayai/x402-buyer', async (importOriginal) => {
  const actual = await importOriginal<typeof X402BuyerModule>();
  const calls: Array<Record<string, unknown>> = [];
  return {
    ...actual,
    __calls: calls,
    createInflowClient: vi.fn((options: Record<string, unknown>) => {
      calls.push(options);
      return Promise.resolve({
        getSupported: () => Promise.resolve({ kinds: [] }),
        selectInflowRequirement: () => null,
        getX402Payload: () => Promise.resolve({ status: 'INITIATED' as const }),
        cancelApproval: () => Promise.resolve(),
        prepareInflowPayment: () => Promise.reject(new Error('unused')),
      });
    }),
  };
});

const server = makeServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('Inflow client', () => {
  it('exposes the four data resources plus an x402 handle', () => {
    const client = new Inflow();
    expect(client.auth).toBeDefined();
    expect(client.balances).toBeDefined();
    expect(client.depositAddresses).toBeDefined();
    expect(client.user).toBeDefined();
    expect(client.x402).toBeDefined();
    expect(typeof client.x402.client).toBe('function');
  });

  it('balances resource works end-to-end', async () => {
    server.use(balancesHappy);
    const client = new Inflow({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });
    const list = await client.balances.list();
    expect(list).toHaveLength(2);
  });

  it('user resource passes sanitization (ANSI stripped)', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/users/self`, () =>
        HttpResponse.json({
          userId: 'u-1',
          email: '\x1b[31mevil@example.com\x1b[0m',
          firstName: null,
          lastName: null,
          username: null,
          mobile: null,
          locale: 'EN_US',
          timezone: 'US/Pacific',
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-02T00:00:00Z',
        }),
      ),
    );
    const client = new Inflow({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });
    const user = await client.user.retrieve();
    expect(user.email).toBe('evil@example.com');
  });

  it('user resource — alternate path', async () => {
    server.use(userHappy);
    const client = new Inflow({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });
    const user = await client.user.retrieve();
    expect(user.userId).toBe('u-1');
  });
});

describe('Inflow.hasApiKey()', () => {
  it('returns false when no apiKey is configured', () => {
    expect(new Inflow().hasApiKey()).toBe(false);
    expect(new Inflow({ authStorage: new MemoryStorage() }).hasApiKey()).toBe(false);
    expect(new Inflow({ accessToken: 'tk' }).hasApiKey()).toBe(false);
  });

  it('returns true when apiKey is a non-empty string', () => {
    expect(new Inflow({ apiKey: 'inflow_test_key' }).hasApiKey()).toBe(true);
  });

  it('returns false for an empty apiKey (a length-zero string is not a credential)', () => {
    expect(new Inflow({ apiKey: '' }).hasApiKey()).toBe(false);
  });
});

describe('Inflow.x402 lazy wiring', () => {
  it('client() returns the same Promise on every call (lazy singleton)', async () => {
    const client = new Inflow({
      authStorage: new MemoryStorage({
        access_token: 'a',
        refresh_token: 'r',
        token_type: 'Bearer',
        expires_in: 3600,
        expires_at: Date.now() + 3600 * 1000,
      }),
      environment: 'sandbox',
    });
    const first = client.x402.client();
    const second = client.x402.client();
    expect(first).toBe(second);
    await first;
  });

  it('passes apiKey through to createInflowClient when configured', async () => {
    const { __calls } = (await import('@inflowpayai/x402-buyer')) as unknown as {
      __calls: Array<Record<string, unknown>>;
    };
    const before = __calls.length;
    const client = new Inflow({
      apiKey: 'inflow_test_key',
      apiBaseUrl: 'https://api.example.test',
      environment: 'sandbox',
    });
    await client.x402.client();
    const last = __calls[before];
    expect(last).toMatchObject({
      apiKey: 'inflow_test_key',
      baseUrl: 'https://api.example.test',
      environment: 'sandbox',
    });
  });

  it('passes a getAccessToken callback when no apiKey is configured but authStorage is', async () => {
    const { __calls } = (await import('@inflowpayai/x402-buyer')) as unknown as {
      __calls: Array<Record<string, unknown>>;
    };
    const before = __calls.length;
    const client = new Inflow({
      authStorage: new MemoryStorage({
        access_token: 'a',
        refresh_token: 'r',
        token_type: 'Bearer',
        expires_in: 3600,
        expires_at: Date.now() + 3600 * 1000,
      }),
      environment: 'sandbox',
    });
    await client.x402.client();
    const last = __calls[before];
    expect(last).toHaveProperty('getAccessToken');
    expect(typeof (last as { getAccessToken: () => unknown }).getAccessToken).toBe('function');
  });
});

describe('Inflow auto-wiring of device-token provider', () => {
  it('data resources call refresh + retry when authStorage is set but no explicit credentials are provided', async () => {
    const storage = new MemoryStorage({
      access_token: 'stale',
      refresh_token: 'r0',
      token_type: 'Bearer',
      expires_in: 3600,
      expires_at: Date.now() - 1000,
    });

    server.use(
      http.post(`${BASE_URL}/v1/oauth2/token`, () =>
        HttpResponse.json({
          access_token: 'fresh',
          refresh_token: 'r1',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      ),
      balancesHappy,
    );

    const client = new Inflow({
      apiBaseUrl: BASE_URL,
      authBaseUrl: BASE_URL,
      authStorage: storage,
      cliClientId: 'test',
    });

    const list = await client.balances.list();
    expect(list).toHaveLength(2);
    expect(storage.getAuth()?.access_token).toBe('fresh');
  });
});
