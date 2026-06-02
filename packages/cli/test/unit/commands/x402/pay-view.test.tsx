import type { PaymentRequirements } from '@inflowpayai/x402';
import type { EncodedPayment, InflowClient as X402InflowClient, PreparedPayment } from '@inflowpayai/x402-buyer';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayView } from '../../../../src/commands/x402/pay.js';

function paymentRequired(): PaymentRequired {
  return {
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
  };
}

function requirement(): PaymentRequirements {
  return {
    scheme: 'balance',
    network: 'inflow:1',
    amount: '500',
    payTo: 'inflow:abc',
    maxTimeoutSeconds: 60,
    asset: 'USDC',
    extra: {},
  };
}

function prepared(
  result: EncodedPayment = {
    encodedPayload: 'enc',
    paymentPayload: {
      x402Version: 2,
      accepted: requirement(),
      payload: {},
    },
    transactionId: 'txn_1',
  },
): PreparedPayment {
  return {
    transactionId: 'txn_1',
    approvalId: 'appr_1',
    awaitPayload: () => Promise.resolve(result),
    status: () => Promise.resolve('INITIATED'),
    cancel: () => Promise.resolve(),
  };
}

function makeClient(overrides: Partial<X402InflowClient> = {}): X402InflowClient {
  const base = {
    selectInflowRequirement: vi.fn(async () => requirement()),
    prepareInflowPayment: vi.fn(async () => prepared()),
    getSupported: vi.fn(async () => ({ kinds: [] })),
    getX402Payload: vi.fn(async () => ({ status: 'INITIATED' as const })),
    cancelApproval: vi.fn(async () => undefined),
  };
  return { ...base, ...overrides } as unknown as X402InflowClient;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PayView', () => {
  it('renders the success frame after a complete pay pipeline', async () => {
    const header = encodePaymentRequiredHeader(paymentRequired());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const { lastFrame, unmount } = render(
      <PayView
        url="https://seller/api"
        method="GET"
        deps={{
          client: makeClient(),
          apiBaseUrl: 'https://api.inflowpay.ai',
          probeOptions: { method: 'GET', headers: {} },
          url: 'https://seller/api',
          signOptions: { timeoutMs: 60_000 },
          showBody: true,
        }}
        onComplete={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Paid balance / inflow:1');
    });
    expect(lastFrame()).toContain('transaction: txn_1');
    expect(lastFrame()).toContain('response body:');
    unmount();
  });

  it('renders the no-payment success frame when the seller returns 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('hi', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const { lastFrame, unmount } = render(
      <PayView
        url="https://seller/api"
        method="GET"
        deps={{
          client: makeClient(),
          apiBaseUrl: 'https://api.inflowpay.ai',
          probeOptions: { method: 'GET', headers: {} },
          url: 'https://seller/api',
          signOptions: { timeoutMs: 60_000 },
          showBody: true,
        }}
        onComplete={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Seller accepted without payment');
    });
    expect(lastFrame()).toContain('response body:');
    unmount();
  });

  it('renders the error frame when the SDK rejects with X402AdapterRoutingError', async () => {
    const header = encodePaymentRequiredHeader(paymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    const client = makeClient({
      selectInflowRequirement: vi.fn(async () => null),
    });
    const { lastFrame, unmount } = render(
      <PayView
        url="https://seller/api"
        method="GET"
        deps={{
          client,
          apiBaseUrl: 'https://api.inflowpay.ai',
          probeOptions: { method: 'GET', headers: {} },
          url: 'https://seller/api',
          signOptions: { timeoutMs: 60_000 },
          showBody: false,
        }}
        onComplete={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('NO_INFLOW_MATCH');
    });
    unmount();
  });

  it('renders the replay-rejected frame (red ✗, no green ✓) when the seller still returns 402 after approval', async () => {
    const header = encodePaymentRequiredHeader(paymentRequired());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': header },
      }),
    );
    fetchSpy.mockResolvedValueOnce(new Response('still payment required', { status: 402 }));
    const { lastFrame, unmount } = render(
      <PayView
        url="https://seller/api"
        method="GET"
        deps={{
          client: makeClient(),
          apiBaseUrl: 'https://api.inflowpay.ai',
          probeOptions: { method: 'GET', headers: {} },
          url: 'https://seller/api',
          signOptions: { timeoutMs: 60_000 },
          showBody: false,
        }}
        onComplete={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Payment not accepted');
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✗');
    expect(frame).not.toContain('✓ Paid');
    expect(frame).toContain('transaction: txn_1');
    expect(frame).toContain('approval: appr_1');
    expect(frame).toContain('approval url: https://app.inflowpay.ai/approvals/appr_1/view/');
    unmount();
  });

  it('shows the probing spinner before the first fetch resolves', async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          resolveFetch = r;
        }),
    );
    const { lastFrame, unmount } = render(
      <PayView
        url="https://seller/api"
        method="GET"
        deps={{
          client: makeClient(),
          apiBaseUrl: 'https://api.inflowpay.ai',
          probeOptions: { method: 'GET', headers: {} },
          url: 'https://seller/api',
          signOptions: { timeoutMs: 60_000 },
          showBody: false,
        }}
        onComplete={() => undefined}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('Probing GET');
    resolveFetch?.(new Response('ok', { status: 200 }));
    unmount();
  });
});
