import {
  encode,
  HEADERS,
  type MppChallenge,
  MppClient,
  type MppReceipt,
  renderChallengeHeader,
} from '@inflowpayai/mpp';
import type { MppPayPhase, MppPayPipelineDeps } from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it.each(['stop', 'complete'] as const)(
    'handles bank verification without creating a second payment: %s',
    async (action) => {
      const transactionId = '11111111-1111-4111-8111-111111111111';
      const verificationUrl = `https://mpp.test/transactions/${transactionId}/verify/`;
      const offered = {
        ...challenge(),
        request: encode({ amount: '1', currency: 'USD', methodDetails: { rail: 'instrument' } }),
      };
      const credential = encode({ challenge: offered, payload: { transactionId }, source: 'did:web:buyer.test' });
      const createPayment = vi.fn(() => HttpResponse.json({ state: 'ready', credential, transactionId }));
      let verified = false;
      let paidRequests = 0;
      server.use(
        http.get(SELLER, ({ request }) => {
          if (!request.headers.has('Authorization'))
            return new HttpResponse(null, {
              status: 402,
              headers: { 'WWW-Authenticate': renderChallengeHeader(offered) },
            });
          paidRequests += 1;
          return new HttpResponse(verified ? 'Purchased content' : 'Verification required', {
            status: verified ? 200 : 402,
          });
        }),
        http.post(`${INFLOW}/v1/transactions/mpp`, createPayment),
        http.get(`${INFLOW}/v1/transactions/${transactionId}`, () =>
          HttpResponse.json(
            verified
              ? { transactionId, status: 'SETTLED' }
              : { transactionId, status: 'PENDING', nextAction: { type: 'authenticate_card', url: verificationUrl } },
          ),
        ),
      );
      const onComplete = vi.fn<(phase: MppPayPhase) => void>();
      const onCancel = vi.fn();
      const view = render(
        <PayView
          url={SELLER}
          method="GET"
          deps={{ ...deps(), maxAttempts: 0 }}
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
        expect(createPayment).toHaveBeenCalledOnce();
        expect(onCancel).not.toHaveBeenCalled();
        expect(paidRequests).toBe(action === 'stop' ? 1 : 2);
      } finally {
        view.unmount();
      }
    },
  );

  it.each([false, true])('saves response bytes without printing them (payment required: %s)', async (paid) => {
    const directory = await mkdtemp(join(tmpdir(), 'inflow-pay-view-'));
    const outputFile = join(directory, 'response.bin');
    const body = new Uint8Array([0, 255, 128, 10]);
    const createPayment = vi.fn(() => HttpResponse.json({ state: 'ready', credential: 'CRED', transactionId: 'tx-1' }));
    server.use(
      http.get(SELLER, ({ request }) => {
        if (paid && request.headers.get('authorization') === null) {
          return new HttpResponse(null, {
            status: 402,
            headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) },
          });
        }
        return new HttpResponse(body, { headers: { 'Content-Type': 'application/octet-stream' } });
      }),
      http.post(`${INFLOW}/v1/transactions/mpp`, createPayment),
    );
    const onComplete = vi.fn<(phase: MppPayPhase) => void>();
    const view = render(<PayView url={SELLER} method="GET" deps={{ ...deps(), outputFile }} onComplete={onComplete} />);
    try {
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
      expect(onComplete.mock.calls[0]?.[0]).toMatchObject({
        kind: paid ? 'success' : 'no-payment-final',
        result: { outputSavedTo: outputFile, bodySizeBytes: 4 },
      });
      expect(await readFile(outputFile)).toEqual(Buffer.from(body));
      expect(view.lastFrame()).toContain('Saved to:');
      expect(view.lastFrame()).not.toContain('response body:');
      expect(createPayment).toHaveBeenCalledTimes(paid ? 1 : 0);
    } finally {
      view.unmount();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('allows retrying cancellation after a failed attempt without creating another payment', async () => {
    const createPayment = vi.fn(() =>
      HttpResponse.json({ state: 'pending', transactionId: 'tx-1', approvalId: 'ap-9' }),
    );
    server.use(
      http.get(
        SELLER,
        () =>
          new HttpResponse(null, {
            status: 402,
            headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) },
          }),
      ),
      http.post(`${INFLOW}/v1/transactions/mpp`, createPayment),
    );
    const onCancel = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
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
    try {
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Approval required'));
      view.stdin.write('\u001b');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Unable to cancel approval'));
      expect(onComplete).not.toHaveBeenCalled();
      view.stdin.write('\u001b');
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ code: 'APPROVAL_CANCELLED' }));
      expect(onCancel.mock.calls).toEqual([['ap-9'], ['ap-9']]);
      expect(createPayment).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
    }
  });

  it.each(['card', 'inflow'])('shows the %s amount while creation is in progress', async (method) => {
    const request =
      method === 'card'
        ? {
            amount: '100',
            currency: 'usd',
            recipient: 'acct_test',
            methodDetails: {
              merchantName: 'Store',
              acceptedNetworks: ['visa'],
              encryptionJwk: { kty: 'RSA', alg: 'RSA-OAEP-256', use: 'enc', kid: 'test', n: 'AQAB', e: 'AQAB' },
            },
          }
        : {};
    const offered = { ...challenge(), method, request: encode(request) };
    let finishCreation: (() => void) | undefined;
    const creation = new Promise<void>((resolve) => {
      finishCreation = resolve;
    });
    server.use(
      http.get(
        SELLER,
        () => new HttpResponse(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(offered) } }),
      ),
      http.post(`${INFLOW}/v1/transactions/mpp`, async () => {
        await creation;
        return HttpResponse.json({ state: 'pending', transactionId: 'tx-1', approvalId: 'ap-9' });
      }),
    );
    const view = render(
      <PayView
        url={SELLER}
        method="GET"
        deps={{
          ...deps(),
          interval: 0,
          awaitPayment: false,
          ...(method === 'card' ? { merchantUrl: 'https://store.test', merchantCountry: 'US' } : {}),
        }}
        onComplete={vi.fn()}
      />,
    );
    try {
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Fulfilling'));
      expect(view.lastFrame()).toContain(method === 'card' ? '100 cents usd' : '—');
      finishCreation?.();
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Approval required'));
    } finally {
      finishCreation?.();
      view.unmount();
    }
  });
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

  it.each([false, true])('renders a seller rejection with response body visibility=%s', async (showBody) => {
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
    const { lastFrame, unmount } = render(
      <PayView url={SELLER} method="GET" deps={{ ...deps(), showBody }} onComplete={vi.fn()} />,
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(lastFrame() ?? '').toContain('not accepted by seller');
    expect((lastFrame() ?? '').includes('nope')).toBe(showBody);
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

  it.each([undefined, 'ap-9'])('renders a pending payment with approval ID %s', async (approvalId) => {
    vi.mocked(openUrl).mockClear();
    server.use(
      http.get(
        SELLER,
        () =>
          new HttpResponse(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) } }),
      ),
      http.post(`${INFLOW}/v1/transactions/mpp`, () =>
        HttpResponse.json({
          state: 'pending',
          transactionId: 'tx-1',
          ...(approvalId === undefined ? {} : { approvalId }),
          retryAfterSeconds: 5,
        }),
      ),
    );
    const { lastFrame, stdin, unmount } = render(
      <PayView url={SELLER} method="GET" deps={{ ...deps(), awaitPayment: false }} onComplete={vi.fn()} />,
    );
    await new Promise((r) => setTimeout(r, 120));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Approval required');
    if (approvalId === undefined) expect(frame).not.toContain('Open:');
    else expect(frame).toContain(approvalId);
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 120));
    if (approvalId === undefined) expect(openUrl).not.toHaveBeenCalled();
    else expect(openUrl).toHaveBeenCalledWith(expect.stringContaining(approvalId));
    unmount();
  });

  it.each(['inflow', 'card'])('waits for remote %s approval cancellation before completing', async (method) => {
    const offered =
      method === 'card'
        ? {
            ...challenge(),
            method,
            request: encode({
              amount: '100',
              currency: 'usd',
              recipient: 'acct_test',
              methodDetails: {
                merchantName: 'Store',
                acceptedNetworks: ['visa'],
                encryptionJwk: { kty: 'RSA', alg: 'RSA-OAEP-256', use: 'enc', kid: 'test', n: 'AQAB', e: 'AQAB' },
              },
            }),
          }
        : challenge();
    server.use(
      http.get(
        SELLER,
        () => new HttpResponse(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(offered) } }),
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
        deps={{
          ...deps(),
          awaitPayment: false,
          ...(method === 'card' ? { merchantUrl: 'https://store.test', merchantCountry: 'US' } : {}),
        }}
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

  it.each([false, true])(
    'keeps the approval open when cancellation is unavailable (missing handler=%s)',
    async (missingHandler) => {
      server.use(
        http.get(
          SELLER,
          () =>
            new HttpResponse(null, {
              status: 402,
              headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) },
            }),
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

  it.each([undefined, 'seller-plan'])('shows recurring terms with seller reference %s', async (externalId) => {
    const subscriptionChallenge: MppChallenge = {
      ...challenge(),
      intent: 'subscription',
      request: encode({
        amount: '12.5',
        currency: 'USD',
        ...(externalId === undefined ? {} : { externalId }),
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
    if (externalId === undefined) expect(frame).not.toContain('seller reference:');
    else expect(frame).toContain('seller reference: seller-plan');
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
