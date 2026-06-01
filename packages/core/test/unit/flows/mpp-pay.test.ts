import {
  encode,
  HEADERS,
  type MppChallenge,
  MppClient,
  type MppReceipt,
  renderChallengeHeader,
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

  it('errors NO_INFLOW_MATCH when the 402 carries only non-inflow challenges', async () => {
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

  it('errors NO_FILTERED_MATCH when --currency matches no inflow challenge', async () => {
    server.use(sellerWithChallenge());
    const terminal = (await collect(deps({ currencyFilter: 'EUR' }))).at(-1);
    expect(terminal).toMatchObject({ type: 'errored', code: 'NO_FILTERED_MATCH' });
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
      settlement: { amount: '10', currency: 'USDC' },
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
        reference: 'ref-42',
        amount: '10',
        currency: 'USDC',
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

  it('returns undefined when every receipt field is empty', () => {
    const receipt: MppReceipt = {
      challengeId: '',
      method: 'inflow',
      reference: '',
      settlement: { amount: '', currency: '' },
      status: '',
      timestamp: '',
    };
    const headers = new Headers({ [HEADERS.PAYMENT_RECEIPT]: encode(receipt) });
    expect(buildSettlement(headers)).toBeUndefined();
  });

  it('projects the populated receipt fields into a compact settlement', () => {
    const receipt: MppReceipt = {
      challengeId: 'chal-1',
      method: 'inflow',
      reference: 'ref-9',
      settlement: { amount: '12', currency: 'EUR' },
      status: 'success',
      timestamp: '2025-02-02T00:00:00Z',
    };
    const headers = new Headers({ [HEADERS.PAYMENT_RECEIPT]: encode(receipt) });
    expect(buildSettlement(headers)).toEqual({
      reference: 'ref-9',
      amount: '12',
      currency: 'EUR',
      status: 'success',
      timestamp: '2025-02-02T00:00:00Z',
    });
  });
});
