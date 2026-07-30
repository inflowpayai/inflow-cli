import { describe, expect, it } from 'vitest';
import { buildPaymentFetchNextCommand, shellArg } from '../../../src/utils/payment-fetch-command.js';

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
        showBody: false,
        outputFile: 'out body.json',
      }),
    ).toBe(
      "mpp fetch 'tx 1' 'https://seller.test/pay?x=1&y=2' --interval 5 --max-attempts 60 --method POST --output-file 'out body.json' --no-show-body",
    );
  });
});
