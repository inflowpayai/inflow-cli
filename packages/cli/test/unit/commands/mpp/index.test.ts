import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode, type MppChallenge, type MppTransactionResponse, renderChallengeHeader } from '@inflowpayai/mpp';
import type { MppPayCreated, MppPayResultRejected, MppPayResultSuccess } from '@inflowpayai/inflow-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __testing } from '../../../../src/commands/mpp/index.js';

const {
  createdFrameFromEvent,
  noPaymentFrameFromResult,
  paidFrameFromResult,
  rejectedFrameFromResult,
  toStatusFrame,
  runDecodeCommand,
} = __testing;

const challengeSummary: MppPayCreated['challenge'] = {
  id: 'chal-1',
  realm: 'mpp.test',
  method: 'inflow',
  intent: 'charge',
  amount: '10',
  currency: 'USDC',
};

function created(overrides: Partial<MppPayCreated> = {}): MppPayCreated {
  return {
    transactionId: 'tx-1',
    state: 'pending',
    challenge: challengeSummary,
    approvalId: 'ap-1',
    approvalUrl: 'https://app/approvals/ap-1',
    ...overrides,
  };
}

interface FakeCtx {
  agent: boolean;
  formatExplicit: boolean;
  args: { value: string };
  error: (err: { code: string; message: string }) => never;
}

function decodeCtx(value: string): FakeCtx {
  return {
    agent: true,
    formatExplicit: false,
    args: { value },
    error: (err) => {
      throw Object.assign(new Error(err.message), { code: err.code });
    },
  };
}

function challengeHeader(): string {
  const challenge: MppChallenge = {
    id: 'chal-1',
    realm: 'mpp.test',
    method: 'inflow',
    intent: 'charge',
    request: encode({ amount: '10', currency: 'USDC', methodDetails: { rail: 'balance' } }),
  };
  return renderChallengeHeader(challenge);
}

describe('createdFrameFromEvent', () => {
  it('includes _next + post-create instruction for a pending tx at interval 0', () => {
    const frame = createdFrameFromEvent(created(), 0, 0);
    expect(frame.transaction_id).toBe('tx-1');
    expect(frame.state).toBe('pending');
    expect(frame.approval_id).toBe('ap-1');
    const next = frame._next as { command: string };
    expect(next.command).toContain('mpp status tx-1');
    expect(frame.instruction).toContain('Present the approval_url');
  });

  it('omits _next and uses the polling instruction at interval > 0', () => {
    const frame = createdFrameFromEvent(created(), 5, 60);
    expect(frame._next).toBeUndefined();
    expect(frame.instruction).toContain('polling');
  });

  it('omits _next for a ready (non-pending) transaction', () => {
    const frame = createdFrameFromEvent(created({ state: 'ready' }), 0, 0);
    expect(frame._next).toBeUndefined();
  });
});

describe('paidFrameFromResult', () => {
  const success: MppPayResultSuccess = {
    outcome: 'paid',
    url: 'https://seller/api',
    method: 'GET',
    transactionId: 'tx-1',
    challengeId: 'chal-1',
    intent: 'charge',
    credential: 'CRED-B64',
    responseStatus: 200,
    responseContentType: 'text/plain',
    bodySizeBytes: 4,
    body: 'PAID',
  };

  it('inlines the credential when no credential file is given', () => {
    const frame = paidFrameFromResult(success, undefined);
    expect(frame.credential).toBe('CRED-B64');
    expect(frame.outcome).toBe('paid');
    expect(frame.body).toBe('PAID');
  });

  it('writes the credential to a 0o600 file and swaps to credential_saved_to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mpp-cred-'));
    try {
      const path = join(dir, 'cred.txt');
      const frame = paidFrameFromResult(success, path);
      expect(frame.credential).toBeUndefined();
      expect(frame.credential_saved_to).toBe(path);
      expect(readFileSync(path, 'utf-8')).toBe('CRED-B64');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rejectedFrameFromResult', () => {
  it('projects the seller-rejected result without a credential', () => {
    const rejected: MppPayResultRejected = {
      outcome: 'seller-rejected',
      url: 'https://seller/api',
      method: 'GET',
      transactionId: 'tx-1',
      challengeId: 'chal-1',
      responseStatus: 402,
      responseContentType: undefined,
      bodySizeBytes: 0,
    };
    const frame = rejectedFrameFromResult(rejected);
    expect(frame.outcome).toBe('seller-rejected');
    expect(frame.transaction_id).toBe('tx-1');
    expect(frame.credential).toBeUndefined();
  });
});

describe('noPaymentFrameFromResult', () => {
  it('projects status and body fields', () => {
    const frame = noPaymentFrameFromResult({
      outcome: 'no-payment-required',
      url: 'https://seller/api',
      method: 'GET',
      status: 200,
      contentType: 'text/plain',
      bodySizeBytes: 4,
      body: 'FREE',
    });
    expect(frame).toMatchObject({
      outcome: 'no-payment-required',
      status: 200,
      content_type: 'text/plain',
      body: 'FREE',
    });
  });
});

describe('toStatusFrame', () => {
  function tx(p: Partial<MppTransactionResponse> & { state: MppTransactionResponse['state'] }): MppTransactionResponse {
    return { transactionId: 'tx-1', ...p };
  }

  it('surfaces the credential + expires on a ready transaction', () => {
    const frame = toStatusFrame(tx({ state: 'ready', credential: 'CRED', expires: '2999-01-01T00:00:00Z' }));
    expect(frame).toMatchObject({
      transaction_id: 'tx-1',
      state: 'ready',
      credential: 'CRED',
      expires: '2999-01-01T00:00:00Z',
    });
  });

  it('surfaces approval_id + retry_after_seconds on a pending transaction', () => {
    const frame = toStatusFrame(tx({ state: 'pending', approvalId: 'ap-1', retryAfterSeconds: 5 }));
    expect(frame).toMatchObject({ state: 'pending', approval_id: 'ap-1', retry_after_seconds: 5 });
    expect(frame.credential).toBeUndefined();
  });
});

describe('runDecodeCommand (agent mode)', () => {
  it('decodes a WWW-Authenticate: Payment header to a challenge', async () => {
    const out = (await runDecodeCommand(decodeCtx(challengeHeader()))) as Record<string, unknown>;
    expect(out.kind).toBe('challenge');
  });

  it('calls c.error with DECODE_FAILED on garbage input', async () => {
    await expect(runDecodeCommand(decodeCtx('@@@not-decodable@@@'))).rejects.toThrow();
  });
});
