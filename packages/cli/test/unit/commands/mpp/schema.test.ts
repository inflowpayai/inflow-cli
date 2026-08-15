import { describe, expect, it } from 'vitest';
import {
  decodeArgs,
  fetchArgs,
  fetchOptions,
  inspectOptions,
  payOptions,
  statusOptions,
  subscribeArgs,
  subscribeOptions,
} from '../../../../src/commands/mpp/schema.js';

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

  it('defaults fetch options and requires transaction/resource args', () => {
    expect(fetchArgs.parse({ transactionId: 'tx-1', resourceUrl: 'https://seller/api' })).toEqual({
      transactionId: 'tx-1',
      resourceUrl: 'https://seller/api',
    });
    const parsed = fetchOptions.parse({});
    expect(parsed.method).toBe('GET');
    expect(parsed.header).toEqual([]);
    expect(parsed.interval).toBe(0);
    expect(parsed.timeout).toBe(900);
    expect(parsed.showBody).toBe(true);
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

  it('subscribe reuses pay args/options but drops the caller-supplied --intent', () => {
    expect(subscribeArgs.parse({ url: 'https://seller/api' }).url).toBe('https://seller/api');
    const parsed = subscribeOptions.parse({ paymentMethod: 'inflow', currency: 'USDC', rail: 'balance' });
    expect(parsed.method).toBe('GET');
    expect(parsed.showBody).toBe(true);
    expect(parsed.paymentMethod).toBe('inflow');
    expect('intent' in parsed).toBe(false);
    // `intent` is not a recognized key: with the default zod strip it is dropped, not surfaced.
    const withIntent = subscribeOptions.parse({ intent: 'charge' }) as Record<string, unknown>;
    expect(withIntent['intent']).toBeUndefined();
  });

  it('accepts subscription option identifiers and rejects invalid values', () => {
    expect(Object.keys(subscribeOptions.shape)[0]).toBe('optionId');
    expect(subscribeOptions.parse({ optionId: 'a84c92d13f6b' }).optionId).toBe('a84c92d13f6b');
    expect(subscribeOptions.parse({ optionId: 'A'.repeat(64) }).optionId).toBe('A'.repeat(64));
    expect(subscribeOptions.safeParse({ optionId: 'not-hex' }).success).toBe(false);
    expect(subscribeOptions.safeParse({ optionId: 'a'.repeat(65) }).success).toBe(false);
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
