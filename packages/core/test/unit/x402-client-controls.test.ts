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
  it.each([
    ['eip155:5042', 'eip155:5042002'],
    ['eip155:5042002', 'eip155:5042'],
    ['eip155:143', 'eip155:10143'],
    ['eip155:10143', 'eip155:143'],
  ] as const)('does not match %s when the server only supports %s', async (network, supportedNetwork) => {
    server.use(
      http.get(`${BASE_URL}/v1/transactions/x402-supported`, () =>
        HttpResponse.json({
          kinds: [{ scheme: 'exact', network: supportedNetwork, x402Version: 2 }],
        }),
      ),
    );
    const client = await new Inflow({ apiKey: 'local-test-key', apiBaseUrl: BASE_URL }).x402.client();
    const accept = {
      scheme: 'exact',
      network,
      amount: '25000000',
      asset: network.startsWith('eip155:504')
        ? '0x3600000000000000000000000000000000000000'
        : network === 'eip155:143'
          ? '0x754704bc059f8c67012fed69bc8a327a5aafb603'
          : '0x534b2f3a21130d7a60830c2df862319e593943a3',
      payTo: '0x2222222222222222222222222222222222222222',
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' },
    };
    const required = { x402Version: 2, resource: { url: 'https://seller.example/report' }, accepts: [accept] };
    const snapshot = structuredClone(required);
    await expect(client.selectInflowRequirement(required)).resolves.toBeNull();
    await expect(client.prepareInflowPayment(accept, required)).rejects.toThrow();
    expect(required).toEqual(snapshot);
  });

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
