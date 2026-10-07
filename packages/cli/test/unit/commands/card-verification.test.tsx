import { Inflow, MemoryStorage, type CardVerification, type CardVerificationEvent } from '@inflowpayai/inflow-core';
import { encode, renderChallengeHeader } from '@inflowpayai/mpp';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { render } from 'ink-testing-library';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PayView as MppPayView } from '../../../src/commands/mpp/pay.js';
import { PayView as X402PayView } from '../../../src/commands/x402/pay.js';
import { __testing as mppCommands } from '../../../src/commands/mpp/index.js';
import { __testing as x402Commands } from '../../../src/commands/x402/index.js';
import { PaymentFetchView } from '../../../src/commands/payment-fetch.js';
import { CardVerificationView, cardVerificationFrame } from '../../../src/commands/payment-verification.js';
import { openUrl } from '../../../src/utils/open-url.js';
import * as mppSchemas from '../../../src/commands/mpp/schema.js';
import * as x402Schemas from '../../../src/commands/x402/schema.js';

vi.mock('../../../src/utils/open-url.js', () => ({ openUrl: vi.fn() }));
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());
const API = 'https://api.inflowpay.ai';
const ID = '11111111-1111-4111-8111-111111111111';
const URL = `https://app.inflowpay.ai/transactions/${ID}/verify/`;
const SELLER = 'https://seller.test/search';
const verification: CardVerification = {
  transactionId: ID,
  url: SELLER,
  method: 'POST',
  verificationUrl: URL,
  waiting: true,
  reason: 'action-required',
};
const continuationOptions = {
  interval: 0,
  maxAttempts: 0,
  timeout: 120,
  showBody: false,
  outputFile: 'result.json',
  header: [],
};

