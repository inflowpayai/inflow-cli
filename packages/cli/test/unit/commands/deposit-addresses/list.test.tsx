import type { ConfiguredDepositAddress, DepositAddresses } from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  DepositAddressesList,
  type DepositAddressesListProps,
} from '../../../../src/commands/deposit-addresses/list.js';

function resourceStub(impl: () => Promise<DepositAddresses>): DepositAddressesListProps['depositAddressResource'] {
  return { list: vi.fn(impl) };
}

function mount(props: DepositAddressesListProps) {
  return render(createElement(DepositAddressesList, props));
}

const NOOP = (_result: ConfiguredDepositAddress[] | null): void => undefined;

const SOLANA: ConfiguredDepositAddress = {
  address: '4q6BvgEM9p3uK8jPyzfNcQa7DRRkU8eKbtdgFsHs8uYJW',
  blockchain: 'SOLANA',
  currencies: ['USDC', 'USDT'],
};

const BASE: ConfiguredDepositAddress = {
  address: '0x9f3a4cdcEbA63E4b21cBBe4D52f0E1c98F46c12d',
  blockchain: 'BASE',
  currencies: ['USDC'],
};

const TEMPO: ConfiguredDepositAddress = {
  address: '0x0000000000000000000000000000000000004217',
  blockchain: 'TEMPO',
  currencies: ['USDC'],
};

describe('DepositAddressesList — render lifecycle', () => {
  it('shows the loading spinner before the action resolves', () => {
    const pending = resourceStub(() => new Promise<DepositAddresses>(() => undefined));
    const { lastFrame, unmount } = mount({
      depositAddressResource: pending,
      onComplete: NOOP,
    });
    expect(lastFrame()).toContain('Loading deposit addresses');
    unmount();
  });

  it('renders the empty-state message even when the server returns unconfigured suggestions', async () => {
    const resource = resourceStub(() =>
      Promise.resolve({
        configured: [],
        unconfigured: [
          { blockchain: 'SOLANA', currencies: ['USDC'] },
          { blockchain: 'BASE', currencies: ['USDC'] },
        ],
      }),
    );
    const { lastFrame, unmount } = mount({
      depositAddressResource: resource,
      onComplete: NOOP,
    });
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('No configured deposit addresses.');
      },
      { timeout: 3_000 },
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Blockchain');
    expect(frame).not.toContain('Address');
    expect(frame).not.toContain('Currencies');
    expect(frame).not.toMatch(/^SOLANA\b/m);
    expect(frame).not.toMatch(/^BASE\b/m);
    unmount();
  });

  it('renders header + separator + one row per configured address via the canonical table', async () => {
    const resource = resourceStub(() => Promise.resolve({ configured: [SOLANA, BASE, TEMPO], unconfigured: [] }));
    const { lastFrame, unmount } = mount({
      depositAddressResource: resource,
      onComplete: NOOP,
    });
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('Blockchain');
      },
      { timeout: 3_000 },
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Address');
    expect(frame).toContain('Currencies');
    expect(frame).toContain('SOLANA');
    expect(frame).toContain('BASE');
    expect(frame).toContain('TEMPO');
    expect(frame).toContain(SOLANA.address);
    expect(frame).toContain(BASE.address);
    expect(frame).toContain(TEMPO.address);
    expect(frame).toContain('USDC, USDT');
    expect(frame).toMatch(/-{6,}\s+-{6,}\s+-{6,}/);
    unmount();
  });

  it('aligns the Currencies column at the same character offset across rows (regression for col-3 misalignment)', async () => {
    const resource = resourceStub(() => Promise.resolve({ configured: [SOLANA, BASE], unconfigured: [] }));
    const { lastFrame, unmount } = mount({
      depositAddressResource: resource,
      onComplete: NOOP,
    });
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('Currencies');
      },
      { timeout: 3_000 },
    );
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n').filter((line) => line.length > 0);
    const headerLine = lines.find((line) => line.includes('Currencies'));
    expect(headerLine).toBeDefined();
    const currenciesIdx = (headerLine ?? '').indexOf('Currencies');
    expect(currenciesIdx).toBeGreaterThan(0);
    const solanaRow = lines.find((line) => line.includes(SOLANA.address));
    const baseRow = lines.find((line) => line.includes(BASE.address));
    expect(solanaRow).toBeDefined();
    expect(baseRow).toBeDefined();
    expect((solanaRow ?? '').indexOf('USDC, USDT')).toBe(currenciesIdx);
    expect((baseRow ?? '').indexOf('USDC')).toBe(currenciesIdx);
    unmount();
  });

  it('does not surface anything sourced from the unconfigured half even when both halves are populated', async () => {
    const resource = resourceStub(() =>
      Promise.resolve({
        configured: [SOLANA],
        unconfigured: [{ blockchain: 'STELLAR', currencies: ['USDC'] }],
      }),
    );
    const { lastFrame, unmount } = mount({
      depositAddressResource: resource,
      onComplete: NOOP,
    });
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('SOLANA');
      },
      { timeout: 3_000 },
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('STELLAR');
    unmount();
  });

  it('renders the failure marker and the error message on rejection', async () => {
    const resource = resourceStub(() => Promise.reject(new Error('upstream 503')));
    const { lastFrame, unmount } = mount({
      depositAddressResource: resource,
      onComplete: NOOP,
    });
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('Failed to retrieve deposit addresses');
      },
      { timeout: 3_000 },
    );
    expect(lastFrame() ?? '').toContain('upstream 503');
    unmount();
  });
});

describe('DepositAddressesList — linger and onComplete', () => {
  it('hands a ConfiguredDepositAddress[] (not the wrapper) to onComplete on success', async () => {
    const resource = resourceStub(() =>
      Promise.resolve({
        configured: [SOLANA],
        unconfigured: [{ blockchain: 'BASE', currencies: ['USDC'] }],
      }),
    );
    const onComplete = vi.fn<(r: ConfiguredDepositAddress[] | null) => void>();
    const { unmount } = mount({
      depositAddressResource: resource,
      onComplete,
    });
    await vi.waitFor(
      () => {
        expect(onComplete).toHaveBeenCalled();
      },
      { timeout: 3_000 },
    );
    const arg = onComplete.mock.calls[0]?.[0];
    expect(arg).toEqual([SOLANA]);
    expect(arg).not.toHaveProperty('configured');
    expect(arg).not.toHaveProperty('unconfigured');
    unmount();
  });

  it('hands the empty array (not null) to onComplete when zero configured addresses', async () => {
    const resource = resourceStub(() => Promise.resolve({ configured: [], unconfigured: [] }));
    const onComplete = vi.fn<(r: ConfiguredDepositAddress[] | null) => void>();
    const { unmount } = mount({
      depositAddressResource: resource,
      onComplete,
    });
    await vi.waitFor(
      () => {
        expect(onComplete).toHaveBeenCalledWith([]);
      },
      { timeout: 3_000 },
    );
    unmount();
  });

  it('hands null to onComplete after the linger on error', async () => {
    const resource = resourceStub(() => Promise.reject(new Error('boom')));
    const onComplete = vi.fn<(r: ConfiguredDepositAddress[] | null) => void>();
    const { unmount } = mount({
      depositAddressResource: resource,
      onComplete,
    });
    await vi.waitFor(
      () => {
        expect(onComplete).toHaveBeenCalledWith(null);
      },
      { timeout: 3_000 },
    );
    unmount();
  });
});
