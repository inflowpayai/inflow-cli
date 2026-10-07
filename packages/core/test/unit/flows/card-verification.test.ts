import { encode, renderChallengeHeader } from '@inflowpayai/mpp';
import type { PaymentStatusResponse } from '@inflowpayai/mpp';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Inflow } from '../../../src/client.js';
import {
  replayWithCardVerification,
  replayPaymentRequest,
  type PaymentReplayInput,
} from '../../../src/flows/payment-fetch.js';
import { reduceMppPay } from '../../../src/flows/mpp-pay.js';
import { runMppFetch } from '../../../src/flows/mpp-fetch.js';
import { reducePay, runPayPipeline } from '../../../src/flows/x402-pay.js';
import { runX402Fetch } from '../../../src/flows/x402-fetch.js';

const API = 'https://api.inflowpay.ai';
const SELLER = 'https://card-seller.test/search';
const ID = '11111111-1111-4111-8111-111111111111';
const URL = `https://app.inflowpay.ai/transactions/${ID}/verify/`;
const pending: PaymentStatusResponse = {
  transactionId: ID,
  status: 'PENDING',
  nextAction: { type: 'authenticate_card', url: URL },
};
const settled: PaymentStatusResponse = { transactionId: ID, status: 'SETTLED' };
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

async function drain(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function fixture(protocol: 'mpp' | 'x402', statuses: PaymentStatusResponse[] = [pending, settled]) {
  const requests: { method: string; headers: Headers; body: string }[] = [];
  const submissions: unknown[] = [];
  const challenge = {
    id: 'challenge',
    method: 'inflow',
    intent: 'charge',
    realm: 'seller.test',
    request: encode({ amount: '1', currency: 'USD', methodDetails: { rail: 'instrument' } }),
  };
  const accept: PaymentRequirements = {
    scheme: 'instrument',
    network: 'inflow:1',
    asset: 'USD',
    amount: '1000000000000000000',
    payTo: ID,
    maxTimeoutSeconds: 300,
    extra: {},
  };
  const paymentPayload = { x402Version: 2, accepted: accept, payload: { transactionId: ID } };
  const credential = encode({ challenge, payload: { transactionId: ID }, source: 'did:web:buyer.test' });
  const paymentHeader = protocol === 'mpp' ? 'Authorization' : 'PAYMENT-SIGNATURE';
  let statusReads = 0;
  server.use(
    http.post(SELLER, async ({ request }) => {
      if (request.headers.has(paymentHeader)) {
        requests.push({ method: request.method, headers: request.headers, body: await request.text() });
        return new HttpResponse(requests.length === 1 ? 'bank verification required' : 'purchased', {
          status: requests.length === 1 ? 402 : 200,
        });
      }
      return new HttpResponse(null, {
        status: 402,
        headers:
          protocol === 'mpp'
            ? { 'WWW-Authenticate': renderChallengeHeader(challenge) }
            : {
                'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
                  x402Version: 2,
                  resource: { url: SELLER },
                  accepts: [accept],
                }),
              },
      });
    }),
    http.get(`${API}/v1/transactions/x402-supported`, () =>
      HttpResponse.json({ kinds: [{ scheme: 'instrument', network: 'inflow:1', x402Version: 2 }] }),
    ),
    http.post(`${API}/v1/transactions/${protocol}`, async ({ request }) => {
      submissions.push(await request.json());
      return HttpResponse.json({ transactionId: ID, approvalId: ID, state: 'ready', credential });
    }),
    http.get(`${API}/v1/transactions/${ID}/mpp`, () =>
      HttpResponse.json({ state: 'ready', transactionId: ID, credential }),
    ),
    http.get(`${API}/v1/transactions/${ID}/x402`, () =>
      HttpResponse.json({ status: 'PENDING', encodedPayload: encode(paymentPayload), paymentPayload }),
    ),
    http.get(`${API}/v1/transactions/${ID}`, ({ request }) => {
      expect(request.headers.get('X-API-KEY')).toBe('buyer-key');
      const status = statuses[Math.min(statusReads++, statuses.length - 1)];
      return HttpResponse.json(status);
    }),
  );
  return { requests, submissions, paymentHeader, statusReads: () => statusReads };
}

const base = {
  url: SELLER,
  probeOptions: { method: 'POST', headers: { 'X-Context': 'search' }, data: '{"query":"plants"}' },
  showBody: true,
  interval: 0.001,
  maxAttempts: 3,
  timeout: 10,
};

