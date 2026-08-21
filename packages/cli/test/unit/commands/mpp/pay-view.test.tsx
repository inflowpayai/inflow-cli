import {
  encode,
  HEADERS,
  type MppChallenge,
  MppClient,
  type MppReceipt,
  renderChallengeHeader,
} from '@inflowpayai/mpp';
import type { MppPayPipelineDeps } from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openUrl } from '../../../../src/utils/open-url.js';
import { PayView } from '../../../../src/commands/mpp/pay.js';

vi.mock('../../../../src/utils/open-url.js', () => ({ openUrl: vi.fn() }));

const SELLER = 'https://seller.test/api';
const INFLOW = 'https://mpp.test';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function challenge(): MppChallenge {
  return {
    id: 'chal-1',
    realm: 'mpp.test',
    method: 'inflow',
    intent: 'charge',
    request: encode({ amount: '10', currency: 'USDC', methodDetails: { rail: 'balance' } }),
  };
}

function deps(): MppPayPipelineDeps {
  return {
    client: new MppClient({ apiKey: 'k', baseUrl: INFLOW }),
    apiBaseUrl: INFLOW,
    url: SELLER,
    probeOptions: { method: 'GET', headers: {} },
    showBody: true,
    interval: 0.01,
    maxAttempts: 5,
    timeout: 30,
  };
}

