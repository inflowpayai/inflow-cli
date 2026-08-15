import { encode, type MppChallenge, renderChallengeHeader } from '@inflowpayai/mpp';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type MppInspectEvent,
  type MppInspectResultChallenges,
  type MppInspectResultNoPayment,
  PaymentInspectionBlockedError,
  reduceMppInspect,
  runMppInspectPipeline,
} from '../../../src/index.js';
import { DEFAULT_ACCEPT_PAYMENT_HEADER } from '../../../src/flows/mpp-shared.js';

const SELLER = 'https://seller.test/api';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function challenge(method = 'inflow'): MppChallenge {
  const request =
    method === 'tempo'
      ? {
          amount: '10000',
          currency: '0x20c0000000000000000000000000000000000000',
          methodDetails: { chainId: 42431, feePayer: false, supportedModes: ['pull'] },
          recipient: '0x61d64bdb13debd1844defecd45cf737403de9813',
        }
      : { amount: '10', currency: 'USDC', methodDetails: { rail: 'balance' } };
  return {
    id: `chal-${method}`,
    realm: 'mpp.test',
    method,
    intent: 'charge',
    request: encode(request),
    expires: '2999-01-01T00:00:00Z',
  };
}

async function collect(filters: Partial<Parameters<typeof runMppInspectPipeline>[0]> = {}): Promise<MppInspectEvent[]> {
  const events: MppInspectEvent[] = [];
  await runMppInspectPipeline({ url: SELLER, probeOptions: { method: 'GET', headers: {} }, ...filters }, (e) =>
    events.push(e),
  );
  return events;
}

describe('runMppInspectPipeline', () => {
  it('parses the inflow challenge(s) from a 402', async () => {
    server.use(
      http.get(
        SELLER,
        () =>
          new HttpResponse(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) } }),
      ),
    );
    const [event] = await collect();
    expect(event?.type).toBe('challenges');
    if (event?.type === 'challenges') {
      expect(event.result.challenges[0]?.amount).toBe('10');
      expect(event.result.challenges[0]?.currency).toBe('USDC');
    }
  });

  it('injects the default Accept-Payment header when probing and decoding MPP', async () => {
    let headers: Record<string, string> | undefined;
    const [event] = await collect({
      probe: (_url, options) => {
        headers = options.headers;
        return Promise.resolve({
          bytes: new Uint8Array(),
          contentType: undefined,
          headers: new Headers({ 'WWW-Authenticate': renderChallengeHeader(challenge()) }),
          status: 402,
        });
      },
    });
    expect(event?.type).toBe('challenges');
    expect(headers?.['Accept-Payment']).toBe(DEFAULT_ACCEPT_PAYMENT_HEADER);
  });

  it('keeps an explicitly supplied lower-case Accept-Payment header on probe', async () => {
    let headers: Record<string, string> | undefined;
    const [event] = await collect({
      probeOptions: { method: 'GET', headers: { 'accept-payment': 'tempo/charge' } },
      probe: (_url, options) => {
        headers = options.headers;
        return Promise.resolve({
          bytes: new Uint8Array(),
          contentType: undefined,
          headers: new Headers({ 'WWW-Authenticate': renderChallengeHeader(challenge('tempo')) }),
          status: 402,
        });
      },
    });
    expect(event?.type).toBe('challenges');
    expect(headers?.['accept-payment']).toBe('tempo/charge');
  });

  it('parses Tempo challenges from a 402', async () => {
    server.use(
      http.get(
        SELLER,
        () =>
          new HttpResponse(null, {
            status: 402,
            headers: { 'WWW-Authenticate': renderChallengeHeader(challenge('tempo')) },
          }),
      ),
    );
    const [event] = await collect();
    expect(event?.type).toBe('challenges');
    if (event?.type === 'challenges') {
      expect(event.result.challenges[0]?.method).toBe('tempo');
      // Surfaced verbatim from the wire — no base-unit/symbol translation in the CLI.
      expect(event.result.challenges[0]?.amount).toBe('10000');
      expect(event.result.challenges[0]?.currency).toBe('0x20c0000000000000000000000000000000000000');
    }
  });

  it('keeps challenges matching a filter (--rail balance)', async () => {
    server.use(
      http.get(
        SELLER,
        () =>
          new HttpResponse(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) } }),
      ),
    );
    const [event] = await collect({ railFilter: 'balance' });
    expect(event?.type).toBe('challenges');
    if (event?.type === 'challenges') expect(event.result.challenges).toHaveLength(1);
  });

  it('errors NO_FILTERED_MATCH when a filter excludes every challenge', async () => {
    server.use(
      http.get(
        SELLER,
        () =>
          new HttpResponse(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) } }),
      ),
    );
    const [event] = await collect({ currencyFilter: 'EURC' });
    expect(event?.type).toBe('errored');
    if (event?.type === 'errored') expect(event.code).toBe('NO_FILTERED_MATCH');
  });

  it('reports no-payment-required on a 2xx probe', async () => {
    server.use(http.get(SELLER, () => new HttpResponse('hi', { status: 200 })));
    const [event] = await collect();
    expect(event?.type).toBe('no-payment');
  });

  it('errors INVALID_402 when the 402 carries no WWW-Authenticate header', async () => {
    server.use(http.get(SELLER, () => new HttpResponse(null, { status: 402 })));
    const [event] = await collect();
    expect(event).toEqual({ type: 'errored', code: 'INVALID_402', message: expect.any(String) as string });
  });

  it('errors NO_INFLOW_MATCH when the 402 carries only unsupported method challenges', async () => {
    server.use(
      http.get(
        SELLER,
        () =>
          new HttpResponse(null, {
            status: 402,
            headers: { 'WWW-Authenticate': renderChallengeHeader(challenge('other')) },
          }),
      ),
    );
    const [event] = await collect();
    expect(event?.type).toBe('errored');
    if (event?.type === 'errored') expect(event.code).toBe('NO_INFLOW_MATCH');
  });

  it('errors INSPECT_FAILED when the probe itself throws (network error)', async () => {
    server.use(http.get(SELLER, () => HttpResponse.error()));
    const [event] = await collect();
    expect(event?.type).toBe('errored');
    if (event?.type === 'errored') expect(event.code).toBe('INSPECT_FAILED');
  });

  it('emits blocked when AEP authentication is required before MPP inspection', async () => {
    const [event] = await collect({
      probe: () =>
        Promise.reject(
          new PaymentInspectionBlockedError({
            method: 'GET',
            url: SELLER,
            message: 'AEP authentication is required before payment terms can be inspected.',
            source: 'challenge',
            serviceDid: 'did:web:seller.test',
            serviceUrl: 'https://seller.test',
          }),
        ),
    });
    expect(event).toEqual({
      type: 'blocked',
      result: {
        method: 'GET',
        url: SELLER,
        message: 'AEP authentication is required before payment terms can be inspected.',
        source: 'challenge',
        serviceDid: 'did:web:seller.test',
        serviceUrl: 'https://seller.test',
      },
    });
  });

  it('errors UNEXPECTED_PROBE_STATUS when the seller returns a non-2xx, non-402 status', async () => {
    server.use(http.get(SELLER, () => new HttpResponse('boom', { status: 500 })));
    const [event] = await collect();
    expect(event?.type).toBe('errored');
    if (event?.type === 'errored') expect(event.code).toBe('UNEXPECTED_PROBE_STATUS');
  });

  it('errors DECODE_FAILED when a 402 carries a malformed Payment challenge header', async () => {
    // Starts with the `Payment` scheme so it reaches the parser, but is missing the required auth-params.
    server.use(
      http.get(
        SELLER,
        () => new HttpResponse(null, { status: 402, headers: { 'WWW-Authenticate': 'Payment realm="mpp.test"' } }),
      ),
    );
    const [event] = await collect();
    expect(event?.type).toBe('errored');
    if (event?.type === 'errored') expect(event.code).toBe('DECODE_FAILED');
  });
});

