import { describe, expect, it } from 'vitest';
import { decodeArgs, inspectOptions, payOptions, statusOptions } from '../../../../src/commands/mpp/schema.js';

describe('mpp schema', () => {
  it('applies pay option defaults', () => {
    const parsed = payOptions.parse({});
    expect(parsed.method).toBe('GET');
    expect(parsed.interval).toBe(0);
    expect(parsed.timeout).toBe(900);
    expect(parsed.showBody).toBe(true);
    expect(parsed.header).toEqual([]);
  });

  it('coerces numeric pay options from strings', () => {
    const parsed = payOptions.parse({ interval: '5', maxAttempts: '60', timeout: '120' });
    expect(parsed.interval).toBe(5);
    expect(parsed.maxAttempts).toBe(60);
    expect(parsed.timeout).toBe(120);
  });

  it('requires a value for decode', () => {
    expect(decodeArgs.safeParse({}).success).toBe(false);
    expect(decodeArgs.parse({ value: 'Payment id="x"' }).value).toBe('Payment id="x"');
  });

  it('defaults status + inspect options', () => {
    expect(statusOptions.parse({}).interval).toBe(0);
    expect(inspectOptions.parse({}).method).toBe('GET');
  });

  it('leaves pay filter flags undefined by default and accepts them', () => {
    const def = payOptions.parse({});
    expect(def.paymentMethod).toBeUndefined();
    expect(def.intent).toBeUndefined();
    expect(def.currency).toBeUndefined();
    expect(def.rail).toBeUndefined();
    const parsed = payOptions.parse({
      paymentMethod: 'inflow',
      intent: 'charge',
      currency: 'USDC',
      rail: 'balance',
    });
    expect(parsed.paymentMethod).toBe('inflow');
    expect(parsed.intent).toBe('charge');
    expect(parsed.currency).toBe('USDC');
    expect(parsed.rail).toBe('balance');
  });

  it('accepts the same filter flags on inspect', () => {
    const parsed = inspectOptions.parse({
      paymentMethod: 'inflow',
      intent: 'charge',
      currency: 'USDC',
      rail: 'instrument',
    });
    expect(parsed.paymentMethod).toBe('inflow');
    expect(parsed.intent).toBe('charge');
    expect(parsed.currency).toBe('USDC');
    expect(parsed.rail).toBe('instrument');
  });
});
