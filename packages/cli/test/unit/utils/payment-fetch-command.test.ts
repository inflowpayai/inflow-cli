import { describe, expect, it } from 'vitest';
import {
  buildPaymentFetchContinuation,
  buildPaymentFetchNextCommand,
  shellArg,
} from '../../../src/utils/payment-fetch-command.js';
import * as mpp from '../../../src/commands/mpp/schema.js';
import * as x402 from '../../../src/commands/x402/schema.js';

describe('payment fetch command helpers', () => {
  it('quotes shell-sensitive arguments', () => {
    expect(shellArg('https://seller.test/path?a=1&b=two words')).toBe("'https://seller.test/path?a=1&b=two words'");
    expect(shellArg("tx'1")).toBe("'tx'\"'\"'1'");
  });

  it('builds safe fetch continuation commands without embedding headers or bodies', () => {
    expect(
      buildPaymentFetchNextCommand({
        protocol: 'mpp',
        transactionId: 'tx 1',
        resourceUrl: 'https://seller.test/pay?x=1&y=2',
        method: 'POST',
        interval: 5,
        maxAttempts: 60,
        timeout: 123,
        showBody: false,
        outputFile: 'out body.json',
      }),
    ).toBe(
      "mpp fetch 'tx 1' 'https://seller.test/pay?x=1&y=2' --interval 5 --max-attempts 60 --timeout 123 --method POST --output-file 'out body.json' --no-show-body",
    );
  });

  describe.each(['mpp', 'x402'] as const)('%s continuation', (protocol) => {
    const request = {
      protocol,
      transactionId: 'tx-1',
      resourceUrl: 'https://seller.test/resource',
      method: 'GET',
      interval: 5,
      maxAttempts: 0,
      timeout: 123,
      showBody: true,
      header: [],
    };

    it('preserves options in input accepted by the actual Fetch schemas', () => {
      const next = buildPaymentFetchContinuation({ ...request, showBody: false, outputFile: 'result.json' });
      const schema = protocol === 'mpp' ? mpp : x402;
      expect(schema.fetchArgs.parse(next.input)).toEqual({
        transactionId: request.transactionId,
        resourceUrl: request.resourceUrl,
      });
      expect(schema.fetchOptions.parse(next.input)).toMatchObject({
        method: 'GET',
        interval: 5,
        maxAttempts: 0,
        timeout: 123,
        showBody: false,
        outputFile: 'result.json',
      });
      expect(next.tool).toBe(`${protocol}_fetch`);
      expect(next.command).toBe(
        `${protocol} fetch tx-1 https://seller.test/resource --interval 5 --max-attempts 0 --timeout 123 --output-file result.json --no-show-body`,
      );
      expect(next.requires_original_request_options).toBe(false);
    });

    it.each([{ data: '' }, { data: 'private body' }, { header: ['Authorization: Bearer secret'] }])(
      'requires restoring original request arguments without echoing them: %j',
      (options) => {
        const next = buildPaymentFetchContinuation({ ...request, ...options });
        expect(next.command).toBeUndefined();
        expect(next.requires_original_request_options).toBe(true);
        expect(next.input).not.toHaveProperty('data');
        expect(next.input).not.toHaveProperty('header');
        expect(next.input).not.toHaveProperty('outputFile');
      },
    );
  });
});
