import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { DecodeView, decodeHeader } from '../../../../src/commands/x402/decode.js';

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
