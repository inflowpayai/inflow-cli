import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PayEvent, PayResultNoPayment, PayResultReplayRejected, PayResultSuccess } from '@inflowpayai/inflow-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __testing } from '../../../../src/commands/x402/index.js';

const { initialPayFrame, noPaymentFrameFromResult, paidFrameFromResult, rejectedFrameFromResult, toStatusFrame } =
  __testing;

function preparedEvent(overrides: Record<string, unknown> = {}): Extract<PayEvent, { type: 'prepared' }> {
  const base: Extract<PayEvent, { type: 'prepared' }> = {
    type: 'prepared',
    decoded: {
      x402Version: 2,
      resource: { url: 'https://seller/api', mimeType: 'application/json' },
      accepts: [],
    },
    requirement: {
      scheme: 'balance',
      network: 'inflow:1',
      amount: '500',
      payTo: 'inflow:abc',
      maxTimeoutSeconds: 60,
      asset: 'USDC',
      extra: {},
    },
    prepared: {
      transactionId: 'txn_1',
      approvalId: 'appr_1',
      awaitPayload: () => Promise.reject(new Error('not called in this test')),
      status: () => Promise.resolve('INITIATED' as const),
      cancel: () => Promise.resolve(),
    } as Extract<PayEvent, { type: 'prepared' }>['prepared'],
    approvalUrl: 'https://app.inflowpay.ai/approvals/appr_1/view/',
  };
  return { ...base, ...overrides } as Extract<PayEvent, { type: 'prepared' }>;
}

describe('initialPayFrame', () => {
  it('includes _next.command and POST_PAY_INSTRUCTION when interval=0', () => {
    const frame = initialPayFrame(preparedEvent(), 0, 0);
    expect(frame.transaction_id).toBe('txn_1');
    expect(frame.approval_id).toBe('appr_1');
    expect(frame.approval_url).toBe('https://app.inflowpay.ai/approvals/appr_1/view/');
    expect(frame.scheme).toBe('balance');
    expect(frame.network).toBe('inflow:1');
    expect(frame.amount).toBe('500');
    expect(frame.asset).toBe('USDC');
    const next = frame._next as { command: string; poll_interval_seconds: number };
    expect(next.command).toContain('x402 status txn_1');
    expect(next.poll_interval_seconds).toBe(5);
    expect(frame.instruction).toContain('Present the approval_url');
  });

  it('omits _next when interval > 0 and uses the polling instruction', () => {
    const frame = initialPayFrame(preparedEvent(), 5, 60);
    expect(frame._next).toBeUndefined();
    expect(frame.instruction).toContain('inline');
  });

  it('uses maxAttempts > 0 in the next command when supplied', () => {
    const frame = initialPayFrame(preparedEvent(), 0, 120);
    const next = frame._next as { command: string };
    expect(next.command).toContain('--max-attempts 120');
  });

  it('omits amount and asset when the requirement does not advertise them', () => {
    const frame = initialPayFrame(
      preparedEvent({
        requirement: {
          scheme: 'exact',
          network: 'eip155:8453',
          amount: '',
          payTo: '0x0',
          maxTimeoutSeconds: 60,
          asset: '',
          extra: {},
        },
      }),
      0,
      0,
    );
    expect(frame.amount).toBeUndefined();
    expect(frame.asset).toBeUndefined();
  });
});

describe('noPaymentFrameFromResult', () => {
  it('includes body when the result carries inline UTF-8', () => {
    const result: PayResultNoPayment = {
      outcome: 'no-payment-required',
      url: 'https://seller/api',
      method: 'GET',
      status: 200,
      contentType: 'text/plain',
      bodySizeBytes: 5,
      body: 'hello',
    };
    const frame = noPaymentFrameFromResult(result);
    expect(frame.outcome).toBe('no-payment-required');
    expect(frame.status).toBe(200);
    expect(frame.body).toBe('hello');
    expect(frame.body_size_bytes).toBe(5);
    expect(frame.content_type).toBe('text/plain');
  });

  it('uses body_base64 when the body is binary', () => {
    const result: PayResultNoPayment = {
      outcome: 'no-payment-required',
      url: 'https://seller/api',
      method: 'GET',
      status: 200,
      contentType: undefined,
      bodySizeBytes: 2,
      bodyBase64: 'AP4=',
    };
    const frame = noPaymentFrameFromResult(result);
    expect(frame.body).toBeUndefined();
    expect(frame.body_base64).toBe('AP4=');
  });

  it('omits body and body_base64 when neither is present', () => {
    const result: PayResultNoPayment = {
      outcome: 'no-payment-required',
      url: 'https://seller/api',
      method: 'GET',
      status: 200,
      contentType: 'text/plain',
      bodySizeBytes: 5,
    };
    const frame = noPaymentFrameFromResult(result);
    expect(frame.body).toBeUndefined();
    expect(frame.body_base64).toBeUndefined();
    expect(frame.body_size_bytes).toBe(5);
  });

  it('surfaces output_saved_to when the result was streamed to disk', () => {
    const result: PayResultNoPayment = {
      outcome: 'no-payment-required',
      url: 'https://seller/api',
      method: 'GET',
      status: 200,
      contentType: 'application/pdf',
      bodySizeBytes: 1024,
      outputSavedTo: '/tmp/out.pdf',
    };
    const frame = noPaymentFrameFromResult(result);
    expect(frame.output_saved_to).toBe('/tmp/out.pdf');
    expect(frame.body).toBeUndefined();
    expect(frame.body_base64).toBeUndefined();
  });
});

