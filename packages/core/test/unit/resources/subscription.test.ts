import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { InflowApiError } from '../../../src/errors.js';
import { SubscriptionResource } from '../../../src/resources/subscription.js';
import { BASE_URL } from '../fixtures/handlers.js';
import { makeServer } from '../fixtures/server.js';

const server = makeServer();

const subscription = {
  amount: '10.000000000000000000',
  billingAnchor: '2026-08-01T00:00:00Z',
  buyerId: '00000000-0000-0000-0000-000000000001',
  created: '2026-08-01T00:00:00Z',
  currency: 'USD',
  externalId: 'seller-plan',
  lastChargedPeriod: 0,
  period0Amount: '5.500000000000000000',
  periodCount: 1,
  periodUnit: 'month',
  sellerId: '00000000-0000-0000-0000-000000000002',
  sellerName: 'Example Seller',
  sellerWebsite: 'https://shop.example.test/path',
  status: 'ACTIVE',
  subscriptionExpires: '2027-08-01T00:00:00Z',
  subscriptionId: '00000000-0000-0000-0000-000000000003',
  transactionType: 'MPP',
  updated: '2026-08-01T00:00:00Z',
} as const;

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function resource() {
  return new SubscriptionResource({ apiBaseUrl: BASE_URL, accessToken: 'token' });
}

describe('SubscriptionResource', () => {
  it('authorizes a seller challenge and returns the fresh credential', async () => {
    const challenge = {
      id: 'challenge',
      realm: 'seller',
      method: 'inflow',
      intent: 'subscription',
      request: 'e30',
    } as const;
    server.use(
      http.post(`${BASE_URL}/v1/subscriptions/id%2Fvalue/authorize`, async ({ request }) => {
        expect(await request.json()).toEqual({ challenge });
        return HttpResponse.json({ credential: 'fresh', expires: '2026-08-12T18:00:00Z' });
      }),
    );
    await expect(resource().authorize('id/value', challenge)).resolves.toEqual({
      credential: 'fresh',
      expires: '2026-08-12T18:00:00Z',
    });
  });

  it('surfaces a subscription authorization problem', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/subscriptions/id/authorize`, () =>
        HttpResponse.json({
          problem: { type: 't', title: 'Inactive', status: 402, detail: 'Subscription is inactive.' },
        }),
      ),
    );
    await expect(resource().authorize('id', { id: 'c' } as never)).rejects.toThrow('Subscription is inactive.');
  });

  it('maps a failed subscription authorization response to InflowApiError', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/subscriptions/id/authorize`, () =>
        HttpResponse.json({ detail: 'authorization failed' }, { status: 400 }),
      ),
    );
    await expect(resource().authorize('id', { id: 'c' } as never)).rejects.toBeInstanceOf(InflowApiError);
  });

  it('rejects a subscription authorization response without both required fields', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/subscriptions/id/authorize`, () => HttpResponse.json({ credential: 'fresh' })),
    );
    await expect(resource().authorize('id', { id: 'c' } as never)).rejects.toThrow(
      'Subscription authorization response is missing its credential or expiry.',
    );
  });

  it('lists subscriptions with paging filters and normalized decimal strings', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/subscriptions`, ({ request }) => {
        const url = new URL(request.url);
        expect(Object.fromEntries(url.searchParams)).toEqual({
          descending: 'false',
          endDate: '2026-08-31T00:00:00Z',
          limit: '25',
          offset: '5',
          startDate: '2026-08-01T00:00:00Z',
          status: 'active',
        });
        return HttpResponse.json({ count: 1, data: [subscription], total: 1 });
      }),
    );
    const response = await resource().list({
      descending: false,
      endDate: '2026-08-31T00:00:00Z',
      limit: 25,
      offset: 5,
      startDate: '2026-08-01T00:00:00Z',
      status: 'active',
    });
    expect(response.data[0]).toMatchObject({ amount: '10', period0Amount: '5.5' });
  });

  it('gets one subscription and URL-encodes its identifier', async () => {
    server.use(http.get(`${BASE_URL}/v1/subscriptions/id%2Fvalue`, () => HttpResponse.json(subscription)));
    await expect(resource().get('id/value')).resolves.toMatchObject({ amount: '10', period0Amount: '5.5' });
  });

  it('cancels a subscription and passes an abort signal', async () => {
    let signalSeen = false;
    server.use(
      http.delete(`${BASE_URL}/v1/subscriptions/id/delete`, ({ request }) => {
        signalSeen = request.signal instanceof AbortSignal;
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const controller = new AbortController();
    await expect(resource().cancel('id', { signal: controller.signal })).resolves.toBeUndefined();
    expect(signalSeen).toBe(true);
  });

  it.each(['list', 'get', 'cancel'] as const)('maps a failed %s response to InflowApiError', async (operation) => {
    server.use(
      http.all(`${BASE_URL}/v1/subscriptions/*`, () => HttpResponse.json({ detail: 'failure' }, { status: 400 })),
      http.get(`${BASE_URL}/v1/subscriptions`, () => HttpResponse.json({ detail: 'failure' }, { status: 400 })),
    );
    const subject = resource();
    const result =
      operation === 'list' ? subject.list() : operation === 'get' ? subject.get('id') : subject.cancel('id');
    await expect(result).rejects.toBeInstanceOf(InflowApiError);
  });
});
