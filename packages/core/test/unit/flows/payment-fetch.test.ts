import type { MppClient } from '@inflowpayai/mpp';
import type { InflowClient as X402InflowClient } from '@inflowpayai/x402-buyer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMppFetch, runX402Fetch, SellerAuthenticationError } from '../../../src/index.js';

function mppClient(response: Awaited<ReturnType<MppClient['getTransaction']>>): MppClient {
  return {
    getTransaction: vi.fn(() => Promise.resolve(response)),
    createTransaction: vi.fn(),
    getConfig: vi.fn(),
    getSupported: vi.fn(),
  } as unknown as MppClient;
}

function x402Client(response: Awaited<ReturnType<X402InflowClient['getX402Payload']>>): X402InflowClient {
  return {
    getX402Payload: vi.fn(() => Promise.resolve(response)),
  } as unknown as X402InflowClient;
}

async function drain<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of events) out.push(event);
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe('payment fetch replay safety', () => {
  it('MPP ready fetch sends exactly one credential-bearing seller request and overrides caller Authorization', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('paid', { status: 200, headers: { 'content-type': 'text/plain' } }));

    const events = await drain(
      runMppFetch({
        client: mppClient({ transactionId: 'tx-1', state: 'ready', credential: 'CRED' }),
        transactionId: 'tx-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'POST', headers: { authorization: 'Bearer caller', 'X-Test': 'yes' }, data: '{}' },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: true,
      }).events,
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Payment CRED');
    expect(headers.get('X-Test')).toBe('yes');
    expect(events.at(-1)).toMatchObject({
      type: 'replayed',
      result: { protocol: 'mpp', outcome: 'paid', transactionId: 'tx-1', body: 'paid' },
    });
  });

  it('MPP ready fetch passes payment through the shared transport as additional authentication', async () => {
    const request = vi.fn().mockResolvedValue({
      bytes: new Uint8Array(Buffer.from('paid')),
      contentType: 'text/plain',
      headers: new Headers(),
      status: 200,
    });

    const events = await drain(
      runMppFetch({
        client: mppClient({ transactionId: 'tx-1', state: 'ready', credential: 'CRED' }),
        transactionId: 'tx-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: { Authorization: 'Bearer caller' } },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: true,
        sellerTransport: { request },
      }).events,
    );

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({
      additionalAuthenticationHeaders: { Authorization: 'Payment CRED' },
      headers: {},
      method: 'GET',
      url: 'https://seller.test/api',
    });
    expect(events.at(-1)).toMatchObject({ type: 'replayed', result: { body: 'paid' } });
  });

  it('authentication failures from the shared transport stay distinct from outcome-unknown replay failures', async () => {
    const events = await drain(
      runX402Fetch({
        client: x402Client({
          status: 'APPROVED',
          encodedPayload: 'ENC',
          paymentPayload: { x402Version: 2, accepted: {} as never, payload: {} },
        }),
        transactionId: 'txn-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
        sellerTransport: {
          request: () =>
            Promise.reject(new SellerAuthenticationError('AEP_APPROVAL_DENIED', 'The approval was denied.')),
        },
      }).events,
    );

    expect(events.at(-1)).toEqual({
      type: 'errored',
      code: 'AEP_APPROVAL_DENIED',
      message: 'The approval was denied.',
    });
  });

  it('x402 ready fetch sends exactly one signed seller request and overrides caller PAYMENT-SIGNATURE', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('paid', { status: 200 }));

    const events = await drain(
      runX402Fetch({
        client: x402Client({
          status: 'APPROVED',
          encodedPayload: 'ENC',
          paymentPayload: { x402Version: 2, accepted: {} as never, payload: {} },
        }),
        transactionId: 'txn-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: { 'payment-signature': 'caller' } },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      }).events,
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get('PAYMENT-SIGNATURE')).toBe('ENC');
    expect(events.at(-1)).toMatchObject({
      type: 'replayed',
      result: { protocol: 'x402', outcome: 'paid', transactionId: 'txn-1' },
    });
  });

  it('terminal failures make zero seller requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const mppEvents = await drain(
      runMppFetch({
        client: mppClient({ transactionId: 'tx-1', state: 'expired' }),
        transactionId: 'tx-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      }).events,
    );
    const x402Events = await drain(
      runX402Fetch({
        client: x402Client({ status: 'DECLINED' }),
        transactionId: 'txn-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      }).events,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mppEvents).toEqual([
      { type: 'errored', code: 'PAYMENT_EXPIRED', message: 'MPP transaction expired before it was ready.' },
    ]);
    expect(x402Events).toEqual([
      {
        type: 'errored',
        code: 'APPROVAL_CANCELLED',
        message: 'Transaction txn-1 terminated as DECLINED with no payload.',
      },
    ]);
  });

  it('seller rejection is a protocol result, while transport failure is outcome unknown', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('no', { status: 402 }))
      .mockRejectedValueOnce(new Error('socket closed'));

    const rejected = await drain(
      runMppFetch({
        client: mppClient({ transactionId: 'tx-1', state: 'ready', credential: 'CRED' }),
        transactionId: 'tx-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: true,
      }).events,
    );
    const unknown = await drain(
      runX402Fetch({
        client: x402Client({
          status: 'APPROVED',
          encodedPayload: 'ENC',
          paymentPayload: { x402Version: 2, accepted: {} as never, payload: {} },
        }),
        transactionId: 'txn-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      }).events,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(rejected.at(-1)).toMatchObject({ type: 'rejected', result: { outcome: 'seller-rejected' } });
    expect(unknown.at(-1)).toMatchObject({ type: 'errored', code: 'PAYMENT_REPLAY_OUTCOME_UNKNOWN' });
  });

  it('polls pending transactions to ready before replaying', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('mpp'))
      .mockResolvedValueOnce(new Response('x402'));
    const getTransaction = vi
      .fn()
      .mockResolvedValueOnce({ transactionId: 'tx-1', state: 'pending' })
      .mockResolvedValueOnce({ transactionId: 'tx-1', state: 'ready', credential: 'CRED' });
    const getX402Payload = vi
      .fn()
      .mockResolvedValueOnce({ status: 'INITIATED' })
      .mockResolvedValueOnce({
        status: 'APPROVED',
        encodedPayload: 'ENC',
        paymentPayload: { x402Version: 2, accepted: {} as never, payload: {} },
      });

    const mppEvents = await drain(
      runMppFetch({
        client: {
          getTransaction,
          createTransaction: vi.fn(),
          getConfig: vi.fn(),
          getSupported: vi.fn(),
        } as unknown as MppClient,
        transactionId: 'tx-1',
        url: 'https://seller.test/mpp',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0.01,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      }).events,
    );
    const x402Events = await drain(
      runX402Fetch({
        client: { getX402Payload } as unknown as X402InflowClient,
        transactionId: 'txn-1',
        url: 'https://seller.test/x402',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0.01,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      }).events,
    );

    expect(getTransaction).toHaveBeenCalledTimes(2);
    expect(getX402Payload).toHaveBeenCalledTimes(2);
    expect(mppEvents.at(-1)).toMatchObject({ type: 'replayed', result: { protocol: 'mpp', outcome: 'paid' } });
    expect(x402Events.at(-1)).toMatchObject({ type: 'replayed', result: { protocol: 'x402', outcome: 'paid' } });
  });

  it('rejects ready states that are missing credential material', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const mppEvents = await drain(
      runMppFetch({
        client: mppClient({ transactionId: 'tx-1', state: 'ready' }),
        transactionId: 'tx-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      }).events,
    );
    const x402Events = await drain(
      runX402Fetch({
        client: x402Client({
          status: 'APPROVED',
          paymentPayload: { x402Version: 2, accepted: {} as never, payload: {} },
        }),
        transactionId: 'txn-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      }).events,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mppEvents).toEqual([
      {
        type: 'errored',
        code: 'PAYMENT_CREDENTIAL_MISSING',
        message: 'MPP transaction is ready but did not include a payment credential.',
      },
    ]);
    expect(x402Events).toEqual([
      {
        type: 'errored',
        code: 'PAYMENT_NOT_READY',
        message: 'x402 transaction is still pending. Re-run fetch with --interval to wait for approval.',
        retryable: true,
      },
    ]);
  });

  it('maps every immediate MPP non-ready state without contacting the seller', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const failedWithDetail = await drain(
      runMppFetch({
        client: mppClient({
          transactionId: 'tx-detail',
          state: 'failed',
          problem: { detail: 'The payment was declined.', status: 400, title: 'Declined', type: 'about:blank' },
        }),
        transactionId: 'tx-detail',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      }).events,
    );
    const pending = await drain(
      runMppFetch({
        client: mppClient({ transactionId: 'tx-pending', state: 'pending' }),
        transactionId: 'tx-pending',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      }).events,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(failedWithDetail.at(-1)).toEqual({
      type: 'errored',
      code: 'PAYMENT_FAILED',
      message: 'The payment was declined.',
    });
    expect(pending.at(-1)).toMatchObject({ type: 'errored', code: 'PAYMENT_NOT_READY', retryable: true });
  });

  it('maps immediate x402 terminal statuses and empty signed payloads', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const expired = await drain(
      runX402Fetch({
        client: x402Client({ status: 'EXPIRED' }),
        transactionId: 'txn-expired',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      }).events,
    );
    const failed = await drain(
      runX402Fetch({
        client: x402Client({ status: 'GENERAL_ERROR' }),
        transactionId: 'txn-failed',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      }).events,
    );
    const missing = await drain(
      runX402Fetch({
        client: x402Client({
          status: 'APPROVED',
          encodedPayload: '',
          paymentPayload: { x402Version: 2, accepted: {} as never, payload: {} },
        }),
        transactionId: 'txn-missing',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      }).events,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(expired.at(-1)).toMatchObject({ type: 'errored', code: 'APPROVAL_TIMEOUT' });
    expect(failed.at(-1)).toMatchObject({ type: 'errored', code: 'APPROVAL_FAILED' });
    expect(missing.at(-1)).toMatchObject({ type: 'errored', code: 'PAYMENT_CREDENTIAL_MISSING' });
  });

  it('maps snapshot failures, polling timeouts, and polling crashes without replay', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const crashingMppClient = mppClient({ transactionId: 'unused', state: 'pending' });
    vi.spyOn(crashingMppClient, 'getTransaction').mockRejectedValue(new Error('MPP unavailable'));
    const immediateMppCrash = await drain(
      runMppFetch({
        client: crashingMppClient,
        transactionId: 'tx-crash',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      }).events,
    );
    const pollingMppTimeout = await drain(
      runMppFetch({
        client: mppClient({ transactionId: 'tx-timeout', state: 'pending' }),
        transactionId: 'tx-timeout',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0.001,
        maxAttempts: 1,
        timeout: 900,
        showBody: false,
      }).events,
    );
    const pollingX402Crash = await drain(
      runX402Fetch({
        client: {
          getX402Payload: vi.fn(() => Promise.reject(new Error('x402 unavailable'))),
        } as unknown as X402InflowClient,
        transactionId: 'txn-crash',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0.001,
        maxAttempts: 1,
        timeout: 900,
        showBody: false,
      }).events,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(immediateMppCrash.at(-1)).toEqual({
      type: 'errored',
      code: 'PAYMENT_FAILED',
      message: 'MPP unavailable',
    });
    expect(pollingMppTimeout.at(-1)).toMatchObject({ type: 'errored', code: 'POLLING_TIMEOUT', retryable: true });
    expect(pollingX402Crash.at(-1)).toMatchObject({
      type: 'errored',
      code: 'PAYMENT_FAILED',
      message: 'x402 unavailable',
    });
  });

  it('preserves retryability from MPP authentication failures and reports x402 seller rejection', async () => {
    const mppEvents = await drain(
      runMppFetch({
        client: mppClient({ transactionId: 'tx-1', state: 'ready', credential: 'CRED' }),
        transactionId: 'tx-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
        sellerTransport: {
          request: () =>
            Promise.reject(new SellerAuthenticationError('AEP_LOGIN_PENDING', 'Approval is pending.', true)),
        },
      }).events,
    );
    const x402Events = await drain(
      runX402Fetch({
        client: x402Client({
          status: 'APPROVED',
          encodedPayload: 'ENC',
          paymentPayload: { x402Version: 2, accepted: {} as never, payload: {} },
        }),
        transactionId: 'txn-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'POST', headers: {}, data: '{}' },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: true,
        sellerTransport: {
          request: () =>
            Promise.resolve({
              bytes: Buffer.from('rejected'),
              contentType: 'text/plain',
              headers: new Headers(),
              status: 402,
            }),
        },
      }).events,
    );

    expect(mppEvents.at(-1)).toEqual({
      type: 'errored',
      code: 'AEP_LOGIN_PENDING',
      message: 'Approval is pending.',
      retryable: true,
    });
    expect(x402Events.at(-1)).toMatchObject({
      type: 'rejected',
      result: { outcome: 'replay-rejected', body: 'rejected' },
    });
  });
});
