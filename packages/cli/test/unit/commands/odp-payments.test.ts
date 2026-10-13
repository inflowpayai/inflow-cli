import { describe, expect, it } from 'vitest';
import { offeringDiscoverOptions } from '../../../src/commands/odp/schema.js';
import { directorySearchOptions, directorySuggestOptions } from '../../../src/commands/directory/schema.js';
import {
  enrollmentProtocolLabel,
  normalizePaymentFilters,
  paymentOptionLabel,
  paymentProtocolLabel,
} from '../../../src/commands/odp/payments.js';

describe('ODP payment filters', () => {
  it('accepts protocol and protocol-option syntax', () => {
    expect(directorySearchOptions.parse({ payment: ['mpp', 'x402:base'] }).payment).toEqual(['mpp', 'x402:base']);
    expect(offeringDiscoverOptions.parse({ payment: ['mpp:solana'] }).payment).toEqual(['mpp:solana']);
  });

  it('rejects unknown protocols and options', () => {
    expect(directorySearchOptions.safeParse({ payment: ['future'] }).success).toBe(false);
    expect(directorySearchOptions.safeParse({ payment: ['mpp:future'] }).success).toBe(false);
    expect(directorySearchOptions.safeParse({ payment: ['mpp:Solana'] }).success).toBe(false);
  });

  it.each(['arc', 'monad'] as const)('accepts and labels %s across discovery commands', (option) => {
    const payment = [`x402:${option}`];
    for (const schema of [directorySearchOptions, directorySuggestOptions, offeringDiscoverOptions]) {
      expect(schema.parse({ payment }).payment).toEqual(payment);
    }
    expect(normalizePaymentFilters([`x402:${option}`])).toEqual([{ name: 'x402', options: [option] }]);
    expect(paymentProtocolLabel({ name: 'x402', options: [option] })).toBe(
      option === 'arc' ? 'x402: Arc' : 'x402: Monad',
    );
  });

  it('groups option alternatives and lets a broad protocol filter subsume them', () => {
    expect(normalizePaymentFilters(['mpp:inflow', 'mpp:solana', 'x402:base'])).toEqual([
      { name: 'mpp', options: ['inflow', 'solana'] },
      { name: 'x402', options: ['base'] },
    ]);
    expect(normalizePaymentFilters(['mpp:solana', 'mpp', 'mpp:tempo'])).toEqual([{ name: 'mpp' }]);
  });

  it('uses human-readable protocol and option labels', () => {
    expect(enrollmentProtocolLabel('aep')).toBe('AEP');
    expect(paymentOptionLabel('inflow')).toBe('InFlow');
    expect(paymentProtocolLabel({ name: 'mpp', options: ['inflow', 'tempo'] })).toBe('MPP: InFlow, Tempo');
  });
});
