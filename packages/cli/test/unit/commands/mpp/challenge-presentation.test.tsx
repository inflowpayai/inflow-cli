import type { DecodedChallenge } from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { MppChallengePresentation } from '../../../../src/commands/mpp/challenge-presentation.js';

describe('MppChallengePresentation', () => {
  it('identifies CARD amounts as cents, including when the amount is missing', () => {
    const result = render(
      <MppChallengePresentation
        challenges={[
          { id: 'card', realm: 'seller.test', method: 'card', intent: 'charge', amount: '100', currency: 'usd' },
          { id: 'missing', realm: 'seller.test', method: 'card', intent: 'charge', currency: 'usd' },
          { id: 'unsupported', realm: 'seller.test', method: 'card', intent: 'charge', amount: '500', currency: 'jpy' },
        ]}
      />,
    );
    expect(result.lastFrame()).toContain('100 cents');
    expect(result.lastFrame()).not.toContain('500 cents');
    expect(result.lastFrame()).toContain('—');
    result.unmount();
  });
  it('labels the Instrument rail as a linked card', () => {
    const { lastFrame } = render(
      <MppChallengePresentation
        challenges={[{ id: 'card', realm: 'seller.test', method: 'inflow', intent: 'charge', rail: 'instrument' }]}
      />,
    );
    expect(lastFrame()).toContain('Linked card');
  });
  it('compares charge and subscription options before expanding each subscription', () => {
    const challenges: DecodedChallenge[] = [
      {
        id: 'charge-1',
        realm: 'seller.test',
        method: 'inflow',
        intent: 'charge',
        amount: '3',
        currency: 'USDC',
        rail: 'balance',
      },
      {
        id: 'subscription-1',
        realm: 'seller.test',
        method: 'inflow',
        intent: 'subscription',
        amount: '10',
        currency: 'USDC',
        rail: 'balance',
        periodCount: 1,
        periodUnit: 'month',
        subscriptionExpires: '2027-08-12T18:00:00.678776Z',
        expires: '2026-08-12T18:05:00.67888Z',
        externalId: 'monthly-plan',
        optionId: 'a84c92d13f6b',
        optionFingerprint: 'a84c92d13f6b'.padEnd(64, '0'),
      },
    ];

    const { lastFrame } = render(<MppChallengePresentation challenges={challenges} />);
    const frame = lastFrame() ?? '';

    for (const heading of ['Method', 'Intent', 'Amount', 'Currency', 'Rail']) expect(frame).toContain(heading);
    expect(frame).not.toContain('Subscription expires');
    expect(frame).toContain('charge');
    expect(frame).toContain('subscription');
    expect(frame).toContain('Subscription option 1');
    expect(frame).toContain('Option ID');
    expect(frame).toContain('a84c92d13f6b');
    expect(frame).toContain('Billing frequency');
    expect(frame).toContain('Every month');
    expect(frame).toContain('Subscription ends');
    expect(frame).toContain('Accept by');
    expect(frame).toContain('Seller reference');
    expect(frame).toContain('monthly-plan');
    expect(frame).toContain('2027-08-12T18:00:00Z');
    expect(frame).toContain('2026-08-12T18:05:00Z');
    expect(frame).not.toContain('.678');
    expect(frame.indexOf('Seller reference')).toBeLessThan(frame.indexOf('Subscription ends'));
    expect(frame.indexOf('Subscription ends')).toBeLessThan(frame.indexOf('Accept by'));
  });
});
