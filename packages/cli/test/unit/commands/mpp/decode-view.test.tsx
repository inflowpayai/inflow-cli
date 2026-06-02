import type { DecodeResult } from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { DecodeView } from '../../../../src/commands/mpp/decode.js';

describe('DecodeView', () => {
  it('renders a decoded challenge', () => {
    const result: DecodeResult = {
      kind: 'challenge',
      challenge: {
        id: 'chal-1',
        realm: 'mpp.test',
        method: 'inflow',
        intent: 'charge',
        amount: '10',
        currency: 'USDC',
        rail: 'balance',
      },
    };
    const { lastFrame, unmount } = render(<DecodeView result={result} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Challenge');
    expect(frame).toContain('inflow / charge');
    expect(frame).toContain('10');
    unmount();
  });

  it('renders a decoded challenge with an amount but no currency, rail, or expires', () => {
    const result: DecodeResult = {
      kind: 'challenge',
      challenge: { id: 'chal-2', realm: 'mpp.test', method: 'inflow', intent: 'charge', amount: '7' },
    };
    const { lastFrame, unmount } = render(<DecodeView result={result} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('amount: 7');
    expect(frame).not.toContain('rail:');
    unmount();
  });

  it('renders a decoded credential', () => {
    const result: DecodeResult = {
      kind: 'credential',
      credential: {
        challenge: { id: 'chal-1', realm: 'mpp.test', method: 'inflow', intent: 'charge', request: 'eyJ9' },
        payload: { transactionId: 'tx-1' },
        source: 'did:inflow:payer-1',
      },
    };
    const { lastFrame, unmount } = render(<DecodeView result={result} />);
    expect(lastFrame() ?? '').toContain('did:inflow:payer-1');
    unmount();
  });

  it('renders a decoded receipt', () => {
    const result: DecodeResult = {
      kind: 'receipt',
      receipt: {
        challengeId: 'chal-1',
        method: 'inflow',
        reference: 'ref-9',
        settlement: { amount: '10', currency: 'USDC' },
        status: 'success',
        timestamp: '2025-01-01T00:00:00Z',
      },
    };
    const { lastFrame, unmount } = render(<DecodeView result={result} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ref-9');
    expect(frame).toContain('success');
    unmount();
  });
});
