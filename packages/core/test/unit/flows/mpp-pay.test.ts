import {
  encode,
  HEADERS,
  type MppChallenge,
  MppClient,
  type MppReceipt,
  renderChallengeHeader,
  subscriptionOptionFingerprint,
} from '@inflowpayai/mpp';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSettlement,
  mapMppError,
  type MppPayEvent,
  type MppPayPipelineDeps,
  reduceMppPay,
  runMppPayPipeline,
} from '../../../src/flows/mpp-pay.js';
import { DEFAULT_ACCEPT_PAYMENT_HEADER } from '../../../src/flows/mpp-shared.js';

const SELLER = 'https://seller.test/api';
const INFLOW = 'https://mpp.test';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function challenge(method = 'inflow'): MppChallenge {
  return {
    id: `chal-${method}`,
    realm: 'mpp.test',
    method,
    intent: 'charge',
    request: encode({ amount: '10', currency: 'USDC', methodDetails: { rail: 'balance' } }),
    expires: '2999-01-01T00:00:00Z',
  };
}

function subscriptionChallenge(periodUnit: 'day' | 'month'): MppChallenge {
  return {
    id: `subscription-${periodUnit}`,
    realm: 'mpp.test',
    method: 'inflow',
    intent: 'subscription',
    request: encode({
      amount: periodUnit === 'day' ? '0.1' : '1',
      currency: 'USDC',
      methodDetails: { rail: 'balance' },
      periodCount: 1,
      periodUnit,
      subscriptionExpires: '2999-01-01T00:00:00Z',
      externalId: `${periodUnit}-plan`,
    }),
    expires: '2099-01-01T00:00:00Z',
  };
}

