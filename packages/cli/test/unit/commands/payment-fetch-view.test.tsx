import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import {
  PaymentFetchView,
  type PaymentFetchPhase,
  type PaymentFetchViewProps,
} from '../../../src/commands/payment-fetch.js';

async function* eventsFor(final: PaymentFetchPhase): AsyncGenerator<never> {
  await Promise.resolve();
  if (final.kind === 'replaying') return;
  yield { type: 'replaying', response: {} as never } as never;
  if (final.kind === 'completed') {
    yield { type: 'replayed', result: final.result } as never;
    return;
  }
  if (final.kind === 'rejected') {
    yield { type: 'rejected', result: final.result } as never;
    return;
  }
  if (final.kind === 'error') {
    yield {
      type: 'errored',
      code: final.code,
      message: final.message,
      ...(final.retryable !== undefined ? { retryable: final.retryable } : {}),
    } as never;
  }
}

describe('PaymentFetchView', () => {
  it.each(['event', 'rejection'] as const)('ignores a late %s after the view is unmounted', async (completion) => {
    const onComplete = vi.fn();
    let release = () => undefined as void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finish = () => undefined as void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let signal: AbortSignal | undefined;
    const events: PaymentFetchViewProps['events'] = async function* (input) {
      signal = input;
      try {
        await pending;
        if (completion === 'rejection') throw new Error('Request aborted');
        yield { type: 'errored', code: 'PAYMENT_FAILED', message: 'Late failure' };
      } finally {
        finish();
      }
    };
    const view = render(
      <PaymentFetchView
        protocol="MPP"
        transactionId="tx-1"
        url="https://seller.test/api"
        method="GET"
        paymentHeader="Authorization: Payment"
        events={events}
        onComplete={onComplete}
      />,
    );
    await vi.waitFor(() => expect(signal).toBeDefined());
    view.unmount();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    release();
    await finished;
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('routes Escape to the authentication approval rather than cancelling the payment wait', async () => {
    const onComplete = vi.fn();
    const cancel = vi.fn(() => Promise.resolve());
    let signal: AbortSignal | undefined;
    async function* waiting(input: AbortSignal): AsyncGenerator<never> {
      signal = input;
      await new Promise<void>((resolve) => input.addEventListener('abort', () => resolve(), { once: true }));
    }
    const view = render(
      <PaymentFetchView
        protocol="MPP"
        transactionId="tx-1"
        url="https://seller.test/api"
        method="GET"
        paymentHeader="Authorization: Payment"
        events={waiting}
        onComplete={onComplete}
        authenticationApproval={{
          approvalId: 'authentication-1',
          approvalUrl: 'https://platform.test/approvals/authentication-1',
          cancel,
        }}
      />,
    );
    try {
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Authentication approval required'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      view.stdin.write('\u001b');
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(onComplete).not.toHaveBeenCalled();
      expect(signal?.aborted).toBe(false);
    } finally {
      view.unmount();
    }
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it('stops a payment wait on Escape and aborts its polling signal', async () => {
    const onComplete = vi.fn();
    let pollingSignal: AbortSignal | undefined;
    async function* waitingEvents(signal: AbortSignal): AsyncGenerator<never> {
      pollingSignal = signal;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    }
    const view = render(
      <PaymentFetchView
        protocol="MPP"
        transactionId="tx-1"
        url="https://seller.test/api"
        method="GET"
        paymentHeader="Authorization: Payment"
        events={waitingEvents}
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Press Escape to stop waiting'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    view.stdin.write('\u001b');
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith({ kind: 'cancelled' }));
    expect(pollingSignal?.aborted).toBe(true);
    view.unmount();
  });

  it('renders completed fetches without credential material', async () => {
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <PaymentFetchView
        protocol="MPP"
        transactionId="tx-1"
        url="https://seller.test/api"
        method="GET"
        paymentHeader="Authorization: Payment"
        events={() =>
          eventsFor({
            kind: 'completed',
            result: {
              protocol: 'mpp',
              outcome: 'paid',
              transactionId: 'tx-1',
              url: 'https://seller.test/api',
              method: 'GET',
              responseStatus: 200,
              responseContentType: 'application/json',
              bodySizeBytes: 13,
              body: '{"ok":true}',
              outputSavedTo: '/tmp/paid.json',
              settled: { reference: 'receipt-1' },
            },
          })
        }
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(lastFrame()).toContain('Paid and fetched seller resource');
    expect(lastFrame()).toContain('status: 200');
    expect(lastFrame()).toContain('settled: success (ref receipt-1)');
    expect(lastFrame()).toContain('/tmp/paid.json');
    expect(lastFrame()).toContain('{"ok":true}');
    expect(lastFrame()).not.toContain('credential');
    unmount();
  });

  it('renders x402 settlement summaries', async () => {
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <PaymentFetchView
        protocol="x402"
        transactionId="txn-1"
        url="https://seller.test/api"
        method="GET"
        paymentHeader="PAYMENT-SIGNATURE"
        events={() =>
          eventsFor({
            kind: 'completed',
            result: {
              protocol: 'x402',
              outcome: 'paid',
              transactionId: 'txn-1',
              url: 'https://seller.test/api',
              method: 'GET',
              responseStatus: 200,
              responseContentType: undefined,
              bodySizeBytes: 0,
              settled: { transaction: '0xabc' },
            },
          })
        }
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(lastFrame()).toContain('settled: 0xabc');
    unmount();
  });

  it('renders x402 network settlement summaries', async () => {
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <PaymentFetchView
        protocol="x402"
        transactionId="txn-1"
        url="https://seller.test/api"
        method="GET"
        paymentHeader="PAYMENT-SIGNATURE"
        events={() =>
          eventsFor({
            kind: 'completed',
            result: {
              protocol: 'x402',
              outcome: 'paid',
              transactionId: 'txn-1',
              url: 'https://seller.test/api',
              method: 'GET',
              responseStatus: 200,
              responseContentType: undefined,
              bodySizeBytes: 0,
              settled: { network: 'inflow:1' },
            },
          })
        }
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(lastFrame()).toContain('settled: inflow:1');
    unmount();
  });

  it('omits empty settlement summaries', async () => {
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <PaymentFetchView
        protocol="x402"
        transactionId="txn-1"
        url="https://seller.test/api"
        method="GET"
        paymentHeader="PAYMENT-SIGNATURE"
        events={() =>
          eventsFor({
            kind: 'completed',
            result: {
              protocol: 'x402',
              outcome: 'paid',
              transactionId: 'txn-1',
              url: 'https://seller.test/api',
              method: 'GET',
              responseStatus: 200,
              responseContentType: undefined,
              bodySizeBytes: 0,
              settled: {},
            },
          })
        }
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(lastFrame()).not.toContain('settled:');
    unmount();
  });

  it('renders rejected fetches and reports the final phase', async () => {
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <PaymentFetchView
        protocol="x402"
        transactionId="txn-1"
        url="https://seller.test/api"
        method="POST"
        paymentHeader="PAYMENT-SIGNATURE"
        events={() =>
          eventsFor({
            kind: 'rejected',
            result: {
              protocol: 'x402',
              outcome: 'replay-rejected',
              transactionId: 'txn-1',
              url: 'https://seller.test/api',
              method: 'POST',
              responseStatus: 402,
              responseContentType: undefined,
              bodySizeBytes: 2,
            },
          })
        }
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(lastFrame()).toContain('Seller rejected the payment replay');
    expect(lastFrame()).toContain('status: 402');
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rejected' }));
    unmount();
  });

  it('renders rejected fetch content types', async () => {
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <PaymentFetchView
        protocol="x402"
        transactionId="txn-1"
        url="https://seller.test/api"
        method="POST"
        paymentHeader="PAYMENT-SIGNATURE"
        events={() =>
          eventsFor({
            kind: 'rejected',
            result: {
              protocol: 'x402',
              outcome: 'replay-rejected',
              transactionId: 'txn-1',
              url: 'https://seller.test/api',
              method: 'POST',
              responseStatus: 402,
              responseContentType: 'application/json',
              bodySizeBytes: 2,
            },
          })
        }
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(lastFrame()).toContain('content type: application/json');
    unmount();
  });

  it('renders explicit error events', async () => {
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <PaymentFetchView
        protocol="MPP"
        transactionId="tx-1"
        url="https://seller.test/api"
        method="GET"
        paymentHeader="Authorization: Payment"
        events={() =>
          eventsFor({ kind: 'error', code: 'PAYMENT_NOT_READY', message: 'Still waiting.', retryable: true })
        }
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(lastFrame()).toContain('PAYMENT_NOT_READY');
    expect(lastFrame()).toContain('Still waiting.');
    unmount();
  });

  it('renders non-retryable explicit error events', async () => {
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <PaymentFetchView
        protocol="MPP"
        transactionId="tx-1"
        url="https://seller.test/api"
        method="GET"
        paymentHeader="Authorization: Payment"
        events={() => eventsFor({ kind: 'error', code: 'PAYMENT_FAILED', message: 'No credential.' })}
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(lastFrame()).toContain('PAYMENT_FAILED');
    unmount();
  });

  it.each([new Error('network down'), 'network down'])(
    'renders unexpected event stream failures: %s',
    async (failure) => {
      const onComplete = vi.fn();
      async function* failingEvents(): AsyncGenerator<never> {
        await vi.fn().mockRejectedValue(failure)();
      }
      const { lastFrame, unmount } = render(
        <PaymentFetchView
          protocol="x402"
          transactionId="txn-1"
          url="https://seller.test/api"
          method="GET"
          paymentHeader="PAYMENT-SIGNATURE"
          events={failingEvents}
          onComplete={onComplete}
        />,
      );

      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
      expect(lastFrame()).toContain('PAYMENT_FETCH_FAILED');
      expect(lastFrame()).toContain('network down');
      unmount();
    },
  );
});
