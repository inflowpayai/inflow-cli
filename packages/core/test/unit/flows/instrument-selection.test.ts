import { encode, renderChallengeHeader } from '@inflowpayai/mpp';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Inflow } from '../../../src/client.js';
import type { MppPayEvent, PayEvent } from '../../../src/flows/index.js';

const API = 'https://instrument-api.test';
const SELLER = 'https://instrument-seller.test/report';
const CARD = '11111111-1111-4111-8111-111111111111';
const OTHER_CARD = '22222222-2222-4222-8222-222222222222';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function client() {
  return new Inflow({ apiKey: 'test-key', apiBaseUrl: API, environment: 'sandbox' });
}

function x402Offers(schemes: string[], fail = false) {
  const requests: unknown[] = [];
  const accepts: PaymentRequirements[] = schemes.map((scheme) => ({
    scheme,
    network: scheme === 'exact' ? 'eip155:8453' : 'inflow:1',
    asset: scheme === 'instrument' ? 'USD' : 'USDC',
    amount: '1000000000000000000',
    payTo: '33333333-3333-4333-8333-333333333333',
    maxTimeoutSeconds: 300,
    extra: { assetName: scheme === 'instrument' ? 'USD' : 'USDC' },
  }));
  server.use(
    http.get(
      SELLER,
      () =>
        new HttpResponse(null, {
          status: 402,
          headers: {
            'PAYMENT-REQUIRED': encodePaymentRequiredHeader({ x402Version: 2, resource: { url: SELLER }, accepts }),
          },
        }),
    ),
    http.get(`${API}/v1/transactions/x402-supported`, () =>
      HttpResponse.json({
        kinds: accepts.map(({ scheme, network }) => ({ scheme, network, x402Version: 2 })),
      }),
    ),
    http.post(`${API}/v1/transactions/x402`, async ({ request }) => {
      expect(request.headers.get('X-API-KEY')).toBe('test-key');
      requests.push(await request.json());
      return fail
        ? HttpResponse.json({ code: 'PARAMETER_INVALID', message: 'Selected funding is unavailable.' }, { status: 400 })
        : HttpResponse.json({ transactionId: 'transaction', approvalId: 'approval', approvalStatus: 'PENDING' });
    }),
  );
  return requests;
}

async function payX402(inflow: Inflow, instrumentId?: string, schemeFilter?: string) {
  const events: PayEvent[] = [];
  for await (const event of inflow.x402.pay({
    url: SELLER,
    probeOptions: { method: 'GET', headers: {} },
    signOptions: {},
    showBody: false,
    awaitPayment: false,
    ...(instrumentId === undefined ? {} : { instrumentId }),
    ...(schemeFilter === undefined ? {} : { schemeFilter }),
  }).events)
    events.push(event);
  return events;
}

