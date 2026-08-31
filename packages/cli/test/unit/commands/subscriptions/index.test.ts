import {
  type AuthTokens,
  Inflow,
  InflowApiError,
  type ISubscriptionResource,
  MemoryStorage,
  type PagedSubscriptions,
  type Subscription,
} from '@inflowpayai/inflow-core';
import {
  CREDENTIAL_TRANSACTION_ID,
  encode,
  encodeCredential,
  type MppChallenge,
  renderChallengeHeader,
} from '@inflowpayai/mpp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testing, createSubscriptionsCli } from '../../../../src/commands/subscriptions/index.js';

const tokens: AuthTokens = {
  access_token: 'access',
  refresh_token: 'refresh',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: Date.now() + 3_600_000,
};

const subscription: Subscription = {
  amount: '10',
  billingAnchor: '2026-08-01T00:00:00Z',
  created: '2026-08-01T00:00:00Z',
  currency: 'USD',
  lastChargedPeriod: 0,
  nextBillingDate: '2026-09-01T00:00:00.123456Z',
  pastDue: '2026-08-31T00:00:00.123456Z',
  period0Amount: '5',
  periodCount: 1,
  periodUnit: 'month',
  sellerName: 'Example Seller',
  sellerWebsite: 'https://shop.example.test/path',
  status: 'ACTIVE',
  subscriptionExpires: '2027-08-01T00:00:00Z',
  subscriptionId: 'subscription-id',
  transactionType: 'MPP',
  updated: '2026-08-01T00:00:00Z',
};

function subscriptionChallengeValue(): MppChallenge {
  return {
    id: 'subscription-challenge',
    intent: 'subscription',
    method: 'inflow',
    realm: 'seller.test',
    request: encode({ amount: '10', currency: 'USD', methodDetails: { rail: 'balance' } }),
  };
}

function subscriptionChallenge(): Response {
  const challenge = subscriptionChallengeValue();
  return new Response(null, {
    status: 402,
    headers: { 'WWW-Authenticate': renderChallengeHeader(challenge) },
  });
}

function context<Options extends Record<string, unknown>, Args extends Record<string, unknown>>(
  options: Options,
  args: Args,
) {
  return {
    agent: true,
    formatExplicit: true,
    options,
    args,
    error: vi.fn((error: { code: string; message: string }): never => {
      throw new Error(`${error.code}: ${error.message}`);
    }),
  };
}

function dependencies(overrides: Partial<ISubscriptionResource> = {}) {
  const authStorage = new MemoryStorage(tokens);
  const cancel = vi.fn(() => Promise.resolve());
  const authorize = vi.fn(() => Promise.resolve({ credential: 'credential', expires: '2026-08-12T18:00:00Z' }));
  const get = vi.fn(() => Promise.resolve(subscription));
  const list = vi.fn(() => Promise.resolve({ count: 1, data: [subscription], total: 1 }));
  const subscriptions: ISubscriptionResource = {
    authorize,
    cancel,
    get,
    list,
    ...overrides,
  };
  const inflow = new Inflow({ authStorage, environment: 'sandbox', cliClientId: 'test' });
  vi.spyOn(Object.getPrototypeOf(inflow.capabilities) as { has: () => Promise<boolean> }, 'has').mockResolvedValue(
    false,
  );
  return {
    authStorage,
    authorize,
    cancel,
    get,
    inflow,
    list,
    subscriptions,
  };
}

