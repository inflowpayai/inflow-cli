import { encode, encodeCredential, type MppChallenge, type MppReceipt, renderChallengeHeader } from '@inflowpayai/mpp';
import { describe, expect, it } from 'vitest';
import { decodeChallengeRequest, decodeMppValue, summarizeChallenge } from '../../../src/flows/mpp-decode.js';

function inflowChallenge(): MppChallenge {
  return {
    id: 'chal-1',
    realm: 'mpp.test',
    method: 'inflow',
    intent: 'charge',
    request: encode({ amount: '10', currency: 'USDC', methodDetails: { rail: 'balance' } }),
    expires: '2999-01-01T00:00:00Z',
  };
}

describe('decodeChallengeRequest', () => {
  it('decodes the inflow challenge request blob', () => {
    const request = decodeChallengeRequest(inflowChallenge());
    expect(request?.amount).toBe('10');
    expect(request?.currency).toBe('USDC');
    expect(request?.methodDetails?.rail).toBe('balance');
  });

  it('returns undefined for an empty request', () => {
    expect(decodeChallengeRequest({ ...inflowChallenge(), request: '' })).toBeUndefined();
  });

  it('returns undefined when the request blob is non-empty but not decodable', () => {
    // A base64url string whose length mod 4 === 1 can never be re-padded — the codec throws and we swallow it.
    expect(decodeChallengeRequest({ ...inflowChallenge(), request: 'a' })).toBeUndefined();
  });
});

describe('summarizeChallenge', () => {
  it('projects auth-params plus decoded amount/currency/rail', () => {
    const out = summarizeChallenge(inflowChallenge());
    expect(out).toMatchObject({
      id: 'chal-1',
      realm: 'mpp.test',
      method: 'inflow',
      intent: 'charge',
      amount: '10',
      currency: 'USDC',
      rail: 'balance',
      expires: '2999-01-01T00:00:00Z',
    });
  });
});

describe('decodeMppValue', () => {
  it('detects and summarizes a WWW-Authenticate: Payment header', () => {
    const header = renderChallengeHeader(inflowChallenge());
    const result = decodeMppValue(header);
    expect(result.kind).toBe('challenge');
    if (result.kind === 'challenge') {
      expect(result.challenge.amount).toBe('10');
      expect(result.challenge.currency).toBe('USDC');
    }
  });

  it('detects a base64url credential', () => {
    const credential = encodeCredential({
      challenge: inflowChallenge(),
      payload: { transactionId: 'tx-1' },
      source: 'did:inflow:payer-1',
    });
    const result = decodeMppValue(credential);
    expect(result.kind).toBe('credential');
    if (result.kind === 'credential') {
      expect(result.credential.source).toBe('did:inflow:payer-1');
    }
  });

  it('detects a base64url receipt', () => {
    const receipt: MppReceipt = {
      challengeId: 'chal-1',
      method: 'inflow',
      reference: 'ref-9',
      settlement: { amount: '10', currency: 'USDC' },
      status: 'success',
      timestamp: '2025-01-01T00:00:00Z',
    };
    const result = decodeMppValue(encode(receipt));
    expect(result.kind).toBe('receipt');
    if (result.kind === 'receipt') {
      expect(result.receipt.reference).toBe('ref-9');
    }
  });
});
