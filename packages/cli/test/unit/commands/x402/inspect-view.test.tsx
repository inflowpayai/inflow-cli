import { encodePaymentRequiredHeader } from '@x402/core/http';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InspectView } from '../../../../src/commands/x402/inspect.js';

function multiAcceptHeader(): string {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url: 'https://seller.example.com/api/widgets', mimeType: 'application/json' },
    accepts: [
      {
        scheme: 'balance',
        network: 'inflow:1',
        amount: '500',
        payTo: 'inflow:abc123',
        maxTimeoutSeconds: 60,
        asset: 'USDC',
        extra: {},
      },
      {
        scheme: 'exact',
        network: 'eip155:84532',
        amount: '500',
        payTo: '0xAbCdEfABcDef0123456789aBcDeF0123456789aB',
        maxTimeoutSeconds: 60,
        asset: 'USDC',
        extra: {
          name: 'USD Coin',
          version: '2',
          assetTransferMethod: 'eip3009',
        },
      },
    ],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('InspectView', () => {
  it('renders a proper-cased table with the seller header line and footer hint', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': multiAcceptHeader() },
      }),
    );
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <InspectView
        url="https://seller.example.com/api/widgets"
        method="GET"
        deps={{
          probeOptions: { method: 'GET', headers: {} },
          url: 'https://seller.example.com/api/widgets',
        }}
        onComplete={onComplete}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frame = lastFrame() ?? '';

    expect(frame).toContain('PAYMENT-REQUIRED');
    expect(frame).toContain('https://seller.example.com/api/widgets');
    expect(frame).toContain('x402Version 2');
    expect(frame).toContain('2 accepts');

    for (const h of ['Scheme', 'Network', 'Amount', 'Asset', 'Pay To', 'Timeout', 'Extra']) {
      expect(frame).toContain(h);
    }

    expect(frame).toContain('balance');
    expect(frame).toContain('inflow:1');
    expect(frame).toContain('exact');
    expect(frame).toContain('eip155:84532');
    expect(frame).toContain('0xAbCdEfABcDef0123456789aBcDeF0123456789aB');

    expect(frame).toContain('60s');

    expect(frame).toContain('—');
    expect(frame).toContain('name');
    expect(frame).toContain('version');
    expect(frame).toContain('assetTransferMethod');

    expect(frame).toContain('--format json');
    unmount();
  });

  it('singularises the "1 accept" header line when there is exactly one row', async () => {
    const header = encodePaymentRequiredHeader({
      x402Version: 2,
      resource: { url: 'https://seller/api', mimeType: 'application/json' },
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
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const { lastFrame, unmount } = render(
      <InspectView
        url="https://seller/api"
        method="GET"
        deps={{
          probeOptions: { method: 'GET', headers: {} },
          url: 'https://seller/api',
        }}
        onComplete={vi.fn()}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1 accept');
    expect(frame).not.toContain('1 accepts');
    unmount();
  });

  it('renders the no-payment branch with status + content-type + size hint', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('hello world', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const { lastFrame, unmount } = render(
      <InspectView
        url="https://seller/api"
        method="GET"
        deps={{
          probeOptions: { method: 'GET', headers: {} },
          url: 'https://seller/api',
        }}
        onComplete={vi.fn()}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Seller accepted without payment');
    expect(frame).toContain('status: 200');
    expect(frame).toContain('content-type: text/plain');
    expect(frame).toContain('11 bytes');
    expect(frame).toContain('x402 pay');
    unmount();
  });

  it('renders the error branch with the code + message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('server error', { status: 503 }));
    const { lastFrame, unmount } = render(
      <InspectView
        url="https://seller/api"
        method="GET"
        deps={{
          probeOptions: { method: 'GET', headers: {} },
          url: 'https://seller/api',
        }}
        onComplete={vi.fn()}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('UNEXPECTED_PROBE_STATUS');
    expect(frame).toContain('503');
    unmount();
  });

  it('renders the extensions line when extensions are present', async () => {
    const header = encodePaymentRequiredHeader({
      x402Version: 2,
      resource: { url: 'https://seller/api', mimeType: 'application/json' },
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
      extensions: { 'payment-identifier': { required: true } },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const { lastFrame, unmount } = render(
      <InspectView
        url="https://seller/api"
        method="GET"
        deps={{
          probeOptions: { method: 'GET', headers: {} },
          url: 'https://seller/api',
        }}
        onComplete={vi.fn()}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('extensions: payment-identifier');
    unmount();
  });
});