describe('subscription command runners', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers the subscription command group from the shared resource dependencies', () => {
    const deps = dependencies();
    expect(createSubscriptionsCli(deps.subscriptions, deps.authStorage, deps.inflow)).toBeDefined();
  });

  it('shows the next billing attempt in lifecycle details without fractional seconds', () => {
    expect(__testing.subscriptionDetailRows(subscription)).toContainEqual({
      field: 'Next billing attempt',
      value: '2026-09-01T00:00:00Z',
    });
    expect(__testing.subscriptionDetailRows(subscription)).toContainEqual({
      field: 'Past due',
      value: '2026-08-31T00:00:00Z',
    });
  });

  it('renders seller presentation fields as a hostname', () => {
    const rows = __testing.subscriptionDetailRows({ ...subscription, externalId: 'seller-plan' });
    expect(rows).toContainEqual({ field: 'Seller name', value: 'Example Seller' });
    expect(rows).toContainEqual({
      field: 'Seller website',
      value: 'shop.example.test',
    });
    expect(rows.slice(0, 5).map((row) => row.field)).toEqual([
      'Subscription ID',
      'Seller name',
      'Seller website',
      'Seller reference',
      'Status',
    ]);
  });

  it('preserves a non-URL seller website and invalid timestamps from the API', () => {
    const rows = __testing.subscriptionDetailRows({
      ...subscription,
      billingAnchor: 'not-a-timestamp',
      sellerWebsite: 'seller.example.test',
    });
    expect(rows).toContainEqual({ field: 'Seller website', value: 'seller.example.test' });
    expect(rows).toContainEqual({ field: 'Billing anchor', value: 'not-a-timestamp' });
  });

  it('omits optional subscription details when they are absent', () => {
    const sparse = { ...subscription };
    delete sparse.nextBillingDate;
    delete sparse.pastDue;
    delete sparse.sellerName;
    delete sparse.sellerWebsite;
    const rows = __testing.subscriptionDetailRows(sparse);
    expect(rows.map((row) => row.field)).not.toContain('Seller name');
    expect(rows.map((row) => row.field)).not.toContain('Seller website');
    expect(rows.map((row) => row.field)).not.toContain('Next billing attempt');
    expect(rows.map((row) => row.field)).not.toContain('Past due');
  });

  it('lists with explicit paging and date filters', async () => {
    const deps = dependencies();
    const options = {
      descending: false,
      endDate: '2026-08-31T00:00:00Z',
      limit: 20,
      offset: 5,
      startDate: '2026-08-01T00:00:00Z',
      status: 'active',
    };
    const result = await __testing.runList(context(options, {}), deps);
    expect(result).toEqual({ count: 1, data: [subscription], total: 1 } satisfies PagedSubscriptions);
    expect(deps.list).toHaveBeenCalledWith(options);
  });

  it('gets a participating subscription', async () => {
    const deps = dependencies();
    await expect(__testing.runGet(context({}, { subscriptionId: 'subscription-id' }), deps)).resolves.toEqual(
      subscription,
    );
    expect(deps.get).toHaveBeenCalledWith('subscription-id');
  });

  it('preserves the server error code in structured subscription errors', async () => {
    const apiError = new InflowApiError('Failed to get subscription (404): The specified subscription is not found.', {
      code: 'SUBSCRIPTION_NOT_FOUND',
      status: 404,
    });
    const deps = dependencies({ get: vi.fn(() => Promise.reject(apiError)) });
    const ctx = context({}, { subscriptionId: 'missing-subscription' });

    await expect(__testing.runGet(ctx, deps)).rejects.toThrow('SUBSCRIPTION_NOT_FOUND');
    expect(ctx.error).toHaveBeenCalledWith({
      code: 'SUBSCRIPTION_NOT_FOUND',
      details: { status: 404 },
      message: 'Failed to get subscription (404): The specified subscription is not found.',
    });
  });

  it('preserves server error codes when listing subscriptions', async () => {
    const apiError = new InflowApiError('Subscriptions are temporarily unavailable.', {
      code: 'SUBSCRIPTION_LIST_UNAVAILABLE',
      status: 503,
    });
    const deps = dependencies({ list: vi.fn(() => Promise.reject(apiError)) });
    const ctx = context({ descending: true, limit: 10, offset: 0 }, {});

    await expect(__testing.runList(ctx, deps)).rejects.toThrow('SUBSCRIPTION_LIST_UNAVAILABLE');
    expect(ctx.error).toHaveBeenCalledWith({
      code: 'SUBSCRIPTION_LIST_UNAVAILABLE',
      details: { status: 503 },
      message: 'Subscriptions are temporarily unavailable.',
    });
  });

  it('preserves server error codes when cancelling subscriptions', async () => {
    const apiError = new InflowApiError('The subscription cannot be cancelled.', {
      code: 'SUBSCRIPTION_NOT_CANCELLABLE',
      status: 409,
    });
    const deps = dependencies({ cancel: vi.fn(() => Promise.reject(apiError)) });
    const ctx = context({}, { subscriptionId: 'subscription-id' });

    await expect(__testing.runCancel(ctx, deps)).rejects.toThrow('SUBSCRIPTION_NOT_CANCELLABLE');
    expect(ctx.error).toHaveBeenCalledWith({
      code: 'SUBSCRIPTION_NOT_CANCELLABLE',
      details: { status: 409 },
      message: 'The subscription cannot be cancelled.',
    });
  });

  it('maps non-API failures to the command-specific fallback code', async () => {
    const deps = dependencies({ get: vi.fn(() => Promise.reject(new Error('connection closed'))) });
    const ctx = context({}, { subscriptionId: 'subscription-id' });

    await expect(__testing.runGet(ctx, deps)).rejects.toThrow('SUBSCRIPTION_GET_FAILED');
    expect(ctx.error).toHaveBeenCalledWith({
      code: 'SUBSCRIPTION_GET_FAILED',
      message: 'connection closed',
    });
  });

  it('fails closed when fresh subscription authorization is rejected', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/authorize')) {
        return Promise.resolve(
          Response.json({
            problem: { type: 't', title: 'Inactive', status: 402, detail: 'Subscription is not active.' },
          }),
        );
      }
      return Promise.resolve(subscriptionChallenge());
    });
    const deps = dependencies();
    const ctx = context(
      { header: [], interval: 0, maxAttempts: 0, method: 'GET', showBody: true, timeout: 900 },
      { resourceUrl: 'https://seller/resource', subscriptionId: 'subscription-id' },
    );
    await expect(__testing.runFetch(ctx, deps).next()).rejects.toThrow('PAYMENT_FAILED');
  });

  it('forwards a delegated payment error instead of returning an empty successful result', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/authorize')) {
        return Promise.resolve(
          Response.json({
            problem: { type: 't', title: 'Inactive', status: 402, detail: 'Subscription is not active.' },
          }),
        );
      }
      return Promise.resolve(subscriptionChallenge());
    });
    const ctx = {
      agent: true,
      formatExplicit: true,
      options: { header: [], interval: 0, maxAttempts: 0, method: 'GET', showBody: true, timeout: 900 },
      args: { resourceUrl: 'https://seller/resource', subscriptionId: 'subscription-id' },
      error: vi.fn((error: { code: string; message: string }): never => ({ sentinel: 'error', ...error }) as never),
    };

    const result = await __testing.runFetch(ctx, dependencies()).next();

    expect(result.done).toBe(true);
    expect(result.value).toEqual({
      code: 'PAYMENT_FAILED',
      message: 'Subscription is not active.',
      sentinel: 'error',
    });
  });

  it('fetches with a fresh subscription credential without local credential storage', async () => {
    const challenge = subscriptionChallengeValue();
    const freshCredential = encodeCredential({
      challenge,
      payload: { authorizationId: 'fresh-authorization', [CREDENTIAL_TRANSACTION_ID]: 'activation-transaction-id' },
      source: 'did:inflow:buyer',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/authorize')) {
        return Promise.resolve(Response.json({ credential: freshCredential, expires: '2026-08-12T18:00:00Z' }));
      }
      if (new Headers(init?.headers).get('Authorization') === `Payment ${freshCredential}`) {
        return Promise.resolve(new Response('subscribed resource', { status: 200 }));
      }
      return Promise.resolve(subscriptionChallenge());
    });
    const deps = dependencies();
    const ctx = context(
      { header: [], interval: 0, maxAttempts: 0, method: 'GET', showBody: true, timeout: 900 },
      { resourceUrl: 'https://seller/resource', subscriptionId: 'subscription-id' },
    );
    const frames: unknown[] = [];
    for await (const frame of __testing.runFetch(ctx, deps)) frames.push(frame);
    expect(frames.at(-1)).toMatchObject({
      body: 'subscribed resource',
      outcome: 'paid',
      subscription_id: 'subscription-id',
    });
    expect(frames.at(-1)).not.toHaveProperty('transaction_id');
    expect(frames.at(-1)).not.toHaveProperty('credential');
    expect(
      fetchSpy.mock.calls.some(
        ([, init]) => new Headers(init?.headers).get('Authorization') === `Payment ${freshCredential}`,
      ),
    ).toBe(true);
  });

  it('cancels immediately and returns the stable agent shape', async () => {
    const deps = dependencies();
    await expect(__testing.runCancel(context({}, { subscriptionId: 'subscription-id' }), deps)).resolves.toEqual({
      cancelled: true,
      subscription_id: 'subscription-id',
    });
    expect(deps.cancel).toHaveBeenCalledWith('subscription-id');
  });

  it('rejects unauthenticated management before calling the resource', async () => {
    const deps = dependencies();
    const authStorage = new MemoryStorage();
    const inflow = new Inflow({ authStorage, environment: 'sandbox', cliClientId: 'test' });
    const ctx = context({ descending: true, limit: 10, offset: 0 }, {});
    await expect(__testing.runList(ctx, { ...deps, authStorage, inflow })).rejects.toThrow('NOT_AUTHENTICATED');
    expect(deps.list).not.toHaveBeenCalled();
  });
});
