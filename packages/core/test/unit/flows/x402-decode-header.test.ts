import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { describe, expect, it } from 'vitest';
import { decodeHeader } from '../../../src/flows/x402-decode.js';

const ACCEPTS = [
  {
    scheme: 'balance',
    network: 'inflow:1',
    asset: '',
    amount: '10',
    payTo: 'acct_1',
    maxTimeoutSeconds: 60,
    extra: { assetName: 'USDC' },
  },
];

describe('decodeHeader', () => {
  it('decodes a minimal PAYMENT-REQUIRED header and omits absent optional fields', () => {
    const raw = encodePaymentRequiredHeader({
      x402Version: 2,
      resource: { url: 'https://seller.test/api', method: 'GET' },
      accepts: ACCEPTS,
    } as unknown as PaymentRequired);
    const out = decodeHeader(raw);
    expect(out.x402Version).toBe(2);
    expect(out.resource).toEqual({ url: 'https://seller.test/api', method: 'GET' });
    expect(out.accepts).toHaveLength(1);
    expect(out.accepts[0]).toMatchObject({ scheme: 'balance', network: 'inflow:1' });
    expect(out).not.toHaveProperty('extensions');
    expect(out).not.toHaveProperty('error');
  });

  it('carries extensions and error through when the header includes them', () => {
    const raw = encodePaymentRequiredHeader({
      x402Version: 2,
      resource: { url: 'https://seller.test/api', method: 'GET' },
      accepts: ACCEPTS,
      extensions: { foo: 'bar' },
      error: 'try-again',
    } as unknown as PaymentRequired);
    const out = decodeHeader(raw);
    expect(out.extensions).toEqual({ foo: 'bar' });
    expect(out.error).toBe('try-again');
  });

  it('throws on a malformed header value', () => {
    expect(() => decodeHeader('%%%not-a-header%%%')).toThrow();
  });
});