describe('reduceMppInspect', () => {
  const challengesResult: MppInspectResultChallenges = {
    outcome: 'challenges',
    url: SELLER,
    method: 'GET',
    realm: 'mpp.test',
    challenges: [],
  };
  const noPaymentResult: MppInspectResultNoPayment = {
    outcome: 'no-payment-required',
    url: SELLER,
    method: 'GET',
    status: 200,
    contentType: 'text/plain',
    bodySizeBytes: 4,
  };

  it('challenges event transitions to the challenges phase', () => {
    const next = reduceMppInspect({ kind: 'probing' }, { type: 'challenges', result: challengesResult });
    expect(next).toEqual({ kind: 'challenges', result: challengesResult });
  });

  it('no-payment event transitions to the no-payment phase', () => {
    const next = reduceMppInspect({ kind: 'probing' }, { type: 'no-payment', result: noPaymentResult });
    expect(next).toEqual({ kind: 'no-payment', result: noPaymentResult });
  });

  it('errored event transitions to the error phase', () => {
    const next = reduceMppInspect({ kind: 'probing' }, { type: 'errored', code: 'INVALID_402', message: 'no header' });
    expect(next).toEqual({ kind: 'error', code: 'INVALID_402', message: 'no header' });
  });

  it('blocked event transitions to the blocked phase', () => {
    const blocked = {
      method: 'GET',
      url: SELLER,
      message: 'AEP authentication is required before payment terms can be inspected.',
      source: 'openapi' as const,
    };
    const next = reduceMppInspect({ kind: 'probing' }, { type: 'blocked', result: blocked });
    expect(next).toEqual({ kind: 'blocked', result: blocked });
  });

  it('returns the prior state for an unrecognised event (default branch)', () => {
    const prior = { kind: 'probing' } as const;
    expect(reduceMppInspect(prior, { type: 'bogus' } as never)).toBe(prior);
  });
});