describe('PayView', () => {
  it('renders the paid frame after a complete pay pipeline', async () => {
    server.use(
      http.get(SELLER, ({ request }) => {
        const auth = request.headers.get('authorization');
        if (auth !== null && /^payment\s/i.test(auth)) return new HttpResponse('PAID', { status: 200 });
        return new HttpResponse(null, {
          status: 402,
          headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) },
        });
      }),
      http.post(`${INFLOW}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'ready', credential: 'CRED', transactionId: 'tx-1' }),
      ),
    );
    const { lastFrame, unmount } = render(<PayView url={SELLER} method="GET" deps={deps()} onComplete={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 120));
    expect(lastFrame() ?? '').toContain('Paid');
    unmount();
  });

  it('renders the no-payment frame when the seller serves 200 on probe', async () => {
    server.use(http.get(SELLER, () => new HttpResponse('FREE', { status: 200 })));
    const { lastFrame, unmount } = render(<PayView url={SELLER} method="GET" deps={deps()} onComplete={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 120));
    expect(lastFrame() ?? '').toContain('without payment');
    unmount();
  });

  it('renders the settlement summary when the paid response carries a Payment-Receipt header', async () => {
    const receipt: MppReceipt = {
      challengeId: 'chal-1',
      method: 'inflow',
      reference: 'ref-42',
      settlement: { amount: '10.5', currency: 'USDC' },
      status: 'success',
      timestamp: '2025-01-01T00:00:00Z',
    };
    server.use(
      http.get(SELLER, ({ request }) => {
        const auth = request.headers.get('authorization');
        if (auth !== null && /^payment\s/i.test(auth)) {
          return new HttpResponse('PAID', { status: 200, headers: { [HEADERS.PAYMENT_RECEIPT]: encode(receipt) } });
        }
        return new HttpResponse(null, {
          status: 402,
          headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) },
        });
      }),
      http.post(`${INFLOW}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'ready', credential: 'CRED', transactionId: 'tx-1' }),
      ),
    );
    const { lastFrame, unmount } = render(<PayView url={SELLER} method="GET" deps={deps()} onComplete={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 150));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Paid');
    expect(frame).toContain('settled');
    expect(frame).toContain('ref-42');
    unmount();
  });

  it('renders the seller-rejected frame when the replay is non-2xx', async () => {
    server.use(
      http.get(SELLER, ({ request }) => {
        const auth = request.headers.get('authorization');
        if (auth !== null && /^payment\s/i.test(auth)) return new HttpResponse('nope', { status: 402 });
        return new HttpResponse(null, {
          status: 402,
          headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) },
        });
      }),
      http.post(`${INFLOW}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'ready', credential: 'CRED', transactionId: 'tx-1' }),
      ),
    );
    const { lastFrame, unmount } = render(<PayView url={SELLER} method="GET" deps={deps()} onComplete={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 150));
    expect(lastFrame() ?? '').toContain('not accepted by seller');
    unmount();
  });

  it('hands terminal errors to the command without rendering a duplicate', async () => {
    server.use(
      http.get(SELLER, () => {
        const other: MppChallenge = { ...challenge(), id: 'chal-other', method: 'other' };
        return new HttpResponse(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(other) } });
      }),
    );
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(<PayView url={SELLER} method="GET" deps={deps()} onComplete={onComplete} />);
    await new Promise((r) => setTimeout(r, 120));
    expect(lastFrame() ?? '').not.toContain('NO_INFLOW_MATCH');
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', code: 'NO_INFLOW_MATCH' }));
    unmount();
  });

  it('renders the approval-required frame for a pending tx and opens the approval URL on Enter', async () => {
    server.use(
      http.get(
        SELLER,
        () =>
          new HttpResponse(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) } }),
      ),
      http.post(`${INFLOW}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'pending', transactionId: 'tx-1', approvalId: 'ap-9', retryAfterSeconds: 5 }),
      ),
    );
    const { lastFrame, stdin, unmount } = render(
      <PayView url={SELLER} method="GET" deps={{ ...deps(), awaitPayment: false }} onComplete={vi.fn()} />,
    );
    await new Promise((r) => setTimeout(r, 120));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Approval required');
    expect(frame).toContain('ap-9');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 120));
    expect(vi.mocked(openUrl)).toHaveBeenCalledWith(expect.stringContaining('ap-9'));
    unmount();
  });

  it('waits for remote approval cancellation before completing', async () => {
    server.use(
      http.get(
        SELLER,
        () =>
          new HttpResponse(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) } }),
      ),
      http.post(`${INFLOW}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'pending', transactionId: 'tx-1', approvalId: 'ap-9', retryAfterSeconds: 5 }),
      ),
    );
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
        url={SELLER}
        method="GET"
        deps={{ ...deps(), awaitPayment: false }}
        onCancel={onCancel}
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Approval required'));
    view.stdin.write('\u001b');
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalledWith('ap-9'));
    expect(onComplete).not.toHaveBeenCalled();
    completeCancellation?.();
    await vi.waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ code: 'APPROVAL_CANCELLED' })),
    );
    view.unmount();
  });

  it('keeps the approval open when remote cancellation fails', async () => {
    server.use(
      http.get(
        SELLER,
        () =>
          new HttpResponse(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) } }),
      ),
      http.post(`${INFLOW}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'pending', transactionId: 'tx-1', approvalId: 'ap-9', retryAfterSeconds: 5 }),
      ),
    );
    const onComplete = vi.fn();
    const view = render(
      <PayView
        url={SELLER}
        method="GET"
        deps={{ ...deps(), awaitPayment: false }}
        onCancel={() => Promise.reject(new Error('offline'))}
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Approval required'));
    view.stdin.write('\u001b');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Unable to cancel approval'));
    expect(onComplete).not.toHaveBeenCalled();
    view.unmount();
  });

  it('shows all recurring terms while subscription approval is pending', async () => {
    const subscriptionChallenge: MppChallenge = {
      ...challenge(),
      intent: 'subscription',
      request: encode({
        amount: '12.5',
        currency: 'USD',
        externalId: 'seller-plan',
        methodDetails: { rail: 'balance' },
        periodCount: 1,
        periodUnit: 'month',
        subscriptionExpires: '2027-08-01T00:00:00Z',
      }),
    };
    server.use(
      http.get(
        SELLER,
        () =>
          new HttpResponse(null, {
            status: 402,
            headers: { 'WWW-Authenticate': renderChallengeHeader(subscriptionChallenge) },
          }),
      ),
      http.post(`${INFLOW}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'pending', transactionId: 'tx-1', approvalId: 'ap-9', retryAfterSeconds: 5 }),
      ),
    );
    const { lastFrame, unmount } = render(
      <PayView url={SELLER} method="GET" deps={{ ...deps(), awaitPayment: false }} onComplete={vi.fn()} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('recurring amount: 12.5 USD');
    expect(frame).toContain('billing period: every 1 month');
    expect(frame).toContain('expires: 2027-08-01T00:00:00Z');
    expect(frame).toContain('seller reference: seller-plan');
    expect(frame).toContain('Either participant can cancel immediately.');
    unmount();
  });

  it('renders an authentication approval before payment approval phases', async () => {
    const delayedProbe = new Promise<{
      bytes: Uint8Array;
      contentType: string | undefined;
      headers: Headers;
      status: number;
    }>((resolve) => {
      setTimeout(
        () => resolve({ bytes: new Uint8Array(), contentType: undefined, headers: new Headers(), status: 200 }),
        100,
      );
    });
    const { lastFrame, stdin, unmount } = render(
      <PayView
        url={SELLER}
        method="GET"
        deps={{
          ...deps(),
          sellerTransport: {
            request: () => delayedProbe,
          },
        }}
        authenticationApproval={{
          approvalId: 'auth-1',
          approvalUrl: 'https://mpp.test/approvals/auth-1/view/',
          cancel: vi.fn(),
        }}
        onComplete={vi.fn()}
      />,
    );

    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Authentication approval required');
    expect(frame).toContain('auth-1');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(openUrl)).toHaveBeenCalledWith('https://mpp.test/approvals/auth-1/view/');
    unmount();
  });
});
