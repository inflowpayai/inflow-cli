import { describe, expect, it } from 'vitest';
import { classifyPayloadResponse, TERMINAL_FAILURE_STATUSES } from '../../../../src/commands/x402/status.js';

describe('classifyPayloadResponse', () => {
  it('returns "signed" when both encodedPayload and paymentPayload are present', () => {
    expect(
      classifyPayloadResponse({
        status: 'APPROVED',
        encodedPayload: 'enc',
        paymentPayload: {
          x402Version: 2,
          accepted: {
            scheme: 'balance',
            network: 'inflow:1',
            amount: '0',
            payTo: '',
            maxTimeoutSeconds: 0,
            asset: '',
            extra: {},
          },
          payload: {},
        },
      }),
    ).toBe('signed');
  });

  it('returns "pending" while INITIATED (no payload yet)', () => {
    expect(classifyPayloadResponse({ status: 'INITIATED' })).toBe('pending');
  });

  it('returns "failed" for every terminal failure status', () => {
    for (const status of ['DECLINED', 'EXPIRED', 'GENERAL_ERROR', 'INSUFFICIENT_FUNDS']) {
      expect(classifyPayloadResponse({ status })).toBe('failed');
    }
  });

  it('treats unknown non-terminal statuses as pending so the loop keeps polling', () => {
    expect(classifyPayloadResponse({ status: 'PROCESSING' })).toBe('pending');
  });
});

describe('TERMINAL_FAILURE_STATUSES', () => {
  it('matches the spec table', () => {
    expect([...TERMINAL_FAILURE_STATUSES].sort()).toEqual(
      ['DECLINED', 'EXPIRED', 'GENERAL_ERROR', 'INSUFFICIENT_FUNDS'].sort(),
    );
  });
});
