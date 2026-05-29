import { describe, expect, it } from 'vitest';
import { listOptions } from '../../../../src/commands/deposit-addresses/schema.js';

describe('deposit-addresses listOptions', () => {
  it('accepts an empty object and emits an empty result', () => {
    expect(listOptions.parse({})).toEqual({});
  });

  it('drops unknown keys so callers cannot smuggle implicit flags', () => {
    expect(
      listOptions.parse({
        showUnconfigured: true,
        blockchain: 'SOLANA',
        nested: { a: 1 },
      }),
    ).toEqual({});
  });

  it('refuses non-object inputs', () => {
    expect(() => listOptions.parse('list')).toThrow();
    expect(() => listOptions.parse(null)).toThrow();
    expect(() => listOptions.parse(123)).toThrow();
  });
});
