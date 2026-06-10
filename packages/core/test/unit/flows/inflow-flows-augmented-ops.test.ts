import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import type * as x402Buyer from '@inflowpayai/x402-buyer';
import { Inflow, MemoryStorage } from '../../../src/index.js';
import type { AuthStatusFrame } from '../../../src/auth/poll.js';
import { BASE_URL, userHappy } from '../fixtures/handlers.js';
import { makeServer } from '../fixtures/server.js';

vi.mock('@inflowpayai/x402-buyer', async (importOriginal) => {
  const actual = await importOriginal<typeof x402Buyer>();
  return {
    ...actual,
    createInflowClient: vi.fn(() =>
      Promise.resolve({
        getSupported: vi.fn(() => Promise.resolve({ kinds: [] })),
        selectInflowRequirement: () => null,
        getX402Payload: vi.fn(() => Promise.resolve({ status: 'INITIATED' as const })),
        cancelApproval: vi.fn(() => Promise.resolve(undefined)),
        prepareInflowPayment: vi.fn(),
      }),
    ),
  };
});

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function drainEvents<E>(iterable: AsyncIterable<E>): Promise<E[]> {
  const out: E[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe('Inflow.auth augmented operations (with storage configured)', () => {
  it('auth.snapshot composes the unauthenticated frame from empty storage', () => {
    const client = new Inflow({ apiBaseUrl: BASE_URL, authStorage: new MemoryStorage() });
    expect(client.auth.snapshot()).toEqual({ authenticated: false });
  });

  it('auth.loginApiKey validates against the user endpoint and persists the key', async () => {
    server.use(userHappy);
    const storage = new MemoryStorage();
    const client = new Inflow({ apiBaseUrl: BASE_URL, apiKey: 'inflow_test_key', authStorage: storage });
    const events = await drainEvents(
      client.auth.loginApiKey({ apiKey: 'inflow_test_key', connection: { environment: 'sandbox' } }).events,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'validated', user: { userId: 'u-1' } });
    expect(storage.getApiKey()).toBe('inflow_test_key');
    expect(storage.getConnection()).toEqual({ environment: 'sandbox' });
  });

  it('auth.probeStatus reports unauthenticated without a server probe when storage is empty', async () => {
    const client = new Inflow({ apiBaseUrl: BASE_URL, authStorage: new MemoryStorage() });
    const out = await client.auth.probeStatus();
    expect(out.kind).toBe('unauthenticated');
    if (out.kind === 'unauthenticated') {
      expect(out.frame).toEqual({ authenticated: false });
    }
  });

  it('auth.pollStatus terminates with a max_attempts reason when nothing authenticates', async () => {
    const client = new Inflow({ apiBaseUrl: BASE_URL, authStorage: new MemoryStorage() });
    const frames = await drainEvents<AuthStatusFrame>(
      client.auth.pollStatus({ interval: 0.01, maxAttempts: 1, timeout: 30 }),
    );
    expect(frames.length).toBeGreaterThan(0);
    const terminal = frames.at(-1) as unknown as Record<string, unknown>;
    expect(terminal.authenticated).toBe(false);
    expect(terminal.reason).toBe('max_attempts');
  });
});

describe('Inflow.x402 augmented operations', () => {
  it('x402.pay drains the async-iterable to a short-circuited terminal using the resolved apiBaseUrl', async () => {
    server.use(http.get('https://seller.test/free', () => new HttpResponse('FREE', { status: 200 })));
    const client = new Inflow({ apiBaseUrl: BASE_URL, accessToken: 'tk' });
    const events = await drainEvents(
      client.x402.pay({
        url: 'https://seller.test/free',
        probeOptions: { method: 'GET', headers: {} },
        signOptions: {},
        showBody: true,
      }).events,
    );
    expect(events).toHaveLength(1);
    const terminal = events[0];
    expect(terminal?.type).toBe('short-circuited');
    if (terminal?.type === 'short-circuited') {
      expect(terminal.result.outcome).toBe('no-payment-required');
      expect(terminal.result.body).toBe('FREE');
    }
  });

  it('x402.status polls the lazy buyer client and times out on a never-signed payload', async () => {
    const client = new Inflow({ apiBaseUrl: BASE_URL, accessToken: 'tk' });
    const run = client.x402.status({ transactionId: 'tx-77', interval: 0.01, maxAttempts: 1, timeout: 30 });
    const events = await drainEvents(run.events);
    expect(events.at(-1)?.type).toBe('timedOut');
    const terminal = events.at(-1);
    if (terminal?.type === 'timedOut') {
      expect(terminal.response).toMatchObject({ status: 'INITIATED' });
    }
  });
});
