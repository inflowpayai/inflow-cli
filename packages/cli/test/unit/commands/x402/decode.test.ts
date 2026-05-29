import { fromFoundationRequirements } from '@inflowpayai/x402-buyer';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { describe, expect, it } from 'vitest';
import { decodeHeader, summarizeAccepts } from '../../../../src/commands/x402/decode.js';

function makePaymentRequired(overrides: Partial<PaymentRequired> = {}): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: 'https://seller.example.com/api/widgets',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'balance',
        network: 'inflow:1',
        amount: '500',
        payTo: 'inflow:abc',
        maxTimeoutSeconds: 60,
        asset: 'USDC',
        extra: {},
      },
    ],
    ...overrides,
  };
}

describe('decodeHeader', () => {
  it('decodes a well-formed PAYMENT-REQUIRED header to a structured object', () => {
    const header = encodePaymentRequiredHeader(makePaymentRequired());
    const decoded = decodeHeader(header);
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource.url).toBe('https://seller.example.com/api/widgets');
    expect(decoded.accepts).toHaveLength(1);
    expect(decoded.accepts[0]?.scheme).toBe('balance');
  });

  it('throws when the header is not valid base64', () => {
    expect(() => decodeHeader('not-base64-$$$$')).toThrow();
  });

  it('preserves extensions when present', () => {
    const header = encodePaymentRequiredHeader(
      makePaymentRequired({ extensions: { 'payment-identifier': { required: true } } }),
    );
    const decoded = decodeHeader(header);
    expect(decoded.extensions).toEqual({ 'payment-identifier': { required: true } });
  });
});

describe('summarizeAccepts', () => {
  it('extracts scheme, network, asset, and amount from foundation accepts via the bridge', () => {
    const accepts = fromFoundationRequirements(makePaymentRequired().accepts);
    expect(summarizeAccepts(accepts)).toEqual([
      {
        scheme: 'balance',
        network: 'inflow:1',
        asset: 'USDC',
        amount: '500',
      },
    ]);
  });

  it('omits empty asset and amount', () => {
    const accepts = fromFoundationRequirements(
      makePaymentRequired({
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:8453',
            amount: '',
            payTo: '0x000',
            maxTimeoutSeconds: 60,
            asset: '',
            extra: {},
          },
        ],
      }).accepts,
    );
    expect(summarizeAccepts(accepts)).toEqual([{ scheme: 'exact', network: 'eip155:8453' }]);
  });
});
