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

  it('renders the error frame when no inflow challenge is offered', async () => {
    server.use(
      http.get(SELLER, () => {
        const other: MppChallenge = { ...challenge(), id: 'chal-other', method: 'other' };
        return new HttpResponse(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(other) } });
      }),
    );
    const { lastFrame, unmount } = render(<PayView url={SELLER} method="GET" deps={deps()} onComplete={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 120));
    expect(lastFrame() ?? '').toContain('NO_INFLOW_MATCH');
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
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(openUrl)).toHaveBeenCalledWith(expect.stringContaining('ap-9'));
    unmount();
  });
});
