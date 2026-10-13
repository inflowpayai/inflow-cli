import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Inflow } from '../../src/index.js';
import { BASE_URL } from './fixtures/handlers.js';
import { makeServer } from './fixtures/server.js';

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('CLI-owned x402 buyer controls', () => {
  describe.each([undefined, 'instrument-id'])('instrument %s', (instrumentId) => {
    it.each([false, true])('allows a $25 payment with a foundation-recognized token: %s', async (recognized) => {
      server.use(http.get(`${BASE_URL}/v1/transactions/x402-supported`, () => HttpResponse.json({ kinds: [] })));
      const inflow = new Inflow({ apiKey: 'local-test-key', apiBaseUrl: BASE_URL });
      const client = await inflow.x402.client(instrumentId === undefined ? undefined : { instrumentId });
      client.register('eip155:5042', {
        scheme: 'exact',
        findDefaultAsset: (asset) => (recognized ? { asset, decimals: 6, symbol: 'USDC' } : undefined),
        createPaymentPayload: () => Promise.resolve({ x402Version: 2, payload: { marker: 'external-scheme' } }),
      });
      const accepted = {
        scheme: 'exact',
        network: 'eip155:5042' as const,
        asset: '0x3600000000000000000000000000000000000000',
        amount: '25000000',
        payTo: '0x2222222222222222222222222222222222222222',
        maxTimeoutSeconds: 300,
        extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' },
      };
      const payment = await client.createPaymentPayload({
        x402Version: 2,
        resource: { url: 'https://seller.example/report' },
        accepts: [accepted],
      });
      expect(payment.accepted).toEqual(accepted);
      expect(payment.payload).toEqual({ marker: 'external-scheme' });
    });
  });
});