describe('bank verification presentation', () => {
  it('fetch moves from verification to replay without prematurely finishing', async () => {
    const onComplete = vi.fn();
    async function* events(): AsyncGenerator<CardVerificationEvent> {
      await Promise.resolve();
      yield { type: 'verification-required', verification };
      yield { type: 'verification-completed' };
    }
    const view = render(
      <PaymentFetchView
        protocol="MPP"
        transactionId={ID}
        url={SELLER}
        method="POST"
        paymentHeader="Payment"
        events={events}
        onComplete={onComplete}
      />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Fetching POST'));
    expect(onComplete).not.toHaveBeenCalled();
    view.unmount();
  });
  it.each(['mpp', 'x402'] as const)(
    '%s pay Escape stops verification without cancelling Approval',
    async (protocol) => {
      const challenge = {
        id: 'challenge',
        method: 'inflow',
        intent: 'charge',
        realm: 'seller.test',
        request: encode({ amount: '1', currency: 'USD', methodDetails: { rail: 'instrument' } }),
      };
      const accept = {
        scheme: 'instrument',
        network: 'inflow:1' as const,
        asset: 'USD',
        amount: '1000000000000000000',
        payTo: ID,
        maxTimeoutSeconds: 300,
        extra: {},
      };
      const payload = { x402Version: 2, accepted: accept, payload: { transactionId: ID } };
      let submissions = 0;
      let replays = 0;
      server.use(
        http.post(SELLER, ({ request }) => {
          if (request.headers.has('Authorization') || request.headers.has('PAYMENT-SIGNATURE')) replays++;
          return new HttpResponse(null, {
            status: 402,
            headers:
              protocol === 'mpp'
                ? { 'WWW-Authenticate': renderChallengeHeader(challenge) }
                : {
                    'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
                      x402Version: 2,
                      resource: { url: SELLER },
                      accepts: [accept],
                    }),
                  },
          });
        }),
        http.get(`${API}/v1/transactions/x402-supported`, () =>
          HttpResponse.json({ kinds: [{ scheme: 'instrument', network: 'inflow:1', x402Version: 2 }] }),
        ),
        http.post(`${API}/v1/transactions/${protocol}`, () => {
          submissions++;
          return HttpResponse.json({ state: 'ready', transactionId: ID, approvalId: ID, credential: 'credential' });
        }),
        http.get(`${API}/v1/transactions/${ID}/x402`, () =>
          HttpResponse.json({ status: 'PENDING', encodedPayload: encode(payload), paymentPayload: payload }),
        ),
        http.get(`${API}/v1/transactions/${ID}`, () =>
          HttpResponse.json({
            transactionId: ID,
            status: 'PENDING',
            nextAction: { type: 'authenticate_card', url: URL },
          }),
        ),
      );
      const inflow = new Inflow({ apiKey: 'test-key', apiBaseUrl: API });
      const common = {
        url: SELLER,
        apiBaseUrl: API,
        probeOptions: { method: 'POST', headers: {}, data: '{}' },
        showBody: false,
        interval: 5,
        maxAttempts: 0,
        timeout: 900,
      };
      const onComplete = vi.fn();
      const onCancel = vi.fn();
      const view =
        protocol === 'mpp'
          ? render(
              <MppPayView
                url={SELLER}
                method="POST"
                deps={{ ...common, client: await inflow.mpp.client() }}
                onComplete={onComplete}
                onCancel={onCancel}
              />,
            )
          : render(
              <X402PayView
                url={SELLER}
                method="POST"
                deps={{ ...common, client: await inflow.x402.client(), signOptions: {} }}
                onComplete={onComplete}
                onCancel={onCancel}
              />,
            );
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Bank verification required'));
      await new Promise((resolve) => setTimeout(resolve, 30));
      view.stdin.write('\r');
      await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith(URL));
      view.stdin.write('\u001b');
      await vi.waitFor(() =>
        expect(onComplete).toHaveBeenCalledWith({
          kind: 'verification',
          verification: { ...verification, waiting: false, reason: 'stopped' },
        }),
      );
      expect(onCancel).not.toHaveBeenCalled();
      expect(submissions).toBe(1);
      expect(replays).toBe(1);
      view.unmount();
    },
  );

  it.each(['MPP', 'x402'] as const)('%s fetch Escape aborts only the wait', async (protocol) => {
    const onComplete = vi.fn();
    let signal: AbortSignal | undefined;
    async function* events(input: AbortSignal): AsyncGenerator<CardVerificationEvent> {
      signal = input;
      yield { type: 'verification-required', verification };
      await new Promise<void>((resolve) => input.addEventListener('abort', () => resolve(), { once: true }));
    }
    const view = render(
      <PaymentFetchView
        protocol={protocol}
        transactionId={ID}
        url={SELLER}
        method="POST"
        paymentHeader="Payment"
        events={events}
        onComplete={onComplete}
      />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Bank verification required'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    view.stdin.write('\u001b');
    await vi.waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith({
        kind: 'verification',
        verification: { ...verification, waiting: false, reason: 'stopped' },
      }),
    );
    expect(signal?.aborted).toBe(true);
    view.unmount();
  });

  it('renders a waiting limit without claiming payment cancellation', () => {
    const view = render(
      <CardVerificationView
        protocol="mpp"
        verification={{ ...verification, waiting: false, reason: 'timeout' }}
        onStop={vi.fn()}
      />,
    );
    expect(view.lastFrame()).toContain('waiting limit');
    expect(view.lastFrame()?.replaceAll(/\s+/g, ' ')).toContain('Do not start another payment');
    view.unmount();
  });

  it('omits a copyable command when the original body or headers must be supplied', () => {
    const frame = cardVerificationFrame(
      'mpp',
      { ...verification, waiting: false },
      { ...continuationOptions, data: 'private' },
    );
    expect(frame).toMatchObject({
      outcome: 'verification-required',
      _next: { requires_original_request_options: true },
    });
    expect(frame['_next']).not.toHaveProperty('command');
    expect(cardVerificationFrame('x402', { ...verification, waiting: false }, continuationOptions)).toHaveProperty(
      '_next.command',
      `x402 fetch ${ID} ${SELLER} --interval 5 --max-attempts 0 --timeout 120 --method POST --output-file result.json --no-show-body`,
    );
  });

  it.each(['mpp', 'x402'] as const)('%s waiting frames do not suggest a competing Fetch', (protocol) => {
    expect(cardVerificationFrame(protocol, verification, continuationOptions)).not.toHaveProperty('_next');
    const view = render(<CardVerificationView protocol={protocol} verification={verification} onStop={vi.fn()} />);
    expect(view.lastFrame()).not.toContain('Resume:');
    expect(view.lastFrame()).toContain(URL);
    view.unmount();
  });

  it.each(['mpp', 'x402'] as const)('%s stopped and timeout frames retain Fetch options', (protocol) => {
    for (const reason of ['stopped', 'timeout'] as const) {
      const frame = cardVerificationFrame(
        protocol,
        { ...verification, waiting: false, reason },
        { ...continuationOptions, interval: 7, maxAttempts: 12 },
      );
      const next = frame['_next'] as { tool: string; input: Record<string, unknown> };
      const schema = protocol === 'mpp' ? mppSchemas : x402Schemas;
      expect(next.tool).toBe(`${protocol}_fetch`);
      expect(schema.fetchArgs.parse(next.input)).toEqual({ transactionId: ID, resourceUrl: SELLER });
      expect(schema.fetchOptions.parse(next.input)).toMatchObject({
        method: 'POST',
        interval: 7,
        maxAttempts: 12,
        timeout: 120,
        showBody: false,
        outputFile: 'result.json',
      });
    }
  });

  it.each(
    (['mpp', 'x402'] as const).flatMap((protocol) => ['body', 'header', 'none'].map((mode) => ({ protocol, mode }))),
  )('$protocol commands emit structured verification with $mode request options', async ({ protocol, mode }) => {
    const inflow = new Inflow({ apiKey: 'test-key', apiBaseUrl: API });
    const storage = new MemoryStorage();
    async function* events(): AsyncGenerator<CardVerificationEvent> {
      await Promise.resolve();
      yield { type: 'verification-required', verification: { ...verification, waiting: false } };
    }
    vi.spyOn(inflow[protocol], 'pay').mockReturnValue({ events: events() });
    vi.spyOn(inflow[protocol], 'fetch').mockReturnValue({ events: events() });
    const options = {
      method: 'POST',
      header: mode === 'header' ? ['X-Private: value'] : [],
      interval: 0,
      maxAttempts: 0,
      timeout: 900,
      showBody: false,
      ...(mode === 'body' ? { data: '{"private":"body"}' } : {}),
    };
    const error = vi.fn((): never => {
      throw new Error('unexpected error');
    });
    const commands = protocol === 'mpp' ? mppCommands : x402Commands;
    const pay = commands.runPayCommand(
      { agent: true, formatExplicit: true, args: { url: SELLER }, options, error },
      inflow,
      storage,
      API,
    );
    const fetch = commands.runFetchCommand(
      { agent: true, formatExplicit: true, args: { transactionId: ID, resourceUrl: SELLER }, options, error },
      inflow,
      storage,
    );
    for (const run of [pay, fetch]) {
      const frames: unknown[] = [];
      for await (const frame of run) frames.push(frame);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({
        outcome: 'verification-required',
        transaction_id: ID,
        verification_url: URL,
        waiting: false,
        _next: {
          tool: `${protocol}_fetch`,
          requires_original_request_options: mode !== 'none',
          input: {
            transactionId: ID,
            resourceUrl: SELLER,
            method: 'POST',
            interval: 5,
            maxAttempts: 0,
            timeout: 900,
            showBody: false,
          },
        },
      });
      expect(JSON.stringify(frames)).not.toContain('private');
    }
  });
});