describe('paidFrameFromResult', () => {
  function makePaid(overrides: Partial<PayResultSuccess> = {}): PayResultSuccess {
    return {
      outcome: 'paid',
      url: 'https://seller/api',
      method: 'GET',
      transactionId: 'txn_1',
      approvalId: 'appr_1',
      approvalUrl: 'https://app.inflowpay.ai/approvals/appr_1/view/',
      scheme: 'balance',
      network: 'inflow:1',
      encodedPayload: 'enc-bytes',
      responseStatus: 200,
      responseContentType: 'application/json',
      bodySizeBytes: 5,
      body: 'hello',
      ...overrides,
    };
  }

  it('surfaces encoded_payload inline when payloadFile is undefined', () => {
    const frame = paidFrameFromResult(makePaid(), undefined);
    expect(frame.outcome).toBe('paid');
    expect(frame.encoded_payload).toBe('enc-bytes');
    expect(frame.payload_saved_to).toBeUndefined();
    expect(frame.response_status).toBe(200);
    expect(frame.body).toBe('hello');
    expect(frame.body_size_bytes).toBe(5);
  });

  it('omits response_content_type when undefined', () => {
    const frame = paidFrameFromResult(makePaid({ responseContentType: undefined }), undefined);
    expect(frame.response_content_type).toBeUndefined();
  });

  it('includes settled when the result carries it', () => {
    const frame = paidFrameFromResult(
      makePaid({ settled: { network: 'inflow:1', transaction: 'tx-hash' } }),
      undefined,
    );
    expect(frame.settled).toEqual({ network: 'inflow:1', transaction: 'tx-hash' });
  });
});

describe('rejectedFrameFromResult', () => {
  it('emits the reject envelope with approval_url and response_status', () => {
    const result: PayResultReplayRejected = {
      outcome: 'replay-rejected',
      url: 'https://seller/api',
      method: 'GET',
      transactionId: 'txn_1',
      approvalId: 'appr_1',
      approvalUrl: 'https://app.inflowpay.ai/approvals/appr_1/view/',
      scheme: 'balance',
      network: 'inflow:1',
      responseStatus: 402,
      responseContentType: 'application/json',
      bodySizeBytes: 2,
      body: '{}',
    };
    const frame = rejectedFrameFromResult(result);
    expect(frame.outcome).toBe('replay-rejected');
    expect(frame.transaction_id).toBe('txn_1');
    expect(frame.approval_id).toBe('appr_1');
    expect(frame.approval_url).toBe('https://app.inflowpay.ai/approvals/appr_1/view/');
    expect(frame.response_status).toBe(402);
    expect(frame.response_content_type).toBe('application/json');
    expect(frame.body).toBe('{}');
    expect(frame.body_size_bytes).toBe(2);
  });
});

describe('toStatusFrame', () => {
  it('emits transaction_id and status for an INITIATED snapshot', () => {
    expect(toStatusFrame('txn_1', { status: 'INITIATED' })).toEqual({
      transaction_id: 'txn_1',
      status: 'INITIATED',
    });
  });

  it('includes encoded_payload and payment_payload when present', () => {
    const frame = toStatusFrame('txn_2', {
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
    });
    expect(frame.encoded_payload).toBe('enc');
    expect(frame.payment_payload).toBeDefined();
  });

  describe('--payload-file', () => {
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'inflow-payload-'));
    });

    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it('writes encoded_payload to disk with mode 0o600 and replaces it with payload_saved_to', () => {
      const target = join(tmp, 'payment.payload');
      const frame = toStatusFrame('txn_3', { status: 'APPROVED', encodedPayload: 'enc-bytes' }, target);
      expect(frame.encoded_payload).toBeUndefined();
      expect(frame.payload_saved_to).toBe(target);
      expect(readFileSync(target, 'utf-8')).toBe('enc-bytes');
      const mode = statSync(target).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('chmods an overwrite back to 0o600 even if the existing file was looser', () => {
      const target = join(tmp, 'stale.payload');
      writeFileSync(target, 'stale', { mode: 0o644 });
      chmodSync(target, 0o644);
      expect(statSync(target).mode & 0o777).toBe(0o644);
      const frame = toStatusFrame('txn_4', { status: 'APPROVED', encodedPayload: 'fresh' }, target);
      expect(frame.payload_saved_to).toBe(target);
      expect(readFileSync(target, 'utf-8')).toBe('fresh');
      expect(statSync(target).mode & 0o777).toBe(0o600);
    });

    it('leaves encoded_payload inline when payloadFile is undefined', () => {
      const frame = toStatusFrame('txn_5', { status: 'APPROVED', encodedPayload: 'inline' });
      expect(frame.encoded_payload).toBe('inline');
      expect(frame.payload_saved_to).toBeUndefined();
    });

    it('leaves encoded_payload inline when payloadFile is an empty string', () => {
      const frame = toStatusFrame('txn_6', { status: 'APPROVED', encodedPayload: 'inline' }, '');
      expect(frame.encoded_payload).toBe('inline');
      expect(frame.payload_saved_to).toBeUndefined();
    });
  });
});
