import type * as X402BuyerModule from '@inflowpayai/x402-buyer';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Inflow, MemoryStorage } from '../../src/index.js';
import { BASE_URL, balancesHappy, userHappy } from './fixtures/handlers.js';
import { makeServer } from './fixtures/server.js';

function makeFetchRecorder(): {
  fetch: typeof globalThis.fetch;
  calls: Request[];
} {
  const calls: Request[] = [];
  return {
    calls,
    fetch: (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return Promise.resolve(HttpResponse.json({ kinds: [] }));
    },
  };
}

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
        setSpendControls: vi.fn(),
        selectInflowRequirement: () => null,
        getX402Payload: () => Promise.resolve({ status: 'INITIATED' as const }),
        cancelApproval: () => Promise.resolve(),
        prepareInflowPayment: () => Promise.reject(new Error('unused')),
      });
    }),
  };
});

const server = makeServer();

it('reads public Service documents through the sanitizing AEP resource without authentication', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('No platform request expected'));
  const client = new Inflow({ accessToken: 'must-not-be-sent', fetch });
  const result = await client.aep.document({
    document: {
      id: 'terms',
      title: '\x1b[2JTerms',
      type: 'terms_of_service',
      enrollment: 'required',
      representations: [{ media_type: 'text/html', url: 'https://service.example/terms' }],
    },
  });
  expect(result.status).toBe('web');
  expect(result.descriptor.title).toBe('Terms');
  expect(result.webUrl).toBe('https://service.example/terms');
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  'deposit-addresses',
  'subscription-list',
  'subscription-get',
  'subscription-authorize',
  'tap-finalize',
] as const)('propagates cancellation to the HTTP request without retrying %s', async (operation) => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    observedSignal = new Request(input, init).signal;
    return new Promise((_resolve, reject) => {
      observedSignal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), {
        once: true,
      });
    });
  });
  const client = new Inflow({ accessToken: 'token', fetch });
  const options = { signal: controller.signal };
  const request =
    operation === 'deposit-addresses'
      ? client.depositAddresses.list(options)
      : operation === 'subscription-list'
        ? client.subscriptions.list(options)
        : operation === 'subscription-get'
          ? client.subscriptions.get('one', options)
          : operation === 'subscription-authorize'
            ? client.subscriptions.authorize(
                'one',
                {
                  id: 'challenge',
                  realm: 'seller',
                  method: 'inflow',
                  intent: 'subscription',
                  request: 'e30',
                },
                options,
              )
            : client.tap.finalize('one', 'sha-256=:digest:', 'application/json', options);
  const rejected = expect(request).rejects.toMatchObject({ name: 'InflowTransportError' });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  controller.abort();
  await rejected;
  expect(observedSignal?.aborted).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
});

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('Inflow client', () => {
  it('inspects a public AEP Service through the actual agent SDK without platform credentials', async () => {
    const requests: Request[] = [];
    server.use(
      http.get('https://service.test/.well-known/aep', ({ request }) => {
        requests.push(request);
        return HttpResponse.json(
          {
            aep_version: '1.0',
            bindings: { supported: ['http'] },
            commands: { supported: ['inspect', 'status'] },
            core: { signing_algorithms: ['EdDSA', 'ES256'] },
            http: { endpoint_base: '/aep' },
            identity: { methods: ['did:web'] },
            service: { did: 'did:web:service.test' },
          },
          { headers: { 'content-type': 'application/aep+json' } },
        );
      }),
    );
    const client = new Inflow({ apiKey: 'platform-secret' });
    const result = await client.aep.inspect({ serviceUrl: 'https://service.test' });
    expect(result.document.service.did).toBe('did:web:service.test');
    expect(result.commandUrl('status').href).toBe('https://service.test/aep/status');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.has('Authorization')).toBe(false);
    expect(requests[0]?.headers.has('X-API-KEY')).toBe(false);
  });
  it('cancels MPP approvals through the buyer SDK with the configured authentication', async () => {
    const requests: Request[] = [];
    server.use(
      http.post(`${BASE_URL}/v1/approvals/:id/cancel`, ({ request }) => {
        requests.push(request);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = new Inflow({ apiBaseUrl: BASE_URL, apiKey: 'test-only-api-key' });
    await client.mpp.cancelApproval('approval-one');
    await client.mpp.cancelApproval('approval-two');
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/v1/approvals/approval-one/cancel',
      '/v1/approvals/approval-two/cancel',
    ]);
    expect(requests.map((request) => request.headers.get('X-API-KEY'))).toEqual([
      'test-only-api-key',
      'test-only-api-key',
    ]);
  });

  it('exposes the four data resources plus an x402 handle', () => {
    const client = new Inflow();
    expect(client.auth).toBeDefined();
    expect(client.balances).toBeDefined();
    expect(client.depositAddresses).toBeDefined();
    expect(client.user).toBeDefined();
    expect(client.x402).toBeDefined();
    expect(client.odp).toBeDefined();
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

  it('passes the default-header fetch wrapper through to the x402 client', async () => {
    const { __calls } = (await import('@inflowpayai/x402-buyer')) as unknown as {
      __calls: Array<Record<string, unknown>>;
    };
    const { fetch, calls } = makeFetchRecorder();
    const before = __calls.length;
    const client = new Inflow({
      apiKey: 'inflow_test_key',
      apiBaseUrl: 'https://api.example.test',
      defaultHeaders: { 'InFlow-CLI-Version': '1.2.3' },
      fetch,
    });
    await client.x402.client();
    const last = __calls[before];
    const wrappedFetch = last?.['fetch'];
    expect(typeof wrappedFetch).toBe('function');
    await (wrappedFetch as typeof globalThis.fetch)('https://api.example.test/v1/probe');
    expect(calls[0]?.headers.get('InFlow-CLI-Version')).toBe('1.2.3');
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

describe('Inflow.mpp lazy wiring', () => {
  it('passes the default-header fetch wrapper through to the MPP client', async () => {
    const { fetch, calls } = makeFetchRecorder();
    const client = new Inflow({
      apiKey: 'inflow_test_key',
      apiBaseUrl: 'https://api.example.test',
      defaultHeaders: { 'InFlow-CLI-Version': '1.2.3' },
      fetch,
    });
    const mpp = await client.mpp.client();
    await mpp.getSupported();
    expect(calls[0]?.headers.get('InFlow-CLI-Version')).toBe('1.2.3');
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
