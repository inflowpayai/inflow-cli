import { encode, type MppChallenge } from '@inflowpayai/mpp';
import type { SellerProbeOptions } from '@inflowpayai/x402-buyer/probe';
import { describe, expect, it } from 'vitest';
import {
  buildNoFilteredMatchMessage,
  DEFAULT_ACCEPT_PAYMENT_HEADER,
  filterChallenges,
  filterPayableChallenges,
  hasAnyChallengeFilter,
  isSuccessStatus,
  resolveAcceptPaymentProbeOptions,
} from '../../../src/flows/mpp-shared.js';

function challenge(method: string): MppChallenge {
  return { id: `id-${method}`, realm: 'mpp.test', method, intent: 'charge', request: 'eyJ9' };
}

function decodableChallenge(over: {
  id?: string;
  method?: string;
  intent?: string;
  currency?: string;
  rail?: string;
}): MppChallenge {
  return {
    id: over.id ?? 'c',
    realm: 'mpp.test',
    method: over.method ?? 'inflow',
    intent: over.intent ?? 'charge',
    request: encode({
      amount: '10',
      currency: over.currency ?? 'USDC',
      methodDetails: { rail: over.rail ?? 'balance' },
    }),
  };
}

const usdcBalance = decodableChallenge({ id: 'a', currency: 'USDC', rail: 'balance' });
const pyusdInstrument = decodableChallenge({ id: 'b', currency: 'PYUSD', rail: 'instrument' });
const sample = [usdcBalance, pyusdInstrument];

describe('isSuccessStatus', () => {
  it('is true for 2xx and false otherwise', () => {
    expect(isSuccessStatus(200)).toBe(true);
    expect(isSuccessStatus(204)).toBe(true);
    expect(isSuccessStatus(299)).toBe(true);
    expect(isSuccessStatus(402)).toBe(false);
    expect(isSuccessStatus(500)).toBe(false);
    expect(isSuccessStatus(199)).toBe(false);
  });
});

describe('filterPayableChallenges', () => {
  it('keeps supported MPP method challenges', () => {
    const out = filterPayableChallenges([challenge('inflow'), challenge('other'), challenge('tempo')]);
    expect(out.map((c) => c.method)).toEqual(['inflow', 'tempo']);
  });

  it('returns empty when no supported challenge method is present', () => {
    expect(filterPayableChallenges([challenge('other')])).toEqual([]);
  });
});

describe('filterChallenges', () => {
  it('returns the input unchanged when no filter is set', () => {
    expect(filterChallenges(sample, {})).toEqual(sample);
  });

  it('filters by paymentMethod', () => {
    expect(filterChallenges(sample, { paymentMethod: 'inflow' })).toHaveLength(2);
    expect(filterChallenges(sample, { paymentMethod: 'other' })).toHaveLength(0);
  });

  it('filters by intent', () => {
    expect(filterChallenges(sample, { intent: 'charge' })).toHaveLength(2);
    expect(filterChallenges(sample, { intent: 'refund' })).toHaveLength(0);
  });

  it('filters by currency (from the decoded request)', () => {
    const out = filterChallenges(sample, { currency: 'USDC' });
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('a');
  });

  it('filters by rail (from the decoded request)', () => {
    const out = filterChallenges(sample, { rail: 'instrument' });
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('b');
  });

  it('AND-combines all four filters', () => {
    const out = filterChallenges(sample, {
      paymentMethod: 'inflow',
      intent: 'charge',
      currency: 'USDC',
      rail: 'balance',
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('a');
  });

  it('returns empty when a currency filter matches no challenge', () => {
    expect(filterChallenges(sample, { currency: 'EURC' })).toHaveLength(0);
  });
});

describe('hasAnyChallengeFilter', () => {
  it('is false for an empty filter set and true otherwise', () => {
    expect(hasAnyChallengeFilter({})).toBe(false);
    expect(hasAnyChallengeFilter({ rail: 'balance' })).toBe(true);
  });
});

describe('resolveAcceptPaymentProbeOptions', () => {
  const baseOptions = (headers: Record<string, string>): SellerProbeOptions => ({ method: 'GET', headers });

  it('injects the default Accept-Payment pair list when none is supplied', () => {
    const options = baseOptions({});
    const out = resolveAcceptPaymentProbeOptions(options);
    expect(out).toEqual({ method: 'GET', headers: { 'Accept-Payment': DEFAULT_ACCEPT_PAYMENT_HEADER } });
    expect(out.headers).not.toBe(options.headers);
  });

  it('preserves caller-supplied Accept-Payment regardless of header casing', () => {
    const out = resolveAcceptPaymentProbeOptions(baseOptions({ 'acCePt-PaYmEnT': 'tempo/charge' }));
    expect(out).toEqual({ method: 'GET', headers: { 'acCePt-PaYmEnT': 'tempo/charge' } });
  });

  it('uses the last caller-supplied Accept-Payment value when header casing differs', () => {
    const out = resolveAcceptPaymentProbeOptions(
      baseOptions({ 'Accept-Payment': 'inflow/charge', existing: 'value', 'accept-payment': 'tempo/charge;q=0.8' }),
    );
    expect(out).toEqual({
      method: 'GET',
      headers: { existing: 'value', 'accept-payment': 'tempo/charge;q=0.8' },
    });
  });

  it('narrows using either a method or intent filter', () => {
    const outByMethod = resolveAcceptPaymentProbeOptions(baseOptions({}), { paymentMethod: 'inflow' });
    const outByIntent = resolveAcceptPaymentProbeOptions(baseOptions({}), { intent: 'charge' });
    expect(outByMethod.headers['Accept-Payment']).toBe('inflow/charge');
    expect(outByIntent.headers['Accept-Payment']).toBe(DEFAULT_ACCEPT_PAYMENT_HEADER);
  });

  it('narrows to a safe supported pair when both payment method and intent are provided', () => {
    const out = resolveAcceptPaymentProbeOptions(baseOptions({}), { paymentMethod: 'tempo', intent: 'charge' });
    expect(out.headers['Accept-Payment']).toBe('tempo/charge');
  });

  it('falls back to default pairs when the requested filter pair is unsupported', () => {
    const out = resolveAcceptPaymentProbeOptions(baseOptions({}), { paymentMethod: 'inflow', intent: 'refund' });
    expect(out.headers['Accept-Payment']).toBe(DEFAULT_ACCEPT_PAYMENT_HEADER);
  });

  it('does not mutate the caller object', () => {
    const headers = { existing: 'value' };
    const options: SellerProbeOptions = { method: 'GET', headers };
    const out = resolveAcceptPaymentProbeOptions(options);
    expect(options).toEqual({ method: 'GET', headers: { existing: 'value' } });
    expect(out.headers).not.toBe(headers);
  });
});

describe('buildNoFilteredMatchMessage', () => {
  it('lists the filter description and the available method/intent/currency/rail tuples', () => {
    const msg = buildNoFilteredMatchMessage(sample, { currency: 'EURC', rail: 'balance' });
    expect(msg).toContain('--currency=EURC');
    expect(msg).toContain('--rail=balance');
    expect(msg).toContain('inflow/charge currency=USDC rail=balance');
    expect(msg).toContain('currency=PYUSD rail=instrument');
  });

  it('falls back to "(none)" when there are no challenges', () => {
    expect(buildNoFilteredMatchMessage([], { currency: 'USDC' })).toContain('Available: (none)');
  });
});
