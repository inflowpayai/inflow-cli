import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode, type MppClient } from '@inflowpayai/mpp';
import { encodePaymentResponseHeader } from '@x402/core/http';
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
  it.each([undefined, false, true])(
    'preserves authentication retryability (%s) without retrying a payment',
    async (retryable) => {
      const request = vi
        .fn()
        .mockRejectedValue(new SellerAuthenticationError('AEP_AUTH_FAILED', 'Authentication failed.', retryable));
      const input = {
        transactionId: 'tx-auth',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 1,
        timeout: 30,
        showBody: false,
        sellerTransport: { request },
      };
      const expected = {
        type: 'errored',
        code: 'AEP_AUTH_FAILED',
        message: 'Authentication failed.',
        ...(retryable === undefined ? {} : { retryable }),
      };
      const mppEvents = await drain(
        runMppFetch({
          ...input,
          client: mppClient({ state: 'ready', transactionId: input.transactionId, credential: 'opaque' }),
        }).events,
      );
      expect(mppEvents.at(-1)).toEqual(expected);
      expect(request).toHaveBeenCalledOnce();
      request.mockClear();
      const x402Events = await drain(
        runX402Fetch({
          ...input,
          client: x402Client({
            status: 'APPROVED',
            encodedPayload: 'opaque',
            paymentPayload: {
              x402Version: 2,
              payload: {},
              accepted: {
                scheme: 'exact',
                network: 'eip155:8453',
                asset: 'USDC',
                amount: '1000',
                payTo: 'seller',
                maxTimeoutSeconds: 60,
              },
            },
          }),
        }).events,
      );
      expect(x402Events.at(-1)).toEqual(expected);
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it.each(['mpp', 'x402'] as const)(
    'preserves %s binary responses, saved output, and settlement receipts',
    async (protocol) => {
      const directory = await mkdtemp(join(tmpdir(), 'inflow-fetch-response-'));
      const bytes = new Uint8Array([0, 255, 128, 3]);
      const receipt =
        protocol === 'mpp'
          ? {
              'Payment-Receipt': encode({
                method: 'inflow',
                reference: 'receipt-one',
                status: 'success',
                timestamp: '2026-01-01T00:00:00Z',
                settlement: { amount: '10', currency: 'USD' },
              }),
            }
          : {
              'PAYMENT-RESPONSE': encodePaymentResponseHeader({
                success: true,
                network: 'eip155:8453',
                transaction: '0xsettled',
              }),
            };
      try {
        for (const saved of [false, true]) {
          const outputFile = join(directory, `${protocol}.bin`);
          const request = vi.fn().mockResolvedValue({
            status: 200,
            headers: new Headers({ ...receipt, 'Content-Type': 'application/octet-stream' }),
            bytes,
          });
          const input = {
            transactionId: 'tx-one',
            url: 'https://seller.test/api',
            probeOptions: { method: 'POST', headers: {}, data: 'original-body' },
            interval: 0,
            maxAttempts: 1,
            timeout: 30,
            showBody: true,
            sellerTransport: { request },
            ...(saved ? { outputFile } : {}),
          };
          const events =
            protocol === 'mpp'
              ? await drain(
                  runMppFetch({
                    ...input,
                    client: mppClient({ transactionId: 'tx-one', state: 'ready', credential: 'opaque' }),
                  }).events,
                )
              : await drain(
                  runX402Fetch({
                    ...input,
                    client: x402Client({
                      status: 'SETTLED',
                      encodedPayload: 'opaque',
                      paymentPayload: {
                        x402Version: 2,
                        accepted: {
                          scheme: 'balance',
                          network: 'inflow:1',
                          amount: '10',
                          asset: 'USD',
                          payTo: 'seller',
                          maxTimeoutSeconds: 60,
                        },
                        payload: {},
                      },
                    }),
                  }).events,
                );
          expect(events.at(-1)).toMatchObject({
            type: 'replayed',
            result: {
              outcome: 'paid',
              bodySizeBytes: bytes.length,
              ...(saved ? { outputSavedTo: outputFile } : { bodyBase64: Buffer.from(bytes).toString('base64') }),
              settled:
                protocol === 'mpp'
                  ? { reference: 'receipt-one', status: 'success' }
                  : { network: 'eip155:8453', transaction: '0xsettled' },
            },
          });
          expect(request).toHaveBeenCalledOnce();
          if (saved) {
            expect(await readFile(outputFile)).toEqual(Buffer.from(bytes));
            expect(events.at(-1)).not.toHaveProperty('result.bodyBase64');
          }
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(['mpp', 'x402'] as const)(
    'stops %s polling without seller replay when the wait is cancelled',
    async (protocol) => {
      const controller = new AbortController();
      const sellerTransport = { request: vi.fn() };
      const mpp = mppClient({ transactionId: 'tx-1', state: 'pending' });
      const x402 = x402Client({ status: 'INITIATED' });
      const getTransaction = vi.spyOn(mpp, 'getTransaction');
      const getPayload = vi.spyOn(x402, 'getX402Payload');
      getTransaction.mockImplementation(() => {
        controller.abort();
        return Promise.resolve({ transactionId: 'tx-1', state: 'pending' });
      });
      getPayload.mockImplementation(() => {
        controller.abort();
        return Promise.resolve({ status: 'INITIATED' });
      });
      const input = {
        transactionId: 'tx-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 1,
        maxAttempts: 0,
        timeout: 30,
        showBody: false,
        signal: controller.signal,
        sellerTransport,
      };
      const events =
        protocol === 'mpp'
          ? await drain(runMppFetch({ ...input, client: mpp }).events)
          : await drain(runX402Fetch({ ...input, client: x402 }).events);
      expect(events).toEqual([{ type: 'errored', code: 'PAYMENT_FAILED', message: 'Poll aborted.' }]);
      expect(getTransaction).toHaveBeenCalledTimes(protocol === 'mpp' ? 1 : 0);
      expect(getPayload).toHaveBeenCalledTimes(protocol === 'x402' ? 1 : 0);
      expect(sellerTransport.request).not.toHaveBeenCalled();
    },
  );

  it('replays an explicitly supplied MPP credential without retrieving or creating a transaction', async () => {
    const client = mppClient({ transactionId: 'tx-1', state: 'pending' });
    const getTransaction = vi.spyOn(client, 'getTransaction');
    const createTransaction = vi.spyOn(client, 'createTransaction');
    const request = vi.fn().mockResolvedValue({ status: 200, headers: new Headers(), bytes: new Uint8Array() });
    const events = await drain(
      runMppFetch({
        client,
        credential: 'opaque',
        transactionId: 'tx-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 1,
        timeout: 30,
        showBody: false,
        sellerTransport: { request },
      }).events,
    );
    expect(events.at(-1)).toMatchObject({ type: 'replayed', result: { outcome: 'paid', transactionId: 'tx-1' } });
    expect(getTransaction).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      additionalAuthenticationHeaders: { Authorization: 'Payment opaque' },
    });
  });

  it.each([
    { state: 'failed' as const, problem: undefined, code: 'PAYMENT_FAILED', message: 'MPP transaction failed.' },
    {
      state: 'failed' as const,
      problem: { title: 'Declined', detail: 'Payment was declined.', status: 400, type: 'about:blank' },
      code: 'PAYMENT_FAILED',
      message: 'Payment was declined.',
    },
    {
      state: 'expired' as const,
      problem: undefined,
      code: 'PAYMENT_EXPIRED',
      message: 'MPP transaction expired before it was ready.',
    },
  ])('stops MPP polling on $state with $message without replaying', async ({ state, problem, code, message }) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = mppClient({ transactionId: 'tx-1', state, ...(problem === undefined ? {} : { problem }) });
    const getTransaction = vi.spyOn(client, 'getTransaction');
    const events = await drain(
      runMppFetch({
        client,
        transactionId: 'tx-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0.001,
        maxAttempts: 2,
        timeout: 30,
        showBody: false,
        signal: new AbortController().signal,
      }).events,
    );
    expect(events).toEqual([{ type: 'errored', code, message }]);
    expect(getTransaction).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['EXPIRED', 'DECLINED', 'GENERAL_ERROR', 'INSUFFICIENT_FUNDS'] as const)(
    'stops x402 polling on %s without sending a seller request',
    async (status) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const client = x402Client({ status });
      const getPayload = vi.spyOn(client, 'getX402Payload');
      const events = await drain(
        runX402Fetch({
          client,
          transactionId: 'tx-1',
          url: 'https://seller.test/api',
          probeOptions: { method: 'GET', headers: {} },
          interval: 0.001,
          maxAttempts: 2,
          timeout: 30,
          showBody: false,
          signal: new AbortController().signal,
        }).events,
      );
      expect(events).toEqual([
        {
          type: 'errored',
          code:
            status === 'EXPIRED'
              ? 'APPROVAL_TIMEOUT'
              : status === 'GENERAL_ERROR' || status === 'INSUFFICIENT_FUNDS'
                ? 'APPROVAL_FAILED'
                : 'APPROVAL_CANCELLED',
          message:
            status === 'EXPIRED'
              ? 'Transaction tx-1 expired before a signed payload was available.'
              : `Transaction tx-1 terminated as ${status} with no payload.`,
        },
      ]);
      expect(getPayload).toHaveBeenCalledOnce();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('reports x402 polling exhaustion without replaying a pending payment', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const events = await drain(
      runX402Fetch({
        client: x402Client({ status: 'PENDING' }),
        transactionId: 'tx-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0.001,
        maxAttempts: 1,
        timeout: 30,
        showBody: false,
      }).events,
    );
    expect(events).toEqual([
      {
        type: 'errored',
        code: 'POLLING_TIMEOUT',
        message: 'Polling timed out before the transaction reached a signed state.',
        retryable: true,
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([new Error('disconnected'), 'disconnected'])(
    'reports MPP polling failure without replaying: %s',
    async (error) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const client = mppClient({ transactionId: 'tx-1', state: 'pending' });
      vi.spyOn(client, 'getTransaction').mockRejectedValue(error);
      const events = await drain(
        runMppFetch({
          client,
          transactionId: 'tx-1',
          url: 'https://seller.test/api',
          probeOptions: { method: 'GET', headers: {} },
          interval: 0.001,
          maxAttempts: 2,
          timeout: 30,
          showBody: false,
        }).events,
      );
      expect(events).toEqual([{ type: 'errored', code: 'PAYMENT_FAILED', message: 'disconnected' }]);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each([new Error('disconnected'), 'disconnected'])(
    'reports immediate x402 payload failure without replaying: %s',
    async (error) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const client = x402Client({ status: 'PENDING' });
      vi.spyOn(client, 'getX402Payload').mockRejectedValue(error);
      const events = await drain(
        runX402Fetch({
          client,
          transactionId: 'tx-1',
          url: 'https://seller.test/api',
          probeOptions: { method: 'GET', headers: {} },
          interval: 0,
          maxAttempts: 2,
          timeout: 30,
          showBody: false,
        }).events,
      );
      expect(events).toEqual([{ type: 'errored', code: 'PAYMENT_FAILED', message: 'disconnected' }]);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

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
      transactionId: 'tx-1',
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

  it('reports an unknown outcome when an MPP credential-bearing replay transport fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('socket closed'));

    const events = await drain(
      runMppFetch({
        client: mppClient({ transactionId: 'tx-1', state: 'ready', credential: 'CRED' }),
        transactionId: 'tx-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
      }).events,
    );

    expect(events.at(-1)).toMatchObject({ type: 'errored', code: 'PAYMENT_REPLAY_OUTCOME_UNKNOWN' });
  });

  it('does not classify x402 local output-file failure as an unknown seller outcome', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('paid', { status: 200 }));
    const missingDirectory = await mkdtemp(join(tmpdir(), 'missing-x402-fetch-output-'));
    await rm(missingDirectory, { recursive: true });

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
        outputFile: join(missingDirectory, 'response.txt'),
      }).events,
    );

    expect(events.at(-1)).toMatchObject({ type: 'errored', code: 'PAYMENT_FAILED' });
  });

  it('does not classify MPP local output-file failure as an unknown seller outcome', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('paid', { status: 200 }));
    const missingDirectory = await mkdtemp(join(tmpdir(), 'missing-mpp-fetch-output-'));
    await rm(missingDirectory, { recursive: true });

    const events = await drain(
      runMppFetch({
        client: mppClient({ transactionId: 'tx-1', state: 'ready', credential: 'CRED' }),
        transactionId: 'tx-1',
        url: 'https://seller.test/api',
        probeOptions: { method: 'GET', headers: {} },
        interval: 0,
        maxAttempts: 0,
        timeout: 900,
        showBody: false,
        outputFile: join(missingDirectory, 'response.txt'),
      }).events,
    );

    expect(events.at(-1)).toMatchObject({ type: 'errored', code: 'PAYMENT_FAILED' });
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