describe('linked-card selection through real SDK clients', () => {
  it.each([
    { railFilter: 'balance' },
    { paymentMethodFilter: 'tempo' },
    { intentFilter: 'subscription' },
    { subscriptionId: 'subscription' },
  ])('rejects conflicting MPP options before contacting the seller: %j', async (filters) => {
    const events: MppPayEvent[] = [];
    for await (const event of client().mpp.pay({
      url: SELLER,
      probeOptions: { method: 'GET', headers: {} },
      showBody: false,
      awaitPayment: false,
      interval: 0,
      maxAttempts: 1,
      timeout: 10,
      instrumentId: CARD,
      ...filters,
    }).events)
      events.push(event);
    expect(events).toEqual([expect.objectContaining({ type: 'errored', code: 'INVALID_PAYMENT_OPTIONS' })]);
  });
  it.each([
    [['instrument', 'exact', 'balance'], 'balance'],
    [['instrument', 'exact'], 'exact'],
    [['instrument'], 'instrument'],
  ] as const)('selects %s using default preference', async (schemes, expected) => {
    const requests = x402Offers([...schemes]);
    const events = await payX402(client());
    expect(events.at(-1)?.type).toBe('prepared');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ accept: { scheme: expected } });
    expect(requests[0]).not.toHaveProperty('instrumentId');
  });

  it('isolates simultaneous explicit cards and the cached default selection', async () => {
    const requests = x402Offers(['instrument', 'balance']);
    const inflow = client();
    await Promise.all([payX402(inflow, CARD), payX402(inflow, OTHER_CARD), payX402(inflow)]);
    expect(requests).toHaveLength(3);
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instrumentId: CARD }),
        expect.objectContaining({ instrumentId: OTHER_CARD }),
      ]),
    );
    const defaults = await payX402(inflow, undefined, 'instrument');
    expect(defaults.at(-1)?.type).toBe('prepared');
    expect(requests.at(-1)).not.toHaveProperty('instrumentId');
  });

  it.each([undefined, CARD])('does not change funding after a rejection with card %s', async (id) => {
    const requests = x402Offers(['instrument', 'balance'], true);
    const events = await payX402(client(), id);
    expect(events.at(-1)).toMatchObject({ type: 'errored', code: 'PARAMETER_INVALID' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ accept: { scheme: id === undefined ? 'balance' : 'instrument' } });
  });

  it('rejects conflicting explicit scheme selection', async () => {
    const requests = x402Offers(['instrument', 'balance']);
    expect((await payX402(client(), CARD, 'balance')).at(-1)).toMatchObject({
      type: 'errored',
      code: 'INVALID_PAYMENT_OPTIONS',
    });
    expect(requests).toHaveLength(0);
  });

  it('does not use balance when the explicit card has no matching offer', async () => {
    const requests = x402Offers(['balance']);
    expect((await payX402(client(), CARD)).at(-1)).toMatchObject({ type: 'errored', code: 'NO_FILTERED_MATCH' });
    expect(requests).toHaveLength(0);
  });

  it.each([
    { id: undefined, fail: false, rails: ['balance', 'instrument'] },
    { id: CARD, fail: false, rails: ['balance', 'instrument'] },
    { id: CARD, fail: true, rails: ['balance', 'instrument'] },
    { id: CARD, fail: false, rails: ['balance'] },
  ])('uses only the selected MPP funding source: %j', async ({ id, fail, rails }) => {
    const requests: unknown[] = [];
    server.use(
      http.get(
        SELLER,
        () =>
          new HttpResponse(null, {
            status: 402,
            headers: {
              'WWW-Authenticate': rails
                .map((rail) =>
                  renderChallengeHeader({
                    id: rail,
                    method: 'inflow',
                    intent: 'charge',
                    realm: 'seller.test',
                    expires: '2999-01-01T00:00:00Z',
                    request: encode({
                      amount: '1',
                      currency: rail === 'instrument' ? 'USD' : 'USDC',
                      methodDetails: { rail },
                    }),
                  }),
                )
                .join(', '),
            },
          }),
      ),
      http.post(`${API}/v1/transactions/mpp`, async ({ request }) => {
        requests.push(await request.json());
        if (fail)
          return HttpResponse.json({ code: 'PARAMETER_INVALID', message: 'Card unavailable.' }, { status: 400 });
        return HttpResponse.json({ state: 'pending', transactionId: 'transaction', approvalId: 'approval' });
      }),
    );
    const events: MppPayEvent[] = [];
    for await (const event of client().mpp.pay({
      url: SELLER,
      probeOptions: { method: 'GET', headers: {} },
      showBody: false,
      awaitPayment: false,
      interval: 0,
      maxAttempts: 1,
      timeout: 10,
      paymentMethodFilter: 'inflow',
      intentFilter: 'charge',
      railFilter: 'instrument',
      ...(id === undefined ? {} : { instrumentId: id }),
    }).events)
      events.push(event);
    if (!rails.includes('instrument')) {
      expect(events.at(-1)).toMatchObject({ type: 'errored', code: 'NO_FILTERED_MATCH' });
      expect(requests).toHaveLength(0);
      return;
    }
    expect(events.at(-1)?.type).toBe(fail ? 'errored' : 'created');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      challenge: { id: 'instrument' },
      options: id === undefined ? {} : { instrumentId: id },
    });
  });
});
