import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DecodeView, decodeHeader } from '../../../../src/commands/x402/decode.js';
import { __testing } from '../../../../src/commands/x402/index.js';
import * as renderer from '../../../../src/utils/render-ink-until-exit.js';

function paymentRequired(overrides: Partial<PaymentRequired> = {}): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: 'https://seller.example.com/api/widgets',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'balance',
        network: 'inflow:1',
        amount: '500',
        payTo: 'inflow:abc',
        maxTimeoutSeconds: 60,
        asset: 'USDC',
        extra: {},
      },
    ],
    ...overrides,
  };
}

describe('DecodeView', () => {
  it('routes interactive decoding through the human view without a network request', async () => {
    const rendered = vi.spyOn(renderer, 'renderInkUntilExit').mockResolvedValue(undefined);
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const error = vi.fn((failure: { message: string }): never => {
        throw new Error(failure.message);
      });
      await __testing.runDecodeCommand({
        agent: false,
        formatExplicit: false,
        args: { header: encodePaymentRequiredHeader(paymentRequired()) },
        error,
      });
      expect(error).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      const element = rendered.mock.calls[0]?.[0];
      if (element === undefined) throw new Error('Missing decode view');
      const view = render(element);
      expect(view.lastFrame()).toContain('Decoded PAYMENT-REQUIRED');
      expect(view.lastFrame()).toContain('amount 500');
      view.unmount();
    } finally {
      rendered.mockRestore();
      fetch.mockRestore();
    }
  });
  it('renders header, accepts, scheme, network, asset, and amount', () => {
    const header = encodePaymentRequiredHeader(paymentRequired());
    const decoded = decodeHeader(header);
    const { lastFrame, unmount } = render(<DecodeView decoded={decoded} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Decoded PAYMENT-REQUIRED');
    expect(frame).toContain('x402Version: 2');
    expect(frame).toContain('https://seller.example.com/api/widgets');
    expect(frame).toContain('accepts (1):');
    expect(frame).toContain('balance');
    expect(frame).toContain('inflow:1');
    expect(frame).toContain('amount 500');
    expect(frame).toContain('USDC');
    unmount();
  });

  it('omits asset and amount when blank', () => {
    const header = encodePaymentRequiredHeader(
      paymentRequired({
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:8453',
            amount: '',
            payTo: '0x0',
            maxTimeoutSeconds: 60,
            asset: '',
            extra: {},
          },
        ],
      }),
    );
    const decoded = decodeHeader(header);
    const { lastFrame, unmount } = render(<DecodeView decoded={decoded} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('exact');
    expect(frame).toContain('eip155:8453');
    expect(frame).not.toContain('amount ');
    expect(frame).not.toContain(' · USDC');
    unmount();
  });

  it('renders an extensions footer when extensions are present on the decoded header', () => {
    const header = encodePaymentRequiredHeader(
      paymentRequired({ extensions: { 'payment-identifier': { required: true } } }),
    );
    const decoded = decodeHeader(header);
    const { lastFrame, unmount } = render(<DecodeView decoded={decoded} />);
    expect(lastFrame()).toContain('extensions: payment-identifier');
    unmount();
  });

  it('renders multiple accepts entries with stable per-row keys', () => {
    const header = encodePaymentRequiredHeader(
      paymentRequired({
        accepts: [
          {
            scheme: 'balance',
            network: 'inflow:1',
            amount: '500',
            payTo: 'inflow:abc',
            maxTimeoutSeconds: 60,
            asset: 'USDC',
            extra: {},
          },
          {
            scheme: 'exact',
            network: 'eip155:8453',
            amount: '1000000',
            payTo: '0x0',
            maxTimeoutSeconds: 60,
            asset: 'USDC',
            extra: {},
          },
        ],
      }),
    );
    const decoded = decodeHeader(header);
    const { lastFrame, unmount } = render(<DecodeView decoded={decoded} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('accepts (2):');
    expect(frame).toContain('balance');
    expect(frame).toContain('exact');
    unmount();
  });
});
