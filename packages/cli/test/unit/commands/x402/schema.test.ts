import { describe, expect, it } from 'vitest';
import {
  cancelArgs,
  decodeArgs,
  inspectArgs,
  inspectOptions,
  payArgs,
  payOptions,
  statusArgs,
  statusOptions,
} from '../../../../src/commands/x402/schema.js';

describe('payArgs / payOptions', () => {
  it('requires a url positional', () => {
    expect(() => payArgs.parse({})).toThrow();
    expect(payArgs.parse({ url: 'https://example.com' })).toEqual({ url: 'https://example.com' });
  });

  it('defaults method to GET, header to [], interval to 0, timeout to 900, showBody to true', () => {
    const parsed = payOptions.parse({});
    expect(parsed.method).toBe('GET');
    expect(parsed.header).toEqual([]);
    expect(parsed.interval).toBe(0);
    expect(parsed.timeout).toBe(900);
    expect(parsed.showBody).toBe(true);
    expect(parsed.outputFile).toBeUndefined();
    expect(parsed.payloadFile).toBeUndefined();
  });

  it('accepts an explicit outputFile path', () => {
    const parsed = payOptions.parse({ outputFile: '/tmp/article.pdf' });
    expect(parsed.outputFile).toBe('/tmp/article.pdf');
  });

  it('accepts an explicit payloadFile path on pay', () => {
    const parsed = payOptions.parse({ payloadFile: '/tmp/payment.payload' });
    expect(parsed.payloadFile).toBe('/tmp/payment.payload');
  });

  it('accepts showBody: false to opt out of the inline body', () => {
    const parsed = payOptions.parse({ showBody: false });
    expect(parsed.showBody).toBe(false);
  });

  it('coerces interval, maxAttempts, timeout from strings', () => {
    const parsed = payOptions.parse({ interval: '5', maxAttempts: '60', timeout: '120' });
    expect(parsed.interval).toBe(5);
    expect(parsed.maxAttempts).toBe(60);
    expect(parsed.timeout).toBe(120);
  });

  it('preserves a paymentId when supplied', () => {
    const parsed = payOptions.parse({ paymentId: 'abcdefghijklmnop' });
    expect(parsed.paymentId).toBe('abcdefghijklmnop');
  });

  it('defaults scheme / network to undefined', () => {
    const parsed = payOptions.parse({});
    expect(parsed.scheme).toBeUndefined();
    expect(parsed.network).toBeUndefined();
  });

  it('accepts scheme and network filter flags', () => {
    const parsed = payOptions.parse({
      scheme: 'balance',
      network: 'inflow:1',
    });
    expect(parsed.scheme).toBe('balance');
    expect(parsed.network).toBe('inflow:1');
  });
});

describe('statusArgs / statusOptions', () => {
  it('requires transactionId', () => {
    expect(() => statusArgs.parse({})).toThrow();
    expect(statusArgs.parse({ transactionId: 'txn_1' })).toEqual({ transactionId: 'txn_1' });
  });

  it('defaults interval=0, timeout=900', () => {
    const parsed = statusOptions.parse({});
    expect(parsed.interval).toBe(0);
    expect(parsed.timeout).toBe(900);
    expect(parsed.payloadFile).toBeUndefined();
  });

  it('accepts an explicit payloadFile path on status', () => {
    const parsed = statusOptions.parse({ payloadFile: '/tmp/payment.payload' });
    expect(parsed.payloadFile).toBe('/tmp/payment.payload');
  });
});

describe('cancelArgs / decodeArgs', () => {
  it('cancelArgs requires approvalId', () => {
    expect(() => cancelArgs.parse({})).toThrow();
    expect(cancelArgs.parse({ approvalId: 'appr_1' })).toEqual({ approvalId: 'appr_1' });
  });

  it('decodeArgs requires header', () => {
    expect(() => decodeArgs.parse({})).toThrow();
    expect(decodeArgs.parse({ header: 'base64-blob' })).toEqual({ header: 'base64-blob' });
  });
});

describe('inspectArgs / inspectOptions', () => {
  it('inspectArgs requires url', () => {
    expect(() => inspectArgs.parse({})).toThrow();
    expect(inspectArgs.parse({ url: 'https://seller/api' })).toEqual({
      url: 'https://seller/api',
    });
  });

  it('defaults method to GET, header to [], and leaves filters undefined', () => {
    const parsed = inspectOptions.parse({});
    expect(parsed.method).toBe('GET');
    expect(parsed.header).toEqual([]);
    expect(parsed.scheme).toBeUndefined();
    expect(parsed.network).toBeUndefined();
    expect(parsed.data).toBeUndefined();
  });

  it('accepts scheme / network filter flags', () => {
    const parsed = inspectOptions.parse({
      scheme: 'exact',
      network: 'eip155:84532',
    });
    expect(parsed.scheme).toBe('exact');
    expect(parsed.network).toBe('eip155:84532');
  });

  it('does not surface --interval / --timeout / --show-body / --output-file / --payload-file / --paymentId', () => {
    const parsed = inspectOptions.parse({
      interval: 5,
      timeout: 60,
      showBody: false,
      outputFile: '/tmp/x',
      payloadFile: '/tmp/p',
      paymentId: 'pid_x',
    });
    expect('interval' in parsed).toBe(false);
    expect('timeout' in parsed).toBe(false);
    expect('showBody' in parsed).toBe(false);
    expect('outputFile' in parsed).toBe(false);
    expect('payloadFile' in parsed).toBe(false);
    expect('paymentId' in parsed).toBe(false);
  });
});
