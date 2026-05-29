import type { Balance } from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BalancesList, type BalancesListProps } from '../../../../src/commands/balances/list.js';

function balancesStub(impl: () => Promise<Balance[]>): BalancesListProps['balanceResource'] {
  return { list: vi.fn(impl) };
}

function mount(props: BalancesListProps) {
  return render(createElement(BalancesList, props));
}

const NOOP = (_result: Balance[] | null): void => undefined;

describe('BalancesList — render lifecycle', () => {
  it('shows the loading spinner before the action resolves', () => {
    const pending = balancesStub(() => new Promise<Balance[]>(() => undefined));
    const { lastFrame, unmount } = mount({
      balanceResource: pending,
      onComplete: NOOP,
    });
    expect(lastFrame()).toContain('Loading balances');
    unmount();
  });

  it('renders the empty-state message and no table headers when the list is empty', async () => {
    const resource = balancesStub(() => Promise.resolve([]));
    const { lastFrame, unmount } = mount({
      balanceResource: resource,
      onComplete: NOOP,
    });
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('No balances.');
      },
      { timeout: 3_000 },
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Currency');
    expect(frame).not.toContain('Available');
    unmount();
  });

  it('renders header + separator + one row per balance via the canonical table', async () => {
    const data: Balance[] = [
      { available: '100.5', currency: 'USDC' },
      { available: '42.00', currency: 'USD' },
    ];
    const resource = balancesStub(() => Promise.resolve(data));
    const { lastFrame, unmount } = mount({
      balanceResource: resource,
      onComplete: NOOP,
    });
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('Currency');
      },
      { timeout: 3_000 },
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Available');
    expect(frame).toContain('USDC');
    expect(frame).toContain('USD');
    expect(frame).toContain('100.5');
    expect(frame).toContain('42.00');
    expect(frame).toMatch(/-{8,}\s+-{5,}/);
    expect(frame).toContain('USDC    ');
    unmount();
  });

  it('preserves the available string verbatim (no scientific notation, no truncation)', async () => {
    const resource = balancesStub(() => Promise.resolve([{ available: '0.000001', currency: 'USDC' }]));
    const { lastFrame, unmount } = mount({
      balanceResource: resource,
      onComplete: NOOP,
    });
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('0.000001');
      },
      { timeout: 3_000 },
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('0.000001');
    expect(frame).not.toContain('1e-6');
    expect(frame).not.toContain('1e-06');
    unmount();
  });

  it('renders the failure marker and the error message on rejection', async () => {
    const resource = balancesStub(() => Promise.reject(new Error('upstream 503')));
    const { lastFrame, unmount } = mount({
      balanceResource: resource,
      onComplete: NOOP,
    });
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('Failed to retrieve balances');
      },
      { timeout: 3_000 },
    );
    expect(lastFrame() ?? '').toContain('upstream 503');
    unmount();
  });
});

describe('BalancesList — linger and onComplete', () => {
  it('hands the balances array to onComplete after the linger on success', async () => {
    const data: Balance[] = [{ available: '5', currency: 'USDC' }];
    const resource = balancesStub(() => Promise.resolve(data));
    const onComplete = vi.fn<(r: Balance[] | null) => void>();
    const { unmount } = mount({ balanceResource: resource, onComplete });
    await vi.waitFor(
      () => {
        expect(onComplete).toHaveBeenCalledWith(data);
      },
      { timeout: 3_000 },
    );
    unmount();
  });

  it('hands the empty array (not null) to onComplete when the server returns no balances', async () => {
    const resource = balancesStub(() => Promise.resolve([]));
    const onComplete = vi.fn<(r: Balance[] | null) => void>();
    const { unmount } = mount({ balanceResource: resource, onComplete });
    await vi.waitFor(
      () => {
        expect(onComplete).toHaveBeenCalledWith([]);
      },
      { timeout: 3_000 },
    );
    unmount();
  });

  it('hands null to onComplete after the linger on error', async () => {
    const resource = balancesStub(() => Promise.reject(new Error('boom')));
    const onComplete = vi.fn<(r: Balance[] | null) => void>();
    const { unmount } = mount({ balanceResource: resource, onComplete });
    await vi.waitFor(
      () => {
        expect(onComplete).toHaveBeenCalledWith(null);
      },
      { timeout: 3_000 },
    );
    unmount();
  });
});
