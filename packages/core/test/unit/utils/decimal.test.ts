import { describe, expect, it } from 'vitest';

import { normalizeDecimalString } from '../../../src/utils/decimal.js';

describe('normalizeDecimalString', () => {
  it('strips trailing fractional zeros without precision loss', () => {
    expect(normalizeDecimalString('100.500000000000000000')).toBe('100.5');
    expect(normalizeDecimalString('0.010000000000000000')).toBe('0.01');
    expect(normalizeDecimalString('0.000001000000000000')).toBe('0.000001');
  });

  it('collapses whole-number decimals and negative zero', () => {
    expect(normalizeDecimalString('00042')).toBe('42');
    expect(normalizeDecimalString('42.000')).toBe('42');
    expect(normalizeDecimalString('00042.000')).toBe('42');
    expect(normalizeDecimalString('-0.000')).toBe('0');
  });

  it('preserves the sign on non-zero negative decimals', () => {
    expect(normalizeDecimalString('-0012.3400')).toBe('-12.34');
  });

  it('leaves non-plain decimal strings untouched', () => {
    expect(normalizeDecimalString('1e-6')).toBe('1e-6');
    expect(normalizeDecimalString('1,000.00')).toBe('1,000.00');
  });
});
