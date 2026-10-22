import { decodeMppValue, type DecodeResult } from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { encode, renderChallengeHeader } from '@inflowpayai/mpp';
import { DecodeView } from '../../../../src/commands/mpp/decode.js';
import { __testing } from '../../../../src/commands/mpp/index.js';
import * as renderer from '../../../../src/utils/render-ink-until-exit.js';

describe('DecodeView', () => {
  it('renders an expiring challenge without inventing an amount from an opaque method request', () => {
    const result = decodeMppValue(
      renderChallengeHeader({
        id: 'opaque',
        realm: 'seller.test',
        method: 'custom',
        intent: 'charge',
        expires: '2999-01-01T00:00:00Z',
        request: encode({ custom: 'value' }),
      }),
    );
    const view = render(<DecodeView result={result} />);
    try {
      expect(view.lastFrame()).toContain('expires: 2999-01-01T00:00:00Z');
      expect(view.lastFrame()).not.toContain('amount:');
    } finally {
      view.unmount();
    }
  });

  it('identifies an empty credential payload without inventing fields', () => {
    const result = decodeMppValue(
      encode({
        challenge: { id: 'opaque', realm: 'seller.test', method: 'custom', intent: 'charge', request: encode({}) },
        payload: {},
      }),
    );
    const view = render(<DecodeView result={result} />);
    try {
      expect(view.lastFrame()).toContain('payload keys: (none)');
    } finally {
      view.unmount();
    }
  });
  it('routes interactive multi-challenge decoding through the human view without a network request', async () => {
    const rendered = vi.spyOn(renderer, 'renderInkUntilExit').mockResolvedValue(undefined);
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const value = ['USDC', 'USDT']
        .map((currency) =>
          renderChallengeHeader({
            id: currency,
            realm: 'seller.test',
            method: 'inflow',
            intent: 'charge',
            request: encode({ amount: '1', currency }),
          }),
        )
        .join(', ');
      const error = vi.fn((failure: { message: string }): never => {
        throw new Error(failure.message);
      });
      await __testing.runDecodeCommand({ agent: false, formatExplicit: false, args: { value }, error });
      expect(error).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      const element = rendered.mock.calls[0]?.[0];
      if (element === undefined) throw new Error('Missing decode view');
      const view = render(element);
      expect(view.lastFrame()).toContain('1 USDC');
      expect(view.lastFrame()).toContain('1 USDT');
      view.unmount();
    } finally {
      rendered.mockRestore();
      fetch.mockRestore();
    }
  });
  it('renders each challenge in a multi-option header', () => {
    const { lastFrame, unmount } = render(
      <DecodeView
        result={{
          kind: 'challenges',
          challenges: ['USDC', 'USDT'].map((currency) => ({
            id: currency,
            realm: 'mpp.test',
            method: 'inflow',
            intent: 'charge',
            currency,
            amount: '0.0098',
          })),
        }}
      />,
    );
    expect(lastFrame()).toContain('amount: 0.0098 USDC');
    expect(lastFrame()).toContain('amount: 0.0098 USDT');
    unmount();
  });

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
        settlement: { amount: '10.5', currency: 'USDC' },
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
