import type { PagedSubscriptions, Subscription } from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { __testing } from '../../../../src/commands/subscriptions/index.js';

const { SubscriptionCancelView, SubscriptionGetView, SubscriptionListView } = __testing;

const subscription: Subscription = {
  amount: '10',
  billingAnchor: '2026-08-01T00:00:00Z',
  buyerId: 'buyer-id',
  cancelled: '2026-09-01T00:00:00Z',
  created: '2026-08-01T00:00:00Z',
  currency: 'USD',
  externalId: 'seller-plan',
  failed: '2026-09-02T00:00:00Z',
  lastChargedPeriod: 1,
  period0Amount: '5',
  pastDue: '2026-08-31T00:00:00Z',
  periodCount: 1,
  periodUnit: 'month',
  sellerId: 'seller-id',
  sellerName: 'Example Seller',
  sellerWebsite: 'https://shop.example.test/path',
  status: 'CANCELLED',
  subscriptionExpires: '2027-08-01T00:00:00Z',
  subscriptionId: 'subscription-id',
  transactionType: 'MPP',
  updated: '2026-09-02T00:00:00Z',
};

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe('subscription views', () => {
  it('renders the subscription table and empty state', async () => {
    const page: PagedSubscriptions = { count: 1, data: [subscription], total: 1 };
    const populated = render(<SubscriptionListView load={() => Promise.resolve(page)} onComplete={vi.fn()} />);
    await settle();
    const frame = populated.lastFrame() ?? '';
    expect(frame).toContain('Subscription ID');
    expect(frame.indexOf('Subscription ID')).toBeLessThan(frame.indexOf('Seller'));
    expect(frame).toContain('subscription-id');
    expect(frame).toContain('Example Seller');
    expect(frame).toContain('shop.example.test');
    expect(frame).not.toContain('https://shop.example.test/path');
    expect(frame).toContain('Billing frequency');
    expect(frame).toContain('seller-plan');
    expect(frame).toContain('Subscription ends');
    populated.unmount();
    const empty = render(
      <SubscriptionListView load={() => Promise.resolve({ count: 0, data: [], total: 0 })} onComplete={vi.fn()} />,
    );
    await settle();
    expect(empty.lastFrame()).toContain('No subscriptions.');
    empty.unmount();
  });

  it('renders complete subscription details', async () => {
    const view = render(<SubscriptionGetView load={() => Promise.resolve(subscription)} onComplete={vi.fn()} />);
    await settle();
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Field');
    expect(frame).toContain('Value');
    expect(frame).toContain('Seller reference');
    expect(frame).toContain('seller-plan');
    expect(frame).toContain('Seller name');
    expect(frame).toContain('Buyer ID');
    expect(frame).toContain('buyer-id');
    expect(frame).toContain('Seller ID');
    expect(frame).toContain('seller-id');
    expect(frame).toContain('Seller website');
    expect(frame).toContain('shop.example.test');
    expect(frame).toContain('Cancelled');
    expect(frame).toContain('2026-09-01T00:00:00Z');
    expect(frame).toContain('Failed');
    expect(frame).toContain('2026-09-02T00:00:00Z');
    expect(frame).toContain('Past due');
    expect(frame).toContain('2026-08-31T00:00:00Z');
    view.unmount();
  });

  it('renders successful cancellation', async () => {
    const view = render(
      <SubscriptionCancelView cancel={() => Promise.resolve()} subscriptionId="subscription-id" onComplete={vi.fn()} />,
    );
    await settle();
    expect(view.lastFrame()).toContain('Subscription subscription-id cancelled.');
    view.unmount();
  });

  it('renders resource failures instead of a success state', async () => {
    const list = render(
      <SubscriptionListView load={() => Promise.reject(new Error('list failure'))} onComplete={vi.fn()} />,
    );
    const get = render(
      <SubscriptionGetView load={() => Promise.reject(new Error('get failure'))} onComplete={vi.fn()} />,
    );
    const cancel = render(
      <SubscriptionCancelView
        cancel={() => Promise.reject(new Error('cancel failure'))}
        subscriptionId="subscription-id"
        onComplete={vi.fn()}
      />,
    );
    await settle();
    expect(list.lastFrame()).toContain('Failed to list subscriptions: list failure');
    expect(get.lastFrame()).toContain('Failed to get subscription: get failure');
    expect(cancel.lastFrame()).toContain('Failed to cancel subscription: cancel failure');
    list.unmount();
    get.unmount();
    cancel.unmount();
  });
});