/** A 402 from the seller; once the replay carries `Authorization: Payment`, return 200. */
function sellerWithChallenge(method = 'inflow'): ReturnType<typeof http.get> {
  return http.get(SELLER, ({ request }) => {
    const auth = request.headers.get('authorization');
    if (auth !== null && /^payment\s/i.test(auth)) {
      return new HttpResponse('PAID-BODY', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new HttpResponse(null, {
      status: 402,
      headers: { 'WWW-Authenticate': renderChallengeHeader(challenge(method)) },
    });
  });
}

function deps(overrides: Partial<MppPayPipelineDeps> = {}): MppPayPipelineDeps {
  return {
    client: new MppClient({ apiKey: 'k', baseUrl: INFLOW }),
    apiBaseUrl: INFLOW,
    url: SELLER,
    probeOptions: { method: 'GET', headers: {} },
    showBody: true,
    interval: 0.01,
    maxAttempts: 5,
    timeout: 30,
    ...overrides,
  };
}

async function collect(d: MppPayPipelineDeps): Promise<MppPayEvent[]> {
  const events: MppPayEvent[] = [];
  await runMppPayPipeline(d, (e) => events.push(e));
  return events;
}

describe('runMppPayPipeline', () => {
  it('uses fresh buyer authorization for an existing subscription instead of creating a transaction', async () => {
    const recurring = subscriptionChallenge('month');
    const freshCredential = encode({
      challenge: recurring,
      payload: { transactionId: 'tx-subscription' },
      source: 'did:inflow:buyer',
    });
    let createHits = 0;
    let replayTransactionId: string | undefined;
    server.use(
      http.post(`${INFLOW}/v1/transactions/mpp`, () => {
        createHits += 1;
        return HttpResponse.json({ state: 'failed' });
      }),
    );
    const subscriptions = {
      authorize: (subscriptionId: string, received: MppChallenge) => {
        expect(subscriptionId).toBe('sub-1');
        expect(received.id).toBe(recurring.id);
        return Promise.resolve({ credential: freshCredential, expires: recurring.expires as string });
      },
      cancel: () => Promise.resolve(undefined),
      get: () => Promise.reject(new Error('unused')),
      list: () => Promise.resolve({ count: 0, data: [], total: 0 }),
    };

    const events = await collect(
      deps({
        subscriptions,
        subscriptionId: 'sub-1',
        intentFilter: 'subscription',
        sellerTransport: {
          request: (input) => {
            if (input.additionalAuthenticationHeaders !== undefined) {
              expect(input.additionalAuthenticationHeaders).toEqual({ Authorization: `Payment ${freshCredential}` });
              replayTransactionId = input.transactionId;
              return Promise.resolve({
                bytes: new Uint8Array(Buffer.from('ACCESS')),
                contentType: 'text/plain',
                headers: new Headers(),
                status: 200,
              });
            }
            return Promise.resolve({
              bytes: new Uint8Array(),
              contentType: undefined,
              headers: new Headers({ 'WWW-Authenticate': renderChallengeHeader(recurring) }),
              status: 402,
            });
          },
        },
      }),
    );

    expect(events.at(-1)).toMatchObject({ type: 'replayed', result: { outcome: 'paid', transactionId: 'sub-1' } });
    expect(replayTransactionId).toBe('tx-subscription');
    expect(createHits).toBe(0);
  });

  it('pays on a ready-on-create transaction and replays for the body', async () => {
    server.use(
      sellerWithChallenge(),
      http.post(`${INFLOW}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'ready', credential: 'CRED-B64', transactionId: 'tx-1' }),
      ),
    );
    const events = await collect(deps());
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('replayed');
    if (terminal?.type === 'replayed') {
      expect(terminal.result.outcome).toBe('paid');
      expect(terminal.result.credential).toBe('CRED-B64');
      expect(terminal.result.challengeId).toBe('chal-inflow');
      expect(terminal.result.body).toBe('PAID-BODY');
    }
  });

  it('creates the payment transaction only after the shared seller transport returns a payment challenge', async () => {
    const order: string[] = [];
    const request = (input: {
      additionalAuthenticationHeaders?: Record<string, string>;
      headers: Record<string, string>;
      method: string;
      transactionId?: string;
      url: string;
    }) => {
      order.push(input.additionalAuthenticationHeaders === undefined ? 'aep-then-payment-challenge' : 'paid-replay');
      if (input.additionalAuthenticationHeaders !== undefined) {
        expect(input.additionalAuthenticationHeaders).toEqual({ Authorization: 'Payment CRED-ORDER' });
        expect(input.transactionId).toBe('tx-order');
        return Promise.resolve({
          bytes: new Uint8Array(Buffer.from('paid')),
          contentType: 'text/plain',
          headers: new Headers(),
          status: 200,
        });
      }
      return Promise.resolve({
        bytes: new Uint8Array(),
        contentType: undefined,
        headers: new Headers({ 'WWW-Authenticate': renderChallengeHeader(challenge()) }),
        status: 402,
        tapEvidenceId: '00000000-0000-0000-0000-000000000123',
      });
    };
    const client = {
      createTransaction: (body: { tapEvidenceId?: string }) => {
        order.push('payment-created');
        expect(body.tapEvidenceId).toBe('00000000-0000-0000-0000-000000000123');
        return Promise.resolve({ state: 'ready', credential: 'CRED-ORDER', transactionId: 'tx-order' });
      },
    };

    const terminal = (await collect(deps({ client: client as unknown as MppClient, sellerTransport: { request } }))).at(
      -1,
    );

    expect(order).toEqual(['aep-then-payment-challenge', 'payment-created', 'paid-replay']);
    expect(terminal?.type).toBe('replayed');
  });

  it('injects a default Accept-Payment header and preserves the request body through replay', async () => {
    const data = '{"order":1}';
    const frames: Array<{
      stage: 'probe' | 'replay';
      headers: Record<string, string>;
      data: string | undefined;
    }> = [];
    const request = (input: {
      additionalAuthenticationHeaders?: Record<string, string>;
      data?: string;
      headers: Record<string, string>;
      method: string;
      url: string;
    }) => {
      frames.push({
        stage: input.additionalAuthenticationHeaders === undefined ? 'probe' : 'replay',
        headers: input.headers,
        data: input.data,
      });
      if (input.additionalAuthenticationHeaders !== undefined) {
        expect(input.additionalAuthenticationHeaders).toEqual({ Authorization: 'Payment CRED-ORDER' });
        return Promise.resolve({
          bytes: new Uint8Array(Buffer.from('paid')),
          contentType: 'text/plain',
          headers: new Headers(),
          status: 200,
        });
      }
      return Promise.resolve({
        bytes: new Uint8Array(),
        contentType: undefined,
        headers: new Headers({ 'WWW-Authenticate': renderChallengeHeader(challenge()) }),
        status: 402,
      });
    };
    const client = {
      createTransaction: () => {
        return Promise.resolve({ state: 'ready', credential: 'CRED-ORDER', transactionId: 'tx-order' });
      },
    };

    const terminal = (
      await collect(
        deps({
          client: client as unknown as MppClient,
          probeOptions: { method: 'POST', headers: {}, data },
          sellerTransport: { request },
        }),
      )
    ).at(-1);

    expect(frames.map((frame) => frame.stage)).toEqual(['probe', 'replay']);
    expect(frames.map((frame) => frame.data)).toEqual([data, data]);
    expect(frames[0]?.headers['Accept-Payment']).toBe(DEFAULT_ACCEPT_PAYMENT_HEADER);
    expect(frames[1]?.headers['Accept-Payment']).toBe(DEFAULT_ACCEPT_PAYMENT_HEADER);
    expect(terminal?.type).toBe('replayed');
  });

  it('uses a caller-supplied lowercase Accept-Payment header and preserves it through replay', async () => {
    const frames: Array<{ stage: 'probe' | 'replay'; headers: Record<string, string> }> = [];
    const request = (input: {
      additionalAuthenticationHeaders?: Record<string, string>;
      headers: Record<string, string>;
      method: string;
      url: string;
    }) => {
      frames.push({
        stage: input.additionalAuthenticationHeaders === undefined ? 'probe' : 'replay',
        headers: input.headers,
      });
      if (input.additionalAuthenticationHeaders !== undefined) {
        return Promise.resolve({
          bytes: new Uint8Array(Buffer.from('paid')),
          contentType: 'text/plain',
          headers: new Headers(),
          status: 200,
        });
      }
      return Promise.resolve({
        bytes: new Uint8Array(),
        contentType: undefined,
        headers: new Headers({ 'WWW-Authenticate': renderChallengeHeader(challenge()) }),
        status: 402,
      });
    };
    const client = {
      createTransaction: () => {
        return Promise.resolve({ state: 'ready', credential: 'CRED-ORDER', transactionId: 'tx-order' });
      },
    };

    const terminal = (
      await collect(
        deps({
          client: client as unknown as MppClient,
          sellerTransport: { request },
          probeOptions: { method: 'GET', headers: { 'accept-payment': 'tempo/charge' } },
        }),
      )
    ).at(-1);

    expect(frames[0]?.headers['accept-payment']).toBe('tempo/charge');
    expect(frames[1]?.headers['accept-payment']).toBe('tempo/charge');
    expect(terminal?.type).toBe('replayed');
  });

  it('narrows the injected header when a supported payment method filter is supplied', async () => {
    const frames: Array<{ stage: 'probe' | 'replay'; headers: Record<string, string> }> = [];
    const request = (input: {
      additionalAuthenticationHeaders?: Record<string, string>;
      headers: Record<string, string>;
      method: string;
      url: string;
    }) => {
      if (input.additionalAuthenticationHeaders === undefined) {
        frames.push({ stage: 'probe', headers: input.headers });
        return Promise.resolve({
          bytes: new Uint8Array(),
          contentType: undefined,
          headers: new Headers({ 'WWW-Authenticate': renderChallengeHeader(challenge()) }),
          status: 402,
        });
      }
      frames.push({ stage: 'replay', headers: input.headers });
      return Promise.resolve({
        bytes: new Uint8Array(Buffer.from('paid')),
        contentType: 'text/plain',
        headers: new Headers(),
        status: 200,
      });
    };
    const client = {
      createTransaction: () => {
        return Promise.resolve({ state: 'ready', credential: 'CRED-ORDER', transactionId: 'tx-order' });
      },
    };

    await collect(
      deps({
        client: client as unknown as MppClient,
        paymentMethodFilter: 'tempo',
        sellerTransport: { request },
      }),
    );

    expect(frames[0]?.headers['Accept-Payment']).toBe('tempo/charge');
  });

  it('pays a Tempo challenge when selected by payment method', async () => {
    let createdMethod: string | undefined;
    server.use(
      sellerWithChallenge('tempo'),
      http.post(`${INFLOW}/v1/transactions/mpp`, async ({ request }) => {
        const body = (await request.json()) as { challenge?: { method?: string } };
        createdMethod = body.challenge?.method;
        return HttpResponse.json({ state: 'ready', credential: 'CRED-TEMPO', transactionId: 'tx-tempo' });
      }),
    );
    const events = await collect(deps({ paymentMethodFilter: 'tempo' }));
    const terminal = events.at(-1);
    expect(createdMethod).toBe('tempo');
    expect(terminal?.type).toBe('replayed');
    if (terminal?.type === 'replayed') {
      expect(terminal.result.challengeId).toBe('chal-tempo');
    }
  });

  it('polls a pending transaction to ready, then pays', async () => {
    let gets = 0;
    server.use(
      sellerWithChallenge(),
      http.post(`${INFLOW}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'pending', transactionId: 'tx-2', approvalId: 'ap-2', retryAfterSeconds: 0 }),
      ),
      http.get(`${INFLOW}/v1/transactions/tx-2/mpp`, () => {
        gets += 1;
        if (gets < 2) return HttpResponse.json({ state: 'pending', transactionId: 'tx-2', retryAfterSeconds: 0 });
        return HttpResponse.json({ state: 'ready', credential: 'CRED-2', transactionId: 'tx-2' });
      }),
    );
    const events = await collect(deps());
    expect(events.map((e) => e.type)).toContain('created');
    expect(events.at(-1)?.type).toBe('replayed');
  });

  it('stops at created for a pending transaction when awaitPayment is false (two-process)', async () => {
    server.use(
      sellerWithChallenge(),
      http.post(`${INFLOW}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'pending', transactionId: 'tx-3', approvalId: 'ap-3', retryAfterSeconds: 5 }),
      ),
    );
    const events = await collect(deps({ awaitPayment: false }));
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('created');
    if (terminal?.type === 'created') {
      expect(terminal.created.state).toBe('pending');
      expect(terminal.created.approvalId).toBe('ap-3');
      expect(terminal.created.approvalUrl).toContain('ap-3');
    }
  });

  it('errors PAYMENT_FAILED on a failed transaction', async () => {
    server.use(
      sellerWithChallenge(),
      http.post(`${INFLOW}/v1/transactions/mpp`, () =>
        HttpResponse.json({
          state: 'failed',
          transactionId: 'tx-4',
          problem: {
            type: 'https://paymentauth.org/problems/verification-failed',
            title: 'fail',
            status: 402,
            detail: 'no funds',
          },
        }),
      ),
    );
    const terminal = (await collect(deps())).at(-1);
    expect(terminal).toEqual({ type: 'errored', code: 'PAYMENT_FAILED', message: 'no funds' });
  });

  it('short-circuits when the seller serves without payment', async () => {
    server.use(http.get(SELLER, () => new HttpResponse('FREE', { status: 200 })));
    const terminal = (await collect(deps())).at(-1);
    expect(terminal?.type).toBe('short-circuited');
    if (terminal?.type === 'short-circuited') expect(terminal.result.outcome).toBe('no-payment-required');
  });

  it('reports seller-rejected when the replay is non-2xx', async () => {
    server.use(
      http.get(SELLER, ({ request }) => {
        const auth = request.headers.get('authorization');
        if (auth !== null && /^payment\s/i.test(auth)) return new HttpResponse('nope', { status: 402 });
        return new HttpResponse(null, {
          status: 402,
          headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) },
        });
      }),
      http.post(`${INFLOW}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'ready', credential: 'CRED-R', transactionId: 'tx-5' }),
      ),
    );
    const terminal = (await collect(deps())).at(-1);
    expect(terminal?.type).toBe('rejected');
    if (terminal?.type === 'rejected') expect(terminal.result.outcome).toBe('seller-rejected');
  });

  it('errors NO_INFLOW_MATCH when the 402 carries only unsupported method challenges', async () => {
    server.use(sellerWithChallenge('other'));
    const terminal = (await collect(deps())).at(-1);
    expect(terminal?.type).toBe('errored');
    if (terminal?.type === 'errored') expect(terminal.code).toBe('NO_INFLOW_MATCH');
  });

  it('errors UNEXPECTED_PROBE_STATUS when the seller returns neither 2xx nor 402', async () => {
    server.use(http.get(SELLER, () => new HttpResponse('boom', { status: 500 })));
    const terminal = (await collect(deps())).at(-1);
    expect(terminal).toMatchObject({ type: 'errored', code: 'UNEXPECTED_PROBE_STATUS' });
  });

  it('errors INVALID_402 when the 402 carries no WWW-Authenticate header', async () => {
    server.use(http.get(SELLER, () => new HttpResponse(null, { status: 402 })));
    const terminal = (await collect(deps())).at(-1);
    expect(terminal).toMatchObject({ type: 'errored', code: 'INVALID_402' });
  });

  it('errors DECODE_FAILED when the 402 carries a malformed Payment challenge header', async () => {
    server.use(
      http.get(
        SELLER,
        () => new HttpResponse(null, { status: 402, headers: { 'WWW-Authenticate': 'Payment realm="mpp.test"' } }),
      ),
    );
    const terminal = (await collect(deps())).at(-1);
    expect(terminal).toMatchObject({ type: 'errored', code: 'DECODE_FAILED' });
  });

  it('pays the matching challenge when --currency selects it', async () => {
    server.use(
      sellerWithChallenge(),
      http.post(`${INFLOW}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'ready', credential: 'CRED-C', transactionId: 'tx-c' }),
      ),
    );
    const terminal = (await collect(deps({ currencyFilter: 'USDC' }))).at(-1);
    expect(terminal?.type).toBe('replayed');
  });

  it('errors NO_FILTERED_MATCH when --currency matches no supported MPP challenge', async () => {
    server.use(sellerWithChallenge());
    const terminal = (await collect(deps({ currencyFilter: 'EUR' }))).at(-1);
    expect(terminal).toMatchObject({ type: 'errored', code: 'NO_FILTERED_MATCH' });
  });

  it('requires an option id when multiple subscription offers remain', async () => {
    const headers = new Headers();
    headers.append('WWW-Authenticate', renderChallengeHeader(subscriptionChallenge('day')));
    headers.append('WWW-Authenticate', renderChallengeHeader(subscriptionChallenge('month')));
    const terminal = (
      await collect(
        deps({
          intentFilter: 'subscription',
          sellerTransport: {
            request: () => Promise.resolve({ bytes: new Uint8Array(), contentType: undefined, headers, status: 402 }),
          },
        }),
      )
    ).at(-1);

    expect(terminal).toMatchObject({ type: 'errored', code: 'SUBSCRIPTION_OPTION_AMBIGUOUS' });
  });

  it('selects the current subscription challenge matching the stable option id', async () => {
    const daily = subscriptionChallenge('day');
    const monthly = subscriptionChallenge('month');
    const headers = new Headers();
    headers.append('WWW-Authenticate', renderChallengeHeader(daily));
    headers.append('WWW-Authenticate', renderChallengeHeader(monthly));
    let selectedId: string | undefined;
    const client = {
      createTransaction: ({ challenge: selected }: { challenge: MppChallenge }) => {
        selectedId = selected.id;
        return Promise.resolve({ state: 'pending', transactionId: 'tx-selected' });
      },
    };
    const optionId = subscriptionOptionFingerprint(monthly)?.optionId;
    if (optionId === undefined) throw new Error('Expected a subscription option ID.');

    await collect(
      deps({
        client: client as unknown as MppClient,
        intentFilter: 'subscription',
        optionIdFilter: optionId,
        awaitPayment: false,
        sellerTransport: {
          request: () => Promise.resolve({ bytes: new Uint8Array(), contentType: undefined, headers, status: 402 }),
        },
      }),
    );

    expect(selectedId).toBe('subscription-month');
  });

  it('treats duplicate subscription terms as one option and selects the first challenge', async () => {
    const first = subscriptionChallenge('month');
    const duplicate = { ...first, id: 'subscription-month-duplicate' };
    const headers = new Headers();
    headers.append('WWW-Authenticate', renderChallengeHeader(first));
    headers.append('WWW-Authenticate', renderChallengeHeader(duplicate));
    let selectedId: string | undefined;
    const client = {
      createTransaction: ({ challenge: selected }: { challenge: MppChallenge }) => {
        selectedId = selected.id;
        return Promise.resolve({ state: 'pending', transactionId: 'tx-selected' });
      },
    };

    const terminal = (
      await collect(
        deps({
          client: client as unknown as MppClient,
          intentFilter: 'subscription',
          awaitPayment: false,
          sellerTransport: {
            request: () => Promise.resolve({ bytes: new Uint8Array(), contentType: undefined, headers, status: 402 }),
          },
        }),
      )
    ).at(-1);

    expect(selectedId).toBe(first.id);
    expect(terminal).not.toMatchObject({ type: 'errored', code: 'SUBSCRIPTION_OPTION_AMBIGUOUS' });
  });

  it('maps a thrown createTransaction error into a PAYMENT_FAILED frame', async () => {
    server.use(
      sellerWithChallenge(),
      http.post(`${INFLOW}/v1/transactions/mpp`, () => new HttpResponse('nope', { status: 500 })),
    );
    const terminal = (await collect(deps())).at(-1);
    expect(terminal).toMatchObject({ type: 'errored', code: 'PAYMENT_FAILED' });
  });

  it('errors PAYMENT_FAILED when a pending transaction carries no transactionId to poll', async () => {
    server.use(
      sellerWithChallenge(),
      http.post(`${INFLOW}/v1/transactions/mpp`, () => HttpResponse.json({ state: 'pending' })),
    );
    const terminal = (await collect(deps())).at(-1);
    expect(terminal).toMatchObject({ type: 'errored', code: 'PAYMENT_FAILED' });
  });

  it('errors POLLING_TIMEOUT when a pending transaction never reaches ready', async () => {
    server.use(
      sellerWithChallenge(),
      http.post(`${INFLOW}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'pending', transactionId: 'tx-to', retryAfterSeconds: 0 }),
      ),
      http.get(`${INFLOW}/v1/transactions/tx-to/mpp`, () =>
        HttpResponse.json({ state: 'pending', transactionId: 'tx-to', retryAfterSeconds: 0 }),
      ),
    );
    const terminal = (await collect(deps({ maxAttempts: 2 }))).at(-1);
    expect(terminal).toMatchObject({ type: 'errored', code: 'POLLING_TIMEOUT' });
  });

  it('errors PAYMENT_EXPIRED when the created transaction is already expired', async () => {
    server.use(
      sellerWithChallenge(),
      http.post(`${INFLOW}/v1/transactions/mpp`, () => HttpResponse.json({ state: 'expired', transactionId: 'tx-x' })),
    );
    const terminal = (await collect(deps())).at(-1);
    expect(terminal).toMatchObject({ type: 'errored', code: 'PAYMENT_EXPIRED' });
  });

  it('errors PAYMENT_FAILED when a ready transaction arrives without a credential', async () => {
    server.use(
      sellerWithChallenge(),
      http.post(`${INFLOW}/v1/transactions/mpp`, () => HttpResponse.json({ state: 'ready', transactionId: 'tx-nc' })),
    );
    const terminal = (await collect(deps())).at(-1);
    expect(terminal).toMatchObject({ type: 'errored', code: 'PAYMENT_FAILED' });
  });

  it('surfaces a decoded settlement summary from the Payment-Receipt header on a paid response', async () => {
    const receipt: MppReceipt = {
      challengeId: 'chal-inflow',
      method: 'inflow',
      reference: 'ref-42',
      settlement: { amount: '10.5', currency: 'USDC' },
      status: 'success',
      timestamp: '2025-01-01T00:00:00Z',
    };
    server.use(
      http.get(SELLER, ({ request }) => {
        const auth = request.headers.get('authorization');
        if (auth !== null && /^payment\s/i.test(auth)) {
          return new HttpResponse('PAID-BODY', {
            status: 200,
            headers: { 'Content-Type': 'text/plain', [HEADERS.PAYMENT_RECEIPT]: encode(receipt) },
          });
        }
        return new HttpResponse(null, {
          status: 402,
          headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) },
        });
      }),
      http.post(`${INFLOW}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'ready', credential: 'CRED-S', transactionId: 'tx-s' }),
      ),
    );
    const terminal = (await collect(deps())).at(-1);
    expect(terminal?.type).toBe('replayed');
    if (terminal?.type === 'replayed') {
      expect(terminal.result.settled).toEqual({
        amount: '10.5',
        currency: 'USDC',
        reference: 'ref-42',
        status: 'success',
        timestamp: '2025-01-01T00:00:00Z',
      });
    }
  });
});

describe('reduceMppPay', () => {
  const noPayment = {
    outcome: 'no-payment-required' as const,
    url: 'u',
    method: 'GET',
    status: 200,
    contentType: undefined,
    bodySizeBytes: 0,
  };
  const created = {
    transactionId: 'tx-1',
    state: 'pending' as const,
    challenge: { id: 'c', realm: 'r', method: 'inflow', intent: 'charge' },
  };

  it('decoded → decoded phase', () => {
    const challenge = { id: 'c', realm: 'r', method: 'inflow', intent: 'charge' };
    expect(reduceMppPay({ kind: 'probing' }, { type: 'decoded', challenge })).toEqual({ kind: 'decoded', challenge });
  });

  it('created → created phase', () => {
    expect(reduceMppPay({ kind: 'probing' }, { type: 'created', created })).toEqual({ kind: 'created', created });
  });

  it('replayed → success phase', () => {
    const result = {
      outcome: 'paid' as const,
      url: 'u',
      method: 'GET',
      transactionId: 'tx-1',
      challengeId: 'c',
      intent: 'charge',
      credential: 'CRED',
      responseStatus: 200,
      responseContentType: undefined,
      bodySizeBytes: 3,
    };
    expect(reduceMppPay({ kind: 'probing' }, { type: 'replayed', result })).toEqual({ kind: 'success', result });
  });

  it('rejected → seller-rejected phase', () => {
    const result = {
      outcome: 'seller-rejected' as const,
      url: 'u',
      method: 'GET',
      transactionId: 'tx-1',
      challengeId: 'c',
      responseStatus: 402,
      responseContentType: undefined,
      bodySizeBytes: 0,
    };
    expect(reduceMppPay({ kind: 'probing' }, { type: 'rejected', result })).toEqual({
      kind: 'seller-rejected',
      result,
    });
  });

  it('short-circuited → no-payment-final phase', () => {
    expect(reduceMppPay({ kind: 'probing' }, { type: 'short-circuited', result: noPayment })).toEqual({
      kind: 'no-payment-final',
      result: noPayment,
    });
  });

  it('errored → error phase', () => {
    expect(reduceMppPay({ kind: 'probing' }, { type: 'errored', code: 'X', message: 'm' })).toEqual({
      kind: 'error',
      code: 'X',
      message: 'm',
    });
  });

  it('returns the prior state for an unrecognised event (default branch)', () => {
    const prior = { kind: 'probing' } as const;
    expect(reduceMppPay(prior, { type: 'bogus' } as never)).toBe(prior);
  });
});

describe('mapMppError', () => {
  it('uses the message of a thrown Error', () => {
    expect(mapMppError(new Error('boom'))).toEqual({ code: 'PAYMENT_FAILED', message: 'boom' });
  });

  it('stringifies a non-Error throwable', () => {
    expect(mapMppError('plain')).toEqual({ code: 'PAYMENT_FAILED', message: 'plain' });
  });
});

describe('buildSettlement', () => {
  it('returns undefined when the Payment-Receipt header is absent', () => {
    expect(buildSettlement(new Headers())).toBeUndefined();
  });

  it('returns undefined when the header value is not a decodable receipt', () => {
    const headers = new Headers({ [HEADERS.PAYMENT_RECEIPT]: 'a' });
    expect(buildSettlement(headers)).toBeUndefined();
  });

  it('returns undefined when a core receipt has no settlement extension', () => {
    const headers = new Headers({
      [HEADERS.PAYMENT_RECEIPT]: encode({
        method: 'tempo',
        reference: 'ref-8',
        status: 'success',
        timestamp: '2025-02-02T00:00:00Z',
      }),
    });
    expect(buildSettlement(headers)).toBeUndefined();
  });

  it('projects the populated receipt fields into a compact settlement', () => {
    const receipt: MppReceipt = {
      challengeId: 'chal-1',
      externalId: 'seller-plan',
      method: 'inflow',
      reference: 'ref-9',
      settlement: { amount: '10.5', currency: 'USDC' },
      status: 'success',
      timestamp: '2025-02-02T00:00:00Z',
      subscriptionId: 'subscription-id',
    };
    const headers = new Headers({ [HEADERS.PAYMENT_RECEIPT]: encode(receipt) });
    expect(buildSettlement(headers)).toEqual({
      reference: 'ref-9',
      status: 'success',
      timestamp: '2025-02-02T00:00:00Z',
      amount: '10.5',
      currency: 'USDC',
      externalId: 'seller-plan',
      subscriptionId: 'subscription-id',
    });
  });

  it('preserves Tempo settlement identifiers', () => {
    const receipt: MppReceipt = {
      challengeId: 'chal-2',
      method: 'tempo',
      reference: 'ref-10',
      settlement: { amount: '1000', currency: '0x20c0000000000000000000000000000000000000' },
      status: 'success',
      timestamp: '2025-02-02T00:00:00Z',
    };
    const headers = new Headers({ [HEADERS.PAYMENT_RECEIPT]: encode(receipt) });
    expect(buildSettlement(headers)).toEqual({
      reference: 'ref-10',
      status: 'success',
      timestamp: '2025-02-02T00:00:00Z',
      amount: '1000',
      currency: '0x20c0000000000000000000000000000000000000',
    });
  });
});