describe('card verification through real SDK clients', () => {
  it('reduces verification and replay transitions without retaining an approval wait', () => {
    const verification = {
      transactionId: ID,
      verificationUrl: URL,
      url: SELLER,
      method: 'POST',
      waiting: true,
      reason: 'action-required' as const,
    };
    for (const reduce of [reduceMppPay, reducePay]) {
      expect(reduce({ kind: 'probing' }, { type: 'verification-required', verification })).toEqual({
        kind: 'verification',
        verification,
      });
      expect(reduce({ kind: 'verification', verification }, { type: 'verification-completed' })).toEqual({
        kind: 'resuming',
      });
    }
    const created = {
      transactionId: ID,
      state: 'ready' as const,
      challenge: { id: 'id', realm: 'seller', method: 'inflow', intent: 'charge' },
    };
    expect(
      reduceMppPay({ kind: 'created', created }, { type: 'replaying', created, credential: 'credential' }),
    ).toMatchObject({ kind: 'replaying' });
  });
  it.each(['mpp', 'x402'] as const)(
    '%s pay can defer bank verification without another seller request',
    async (protocol) => {
      const f = fixture(protocol);
      const inflow = new Inflow({ apiKey: 'buyer-key', apiBaseUrl: API });
      const signal = new AbortController().signal;
      const run =
        protocol === 'mpp'
          ? inflow.mpp.pay({ ...base, interval: 0, signal })
          : inflow.x402.pay({ ...base, interval: 0, signOptions: { signal } });
      expect((await drain(run.events)).at(-1)).toMatchObject({
        type: 'verification-required',
        verification: { waiting: false },
      });
      expect(f.requests).toHaveLength(1);
    },
  );
  it('uses default x402 verification limits without treating an already-settled rejection as permission to replay', async () => {
    const f = fixture('x402', [settled]);
    const inflow = new Inflow({ apiKey: 'buyer-key', apiBaseUrl: API });
    const events: unknown[] = [];
    await runPayPipeline(
      {
        client: await inflow.x402.client(),
        apiBaseUrl: API,
        url: SELLER,
        probeOptions: base.probeOptions,
        signOptions: {},
        showBody: false,
      },
      (event) => events.push(event),
    );
    expect(events.at(-1)).toMatchObject({ type: 'rejected' });
    expect(f.requests).toHaveLength(1);
  });
  it.each(['mpp', 'x402'] as const)('%s pay waits and reuses exactly the original purchase', async (protocol) => {
    const f = fixture(protocol);
    const inflow = new Inflow({ apiKey: 'buyer-key', apiBaseUrl: API });
    const run = protocol === 'mpp' ? inflow.mpp.pay(base) : inflow.x402.pay({ ...base, signOptions: {} });
    const events = await drain(run.events);
    expect(events).toContainEqual({
      type: 'verification-required',
      verification: {
        transactionId: ID,
        verificationUrl: URL,
        url: SELLER,
        method: 'POST',
        waiting: true,
        reason: 'action-required',
      },
    });
    expect(events.at(-1)).toMatchObject({ type: 'replayed', result: { outcome: 'paid', body: 'purchased' } });
    expect(f.submissions).toHaveLength(1);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.headers.get(f.paymentHeader)).toBe(f.requests[0]?.headers.get(f.paymentHeader));
    for (const request of f.requests) {
      expect(request.body).toBe(base.probeOptions.data);
      expect(request.headers.get('X-Context')).toBe('search');
      expect(request.headers.has('X-API-KEY')).toBe(false);
    }
    expect(f.statusReads()).toBe(2);
  });

  it.each(['mpp', 'x402'] as const)(
    '%s standalone fetch preserves the original purchase with default and explicit verification options',
    async (protocol) => {
      for (const withSignal of [false, true]) {
        const f = fixture(protocol);
        const inflow = new Inflow({ apiKey: 'buyer-key', apiBaseUrl: API });
        const controller = new AbortController();
        const input = {
          ...base,
          transactionId: ID,
          ...(withSignal ? { apiBaseUrl: API, signal: controller.signal } : {}),
        };
        const run =
          protocol === 'mpp'
            ? runMppFetch({ ...input, client: await inflow.mpp.client() })
            : runX402Fetch({ ...input, client: await inflow.x402.client() });
        const events = await drain(run.events);
        expect(events).toContainEqual({
          type: 'verification-required',
          verification: {
            transactionId: ID,
            verificationUrl: URL,
            url: SELLER,
            method: 'POST',
            waiting: true,
            reason: 'action-required',
          },
        });
        expect(events).toContainEqual({ type: 'verification-completed' });
        expect(events.at(-1)).toMatchObject({ type: 'replayed', result: { outcome: 'paid', body: 'purchased' } });
        expect(f.statusReads()).toBe(2);
        expect(f.submissions).toHaveLength(0);
        expect(f.requests).toHaveLength(2);
        expect(f.requests[1]?.headers.get(f.paymentHeader)).toBe(f.requests[0]?.headers.get(f.paymentHeader));
        for (const request of f.requests) {
          expect(request.method).toBe('POST');
          expect(request.body).toBe(base.probeOptions.data);
          expect(request.headers.get('X-Context')).toBe('search');
          expect(request.headers.has('X-API-KEY')).toBe(false);
        }
      }
    },
  );

  it.each(['mpp', 'x402'] as const)(
    '%s fetch cancellation reaches the payment-status request without replaying or creating a purchase',
    async (protocol) => {
      const f = fixture(protocol);
      const controller = new AbortController();
      let statusSignal: AbortSignal | undefined;
      server.use(
        http.get(`${API}/v1/transactions/${ID}`, ({ request }) => {
          statusSignal = request.signal;
          return new Promise<Response>((resolve) => {
            request.signal.addEventListener('abort', () => resolve(HttpResponse.error()), { once: true });
          });
        }),
      );
      const inflow = new Inflow({ apiKey: 'buyer-key', apiBaseUrl: API });
      const input = { ...base, transactionId: ID, signal: controller.signal };
      const run =
        protocol === 'mpp'
          ? runMppFetch({ ...input, client: await inflow.mpp.client() })
          : runX402Fetch({ ...input, client: await inflow.x402.client() });
      const completion = drain(run.events);
      try {
        await vi.waitFor(() => expect(statusSignal).toBeDefined());
        controller.abort();
        const events = await completion;
        expect(statusSignal?.aborted).toBe(true);
        expect(events.at(-1)).toMatchObject({ type: 'errored' });
        expect(events).not.toContainEqual({ type: 'verification-completed' });
        expect(f.submissions).toHaveLength(0);
        expect(f.requests).toHaveLength(1);
      } finally {
        controller.abort();
        await completion;
      }
    },
  );

  it.each(['mpp', 'x402'] as const)(
    '%s fetch supports deferred verification and manual resume without a new purchase',
    async (protocol) => {
      const f = fixture(protocol);
      const inflow = new Inflow({ apiKey: 'buyer-key', apiBaseUrl: API });
      const input = { ...base, transactionId: ID, interval: 0 };
      const events = await drain(protocol === 'mpp' ? inflow.mpp.fetch(input).events : inflow.x402.fetch(input).events);
      expect(events.at(-1)).toMatchObject({ type: 'verification-required', verification: { waiting: false } });
      const resumed = await drain(
        protocol === 'mpp' ? inflow.mpp.fetch(input).events : inflow.x402.fetch(input).events,
      );
      expect(resumed.at(-1)).toMatchObject({ type: 'replayed', result: { outcome: 'paid' } });
      expect(f.submissions).toHaveLength(0);
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]?.headers.get(f.paymentHeader)).toBe(f.requests[0]?.headers.get(f.paymentHeader));
    },
  );
});

