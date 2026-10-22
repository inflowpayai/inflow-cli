import type { PaymentRequirements } from '@inflowpayai/x402';
import type { PayPhase } from '@inflowpayai/inflow-core';
import { Inflow } from '@inflowpayai/inflow-core';
import { encode } from '@inflowpayai/mpp';
import type { EncodedPayment, InflowClient as X402InflowClient, PreparedPayment } from '@inflowpayai/x402-buyer';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { render } from 'ink-testing-library';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayView } from '../../../../src/commands/x402/pay.js';
import { openUrl } from '../../../../src/utils/open-url.js';

vi.mock('../../../../src/utils/open-url.js', () => ({ openUrl: vi.fn() }));

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
    selectInflowRequirement: vi.fn(() => Promise.resolve(requirement())),
    prepareInflowPayment: vi.fn(() => Promise.resolve(prepared())),
    getSupported: vi.fn(() => Promise.resolve({ kinds: [] })),
    getX402Payload: vi.fn(() => Promise.resolve({ status: 'INITIATED' as const })),
    cancelApproval: vi.fn(() => Promise.resolve(undefined)),
  };
  return { ...base, ...overrides } as unknown as X402InflowClient;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PayView', () => {
  it('routes Escape to authentication approval instead of cancelling the payment approval', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired()) },
      }),
    );
    let finishPayload: ((payment: EncodedPayment) => void) | undefined;
    const payload = new Promise<EncodedPayment>((resolve) => {
      finishPayload = resolve;
    });
    const payment = prepared();
    const prepareInflowPayment = vi.fn(() => Promise.resolve({ ...payment, awaitPayload: () => payload }));
    const cancelAuthentication = vi.fn(() => Promise.resolve());
    const cancelPayment = vi.fn(() => Promise.resolve());
    const view = render(
      <PayView
        url="https://seller/api"
        method="GET"
        deps={{
          client: makeClient({ prepareInflowPayment }),
          apiBaseUrl: 'https://api.inflowpay.ai',
          probeOptions: { method: 'GET', headers: {} },
          url: 'https://seller/api',
          signOptions: { timeoutMs: 60000 },
          showBody: false,
        }}
        authenticationApproval={{
          approvalId: 'auth-approval',
          approvalUrl: 'https://app.inflowpay.ai/auth-approval',
          cancel: cancelAuthentication,
        }}
        onCancel={cancelPayment}
        onComplete={vi.fn()}
      />,
    );
    try {
      await vi.waitFor(() => expect(prepareInflowPayment).toHaveBeenCalledOnce());
      expect(view.lastFrame()).toContain('Authentication approval required');
      view.stdin.write('\u001b');
      await vi.waitFor(() => expect(cancelAuthentication).toHaveBeenCalledOnce());
      expect(cancelPayment).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      finishPayload?.(await payment.awaitPayload());
    }
  });

  it.each(['stop', 'complete'] as const)(
    'handles bank verification through the SDK without another payment: %s',
    async (action) => {
      const transactionId = '11111111-1111-4111-8111-111111111111';
      const api = 'https://api.inflowpay.ai';
      const seller = 'https://seller.test/resource';
      const verificationUrl = `https://app.inflowpay.ai/transactions/${transactionId}/verify/`;
      const accepted = {
        ...requirement(),
        network: 'inflow:1' as const,
        extra: {},
        scheme: 'instrument',
        asset: 'USD',
        payTo: transactionId,
      };
      const paymentPayload = { x402Version: 2, accepted, payload: { transactionId } };
      let verified = false;
      let created = 0;
      let paidRequests = 0;
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        const request = new Request(input, init);
        if (request.url === seller) {
          if (!request.headers.has('PAYMENT-SIGNATURE'))
            return Promise.resolve(
              new Response(null, {
                status: 402,
                headers: {
                  'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
                    x402Version: 2,
                    resource: { url: seller },
                    accepts: [accepted],
                  }),
                },
              }),
            );
          paidRequests += 1;
          return Promise.resolve(
            new Response(verified ? 'Purchased content' : 'Verification required', { status: verified ? 200 : 402 }),
          );
        }
        if (request.url === `${api}/v1/transactions/x402-supported`)
          return Promise.resolve(
            Response.json({ kinds: [{ scheme: 'instrument', network: 'inflow:1', x402Version: 2 }] }),
          );
        if (request.url === `${api}/v1/transactions/x402`) {
          created += 1;
          return Promise.resolve(Response.json({ transactionId, approvalId: transactionId }));
        }
        if (request.url === `${api}/v1/transactions/${transactionId}/x402`)
          return Promise.resolve(
            Response.json({ status: 'PENDING', encodedPayload: encode(paymentPayload), paymentPayload }),
          );
        if (request.url === `${api}/v1/transactions/${transactionId}`)
          return Promise.resolve(
            Response.json(
              verified
                ? { transactionId, status: 'SETTLED' }
                : { transactionId, status: 'PENDING', nextAction: { type: 'authenticate_card', url: verificationUrl } },
            ),
          );
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      });
      const inflow = new Inflow({ apiKey: 'buyer-key', apiBaseUrl: api });
      const client = await inflow.x402.client();
      const onComplete = vi.fn<(phase: PayPhase) => void>();
      const onCancel = vi.fn();
      const view = render(
        <PayView
          url={seller}
          method="GET"
          deps={{
            client,
            apiBaseUrl: api,
            url: seller,
            probeOptions: { method: 'GET', headers: {} },
            signOptions: { timeoutMs: 30000 },
            showBody: true,
            interval: 0.01,
          }}
          onComplete={onComplete}
          onCancel={onCancel}
        />,
      );
      try {
        await vi.waitFor(() => expect(view.lastFrame()).toContain('Bank verification required'));
        await vi.waitFor(() => expect(view.stdin.listenerCount('readable')).toBeGreaterThan(0));
        expect(onComplete).not.toHaveBeenCalled();
        view.stdin.write('\r');
        await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith(verificationUrl));
        if (action === 'stop') view.stdin.write('\u001b');
        else verified = true;
        await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
        expect(onComplete.mock.calls[0]?.[0]).toMatchObject(
          action === 'stop'
            ? { kind: 'verification', verification: { waiting: false, reason: 'stopped', transactionId } }
            : { kind: 'success', result: { transactionId, body: 'Purchased content' } },
        );
        expect(created).toBe(1);
        expect(onCancel).not.toHaveBeenCalled();
        expect(paidRequests).toBe(action === 'stop' ? 1 : 2);
        expect(fetch).toHaveBeenCalled();
      } finally {
        view.unmount();
      }
    },
  );

  it.each(['free', 'paid', 'rejected'] as const)('saves the %s response without printing the body', async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), 'inflow-x402-view-'));
    const outputFile = join(directory, 'response.txt');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    if (outcome !== 'free') {
      fetchSpy.mockResolvedValueOnce(
        new Response(null, {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired()) },
        }),
      );
    }
    fetchSpy.mockResolvedValueOnce(new Response('seller response', { status: outcome === 'rejected' ? 403 : 200 }));
    const preparePayment = vi.fn(() => Promise.resolve(prepared()));
    const client = makeClient({ prepareInflowPayment: preparePayment });
    const onComplete = vi.fn<(phase: PayPhase) => void>();
    const view = render(
      <PayView
        url="https://seller/api"
        method="GET"
        deps={{
          client,
          apiBaseUrl: 'https://api.inflowpay.ai',
          probeOptions: { method: 'GET', headers: {} },
          url: 'https://seller/api',
          signOptions: { timeoutMs: 60_000 },
          showBody: true,
          outputFile,
        }}
        onComplete={onComplete}
      />,
    );
    try {
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
      expect(onComplete.mock.calls[0]?.[0]).toMatchObject({
        kind: outcome === 'free' ? 'no-payment-final' : outcome === 'paid' ? 'success' : 'replay-rejected',
        result: { outputSavedTo: outputFile },
      });
      expect(await readFile(outputFile, 'utf8')).toBe('seller response');
      expect(view.lastFrame()).toContain('Saved to:');
      expect(view.lastFrame()).not.toContain('seller response');
      expect(preparePayment).toHaveBeenCalledTimes(outcome === 'free' ? 0 : 1);
      expect(fetchSpy).toHaveBeenCalledTimes(outcome === 'free' ? 1 : 2);
    } finally {
      view.unmount();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('waits for remote approval cancellation before completing', async () => {
    const header = encodePaymentRequiredHeader(paymentRequired());
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', { status: 402, headers: { 'PAYMENT-REQUIRED': header } }),
    );
    const pending = prepared();
    pending.awaitPayload = () => new Promise<EncodedPayment>(() => undefined);
    const client = makeClient({ prepareInflowPayment: vi.fn(() => Promise.resolve(pending)) });
    let completeCancellation: (() => void) | undefined;
    const onCancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completeCancellation = resolve;
        }),
    );
    const onComplete = vi.fn();
    const view = render(
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
        onCancel={onCancel}
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Approval required'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://app.inflowpay.ai/approvals/appr_1/view/'));
    expect(onCancel).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    view.stdin.write('\u001b');
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalledWith('appr_1'));
    expect(onComplete).not.toHaveBeenCalled();
    completeCancellation?.();
    await vi.waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ code: 'APPROVAL_CANCELLED' })),
    );
    view.unmount();
  });

  it.each([false, true])(
    'keeps the approval open when cancellation is unavailable (missing handler=%s)',
    async (missingHandler) => {
      const header = encodePaymentRequiredHeader(paymentRequired());
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('payment required', { status: 402, headers: { 'PAYMENT-REQUIRED': header } }),
      );
      const pending = prepared();
      pending.awaitPayload = () => new Promise<EncodedPayment>(() => undefined);
      const onComplete = vi.fn();
      const view = render(
        <PayView
          url="https://seller/api"
          method="GET"
          deps={{
            client: makeClient({ prepareInflowPayment: vi.fn(() => Promise.resolve(pending)) }),
            apiBaseUrl: 'https://api.inflowpay.ai',
            probeOptions: { method: 'GET', headers: {} },
            url: 'https://seller/api',
            signOptions: { timeoutMs: 60_000 },
            showBody: false,
          }}
          {...(missingHandler ? {} : { onCancel: () => Promise.reject(new Error('offline')) })}
          onComplete={onComplete}
        />,
      );

      await vi.waitFor(() => expect(view.lastFrame()).toContain('Approval required'));
      view.stdin.write('\u001b');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Unable to cancel approval'));
      expect(onComplete).not.toHaveBeenCalled();
      view.unmount();
    },
  );

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

  it.each([false, true])(
    'renders the no-match error with a Gateway-specific message when appropriate: %s',
    async (gateway) => {
      const document = paymentRequired();
      const header = encodePaymentRequiredHeader({
        ...document,
        accepts: gateway
          ? document.accepts.map((offer) => ({ ...offer, extra: { name: 'GatewayWalletBatched' } }))
          : document.accepts,
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('payment required', {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': header },
        }),
      );
      const client = makeClient({
        selectInflowRequirement: vi.fn(() => Promise.resolve(null)),
      });
      const prepare = vi.spyOn(client, 'prepareInflowPayment');
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
      if (gateway) expect(lastFrame()).toContain('Circle Gateway payments are not supported by InFlow.');
      expect(prepare).not.toHaveBeenCalled();
      unmount();
    },
  );

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
