import {
  type AuthTokens,
  Inflow,
  type ISubscriptionResource,
  MemoryStorage,
  type PagedSubscriptions,
  type Subscription,
} from '@inflowpayai/inflow-core';
import { describe, expect, it, vi } from 'vitest';

import { __testing } from '../../../../src/commands/subscriptions/index.js';

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
  period0Amount: '5',
  periodCount: 1,
  periodUnit: 'month',
  status: 'ACTIVE',
  subscriptionExpires: '2027-08-01T00:00:00Z',
  subscriptionId: 'subscription-id',
  transactionType: 'MPP',
  updated: '2026-08-01T00:00:00Z',
};

function dependencies() {
  const authStorage = new MemoryStorage(tokens);
  const subscriptions: ISubscriptionResource = {
    authorize: vi.fn(() => Promise.resolve({ credential: 'credential', expires: '2026-08-12T18:00:00Z' })),
    cancel: vi.fn(() => Promise.resolve()),
    get: vi.fn(() => Promise.resolve(subscription)),
    list: vi.fn(() => Promise.resolve({ count: 1, data: [subscription], total: 1 })),
  };
  return {
    authStorage,
    inflow: new Inflow({ authStorage, environment: 'sandbox', cliClientId: 'test' }),
    subscriptions,
  };
}

function context<Args, Options>(args: Args, options: Options) {
  return {
    agent: false as const,
    formatExplicit: false as const,
    args,
    options,
    error: vi.fn((error: { code: string; message: string }): never => {
      throw new Error(error.code);
    }),
  };
}

describe('subscription command runners in interactive mode', () => {
  it('returns the list captured by the renderer', async () => {
    const page: PagedSubscriptions = { count: 1, data: [subscription], total: 1 };
    await expect(
      __testing.runList(context({}, { descending: true, limit: 10, offset: 0 }), dependencies()),
    ).resolves.toEqual(page);
  });

  it('fails when listing ends without a result', async () => {
    const deps = dependencies();
    vi.spyOn(deps.subscriptions, 'list').mockRejectedValue(new Error('Service unavailable'));
    await expect(__testing.runList(context({}, { descending: true, limit: 10, offset: 0 }), deps)).rejects.toThrow(
      'SUBSCRIPTION_LIST_FAILED',
    );
  });

  it('returns the subscription captured by the renderer', async () => {
    await expect(__testing.runGet(context({ subscriptionId: 'subscription-id' }, {}), dependencies())).resolves.toEqual(
      subscription,
    );
  });

  it('fails when get ends without a result', async () => {
    const deps = dependencies();
    vi.spyOn(deps.subscriptions, 'get').mockRejectedValue(new Error('Service unavailable'));
    await expect(__testing.runGet(context({ subscriptionId: 'subscription-id' }, {}), deps)).rejects.toThrow(
      'SUBSCRIPTION_GET_FAILED',
    );
  });

  it('reports a successful cancellation', async () => {
    const deps = dependencies();
    const cancel = vi.spyOn(deps.subscriptions, 'cancel');
    await expect(__testing.runCancel(context({ subscriptionId: 'subscription-id' }, {}), deps)).resolves.toEqual({
      cancelled: true,
      subscription_id: 'subscription-id',
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('subscription-id');
  });

  it('reports a failed cancellation', async () => {
    const deps = dependencies();
    const cancel = vi.spyOn(deps.subscriptions, 'cancel').mockRejectedValue(new Error('Service unavailable'));
    await expect(__testing.runCancel(context({ subscriptionId: 'subscription-id' }, {}), deps)).rejects.toThrow(
      'SUBSCRIPTION_CANCEL_FAILED',
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});