function replayFixture() {
  const request = vi.fn(() =>
    Promise.resolve({
      bytes: new TextEncoder().encode('rejected'),
      contentType: 'text/plain',
      status: 402,
      headers: new Headers(),
    }),
  );
  const input: PaymentReplayInput = {
    url: SELLER,
    method: 'POST',
    headers: {},
    paymentHeaderName: 'Payment-Signature',
    paymentHeaderValue: 'credential',
    showBody: true,
    transactionId: ID,
    sellerTransport: { request },
  };
  const options = {
    apiBaseUrl: API,
    getStatus: vi.fn(() => Promise.resolve(pending)),
    interval: 0,
    maxAttempts: 2,
    timeout: 10,
  };
  return { input, options, request };
}

describe('card verification failure boundaries', () => {
  it('matches an uppercase input UUID to the canonical server UUID', async () => {
    const f = replayFixture();
    const transactionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    f.options.getStatus.mockResolvedValue({
      ...pending,
      transactionId,
      nextAction: { type: 'authenticate_card', url: `https://app.inflowpay.ai/transactions/${transactionId}/verify/` },
    });
    expect(
      (
        await drain(replayWithCardVerification({ ...f.input, transactionId: transactionId.toUpperCase() }, f.options))
      ).at(-1),
    ).toMatchObject({ type: 'verification-required', verification: { transactionId } });
  });
  it('retains the plain replay entry point', async () => {
    const f = replayFixture();
    expect(await replayPaymentRequest(f.input)).toMatchObject({ success: false, body: 'rejected' });
  });
  it('accepts the explicitly configured local development dashboard', async () => {
    const f = replayFixture();
    const apiBaseUrl = 'http://127.0.0.1:9900';
    f.options.getStatus.mockResolvedValue({
      ...pending,
      nextAction: { type: 'authenticate_card', url: `${apiBaseUrl}/transactions/${ID}/verify/` },
    });
    expect((await drain(replayWithCardVerification(f.input, { ...f.options, apiBaseUrl }))).at(-1)).toMatchObject({
      type: 'verification-required',
    });
  });
  it('propagates an aborted status request without replay', async () => {
    const f = replayFixture();
    const controller = new AbortController();
    f.options.getStatus.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error('aborted'));
    });
    await expect(
      drain(replayWithCardVerification(f.input, { ...f.options, signal: controller.signal })),
    ).rejects.toThrow('aborted');
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('supports an un-aborted signal through settlement', async () => {
    const f = replayFixture();
    f.options.getStatus.mockResolvedValueOnce(pending).mockResolvedValue(settled);
    await drain(
      replayWithCardVerification(f.input, { ...f.options, interval: 0.001, signal: new AbortController().signal }),
    );
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it.each([
    '',
    'not a URL',
    'https://evil.test/',
    `https://app.inflowpay.ai/transactions/other/verify/`,
    `${URL}?secret=bad`,
    `${URL}#bad`,
    'javascript:alert(1)',
    URL.replace('https:', 'http:'),
    URL.replace('app.', 'user@app.'),
  ])('rejects an unsafe verification URL: %s', async (url) => {
    const f = replayFixture();
    f.options.getStatus.mockResolvedValue({ ...pending, nextAction: { type: 'authenticate_card', url } });
    await expect(drain(replayWithCardVerification(f.input, f.options))).rejects.toMatchObject({
      code: 'INVALID_CARD_VERIFICATION',
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('rejects the wrong transaction', async () => {
    const f = replayFixture();
    f.options.getStatus.mockResolvedValue({ ...pending, transactionId: 'other' });
    await expect(drain(replayWithCardVerification(f.input, f.options))).rejects.toMatchObject({
      code: 'INVALID_CARD_VERIFICATION',
    });
  });
  it('does not mistake absent nextAction for settlement', async () => {
    const f = replayFixture();
    f.options.getStatus.mockResolvedValue({ transactionId: ID, status: 'PENDING' });
    expect((await drain(replayWithCardVerification(f.input, f.options))).at(-1)).toMatchObject({
      type: 'replay-response',
      response: { success: false },
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('stops at the polling limit without another seller request', async () => {
    const f = replayFixture();
    const events = await drain(replayWithCardVerification(f.input, { ...f.options, interval: 0.001 }));
    expect(events.at(-1)).toMatchObject({
      type: 'verification-required',
      verification: { waiting: false, reason: 'timeout' },
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(['DECLINED', 'GENERAL_ERROR', 'EXPIRED'])('stops on %s', async (status) => {
    const f = replayFixture();
    f.options.getStatus.mockResolvedValueOnce(pending).mockResolvedValue({ transactionId: ID, status });
    await expect(drain(replayWithCardVerification(f.input, { ...f.options, interval: 0.001 }))).rejects.toMatchObject({
      code: 'CARD_PAYMENT_FAILED',
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('keeps a failed settlement retry bounded to one request', async () => {
    const f = replayFixture();
    f.options.getStatus.mockResolvedValueOnce(pending).mockResolvedValue(settled);
    const events = await drain(replayWithCardVerification(f.input, { ...f.options, interval: 0.001 }));
    expect(events.at(-1)).toMatchObject({ type: 'replay-response', response: { success: false } });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it('does not inspect or retry an unknown transport outcome', async () => {
    const f = replayFixture();
    f.request.mockRejectedValue(new Error('connection lost'));
    await expect(drain(replayWithCardVerification(f.input, f.options))).rejects.toMatchObject({
      name: 'PaymentReplayOutcomeUnknownError',
    });
    expect(f.options.getStatus).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('reports unavailable status without exposing provider errors', async () => {
    const f = replayFixture();
    f.options.getStatus.mockRejectedValue(new Error('secret response'));
    await expect(drain(replayWithCardVerification(f.input, f.options))).rejects.toMatchObject({
      code: 'PAYMENT_STATUS_UNAVAILABLE',
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('does not replay after cancellation during the settlement read', async () => {
    const f = replayFixture();
    const controller = new AbortController();
    f.options.getStatus.mockResolvedValueOnce(pending).mockImplementation(() => {
      controller.abort();
      return Promise.resolve(settled);
    });
    await expect(
      drain(replayWithCardVerification(f.input, { ...f.options, interval: 0.001, signal: controller.signal })),
    ).rejects.toBeDefined();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('does not send anything when already aborted', async () => {
    const f = replayFixture();
    const controller = new AbortController();
    controller.abort();
    expect(await drain(replayWithCardVerification(f.input, { ...f.options, signal: controller.signal }))).toEqual([]);
    expect(f.request).not.toHaveBeenCalled();
  });
});
