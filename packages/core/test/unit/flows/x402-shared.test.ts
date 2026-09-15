import type { PaymentRequired } from '@x402/core/types';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { describe, expect, it } from 'vitest';
import {
  buildNoFilteredMatchMessage,
  excludePermit2Accepts,
  filterAccepts,
  isSuccessStatus,
} from '../../../src/flows/x402-shared.js';

const sample: PaymentRequired = {
  x402Version: 2,
  resource: { url: 'https://seller/api' },
  accepts: [
    {
      scheme: 'balance',
      network: 'inflow:1',
      payTo: '0x0',
      maxAmountRequired: '0',
      maxTimeoutSeconds: 300,
      asset: '',
      amount: '',
      // Real balance rows advertise the symbol under `extra.assetName` and carry no `extra.name`.
      extra: { assetName: 'USDC' },
    },
    {
      scheme: 'exact',
      network: 'base',
      payTo: '0x0',
      maxAmountRequired: '0',
      maxTimeoutSeconds: 300,
      asset: '0xUSDC',
      amount: '1.50',
      // Exact rows carry both: the symbol (`assetName`) and the EIP-712 domain / on-chain name (`name`).
      extra: { assetName: 'PYUSD', name: 'PayPal USD' },
    },
  ],
} as unknown as PaymentRequired;

describe('excludePermit2Accepts', () => {
  const exact = {
    scheme: 'exact',
    network: 'eip155:8453',
    payTo: '0xpayee',
    maxTimeoutSeconds: 60,
    asset: '0xasset',
    amount: '100',
    extra: {},
  } satisfies PaymentRequired['accepts'][number];

  it.each([undefined, null])('preserves an offer whose decoded extras are %s', (extra) => {
    const decoded = decodePaymentRequiredHeader(
      Buffer.from(JSON.stringify({ ...sample, accepts: [{ ...exact, extra }] })).toString('base64'),
    );
    expect(excludePermit2Accepts(decoded)).toEqual(decoded);
  });

  it('drops exact Permit2 and upto offers while preserving other offers and signing context', () => {
    const retained: PaymentRequired['accepts'] = [
      exact,
      { ...exact, extra: { assetTransferMethod: 'eip3009', permit2Proxy: 'irrelevant' } },
      { ...exact, network: 'solana:devnet', extra: { assetTransferMethod: 'solana' } },
      ...sample.accepts,
    ];
    const decoded: PaymentRequired = {
      ...sample,
      accepts: [
        { ...exact, extra: { assetTransferMethod: 'permit2' } },
        ...retained,
        { ...exact, scheme: 'upto' },
        { ...exact, scheme: 'upto', extra: { assetTransferMethod: 'permit2' } },
      ],
      extensions: { retained: true },
      error: 'Payment required',
    };
    const out = excludePermit2Accepts(decoded);
    expect(out).toEqual({ ...decoded, accepts: retained });
    expect(out.resource).toBe(decoded.resource);
    expect(out.extensions).toBe(decoded.extensions);
    expect(out.accepts[0]).toBe(exact);
    expect(decoded.accepts).toHaveLength(retained.length + 3);
  });

  it('leaves no available option when every offer requires Permit2', () => {
    const decoded = excludePermit2Accepts({ ...sample, accepts: [{ ...exact, scheme: 'upto' }] });
    expect(decoded.accepts).toEqual([]);
    expect(filterAccepts(decoded, { scheme: 'upto' }).accepts).toEqual([]);
    expect(buildNoFilteredMatchMessage(decoded, { scheme: 'exact' })).toContain('Available: (none)');
  });
});

describe('filterAccepts', () => {
  it('returns the input unchanged when no filter is set', () => {
    expect(filterAccepts(sample, {})).toBe(sample);
  });

  it('filters by scheme', () => {
    const out = filterAccepts(sample, { scheme: 'balance' });
    expect(out.accepts).toHaveLength(1);
    expect(out.accepts[0]?.scheme).toBe('balance');
  });

  it('filters by network', () => {
    const out = filterAccepts(sample, { network: 'base' });
    expect(out.accepts).toHaveLength(1);
    expect(out.accepts[0]?.network).toBe('base');
  });

  it('filters by asset', () => {
    const out = filterAccepts(sample, { asset: '0xUSDC' });
    expect(out.accepts).toHaveLength(1);
    expect(out.accepts[0]?.asset).toBe('0xUSDC');
  });

  it('filters by assetName against extra.assetName — matches the balance row that has no extra.name', () => {
    const out = filterAccepts(sample, { assetName: 'USDC' });
    expect(out.accepts).toHaveLength(1);
    expect(out.accepts[0]?.scheme).toBe('balance');
  });

  it('does not match against extra.name (the EIP-712 domain name)', () => {
    // 'PayPal USD' is the exact row's extra.name; filtering by assetName must NOT match it.
    expect(filterAccepts(sample, { assetName: 'PayPal USD' }).accepts).toHaveLength(0);
  });

  it('filters by both scheme and network', () => {
    expect(filterAccepts(sample, { scheme: 'balance', network: 'base' }).accepts).toHaveLength(0);
    expect(filterAccepts(sample, { scheme: 'balance', network: 'inflow:1' }).accepts).toHaveLength(1);
  });

  it('AND-combines all four filters', () => {
    const out = filterAccepts(sample, {
      scheme: 'exact',
      network: 'base',
      asset: '0xUSDC',
      assetName: 'PYUSD',
    });
    expect(out.accepts).toHaveLength(1);
  });

  it('preserves non-accepts fields verbatim', () => {
    const out = filterAccepts(sample, { scheme: 'balance' });
    expect(out.x402Version).toBe(2);
    expect(out.resource).toEqual({ url: 'https://seller/api' });
  });
});

describe('buildNoFilteredMatchMessage', () => {
  it('includes scheme + network filter description and available pairs', () => {
    const msg = buildNoFilteredMatchMessage(sample, { scheme: 'invalid', network: 'inflow:1' });
    expect(msg).toContain('--scheme=invalid');
    expect(msg).toContain('--network=inflow:1');
    expect(msg).toContain('balance/inflow:1');
    expect(msg).toContain('exact/base');
  });

  it('includes --asset and --asset-name in the filter description when set', () => {
    const msg = buildNoFilteredMatchMessage(sample, { asset: '0xMISSING', assetName: 'PYUSD' });
    expect(msg).toContain('--asset=0xMISSING');
    expect(msg).toContain('--asset-name=PYUSD');
    expect(msg).toContain('asset=0xUSDC');
    expect(msg).toContain('assetName=USDC');
  });

  it('falls back to "(none)" when the seller advertises no accepts', () => {
    const empty = { ...sample, accepts: [] } as unknown as PaymentRequired;
    const msg = buildNoFilteredMatchMessage(empty, { scheme: 'balance' });
    expect(msg).toContain('Available: (none)');
  });
});

describe('isSuccessStatus', () => {
  it('returns true for 2xx', () => {
    expect(isSuccessStatus(200)).toBe(true);
    expect(isSuccessStatus(299)).toBe(true);
  });
  it('returns false outside 2xx', () => {
    expect(isSuccessStatus(199)).toBe(false);
    expect(isSuccessStatus(300)).toBe(false);
    expect(isSuccessStatus(402)).toBe(false);
  });
});
