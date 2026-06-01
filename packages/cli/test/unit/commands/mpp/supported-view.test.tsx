import type { MppSupportedResponse } from '@inflowpayai/mpp';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SupportedView } from '../../../../src/commands/mpp/supported.js';

function supported(): MppSupportedResponse {
  return {
    kinds: [
      {
        method: 'inflow',
        intents: [
          {
            intent: 'charge',
            rails: [
              { rail: 'balance', currencies: ['USDC', 'USDT'] },
              { rail: 'instrument', currencies: ['USD'] },
            ],
          },
        ],
      },
    ],
  };
}

describe('SupportedView', () => {
  it('renders a method/intent/rail/currencies table', async () => {
    const { lastFrame, unmount } = render(<SupportedView load={async () => supported()} onComplete={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Method');
    expect(frame).toContain('inflow');
    expect(frame).toContain('charge');
    expect(frame).toContain('balance');
    expect(frame).toContain('USDC, USDT');
    expect(frame).toContain('instrument');
    unmount();
  });

  it('renders a dash for a rail that exposes no currencies', async () => {
    const response: MppSupportedResponse = {
      kinds: [{ method: 'inflow', intents: [{ intent: 'charge', rails: [{ rail: 'balance', currencies: [] }] }] }],
    };
    const { lastFrame, unmount } = render(<SupportedView load={async () => response} onComplete={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('balance');
    expect(frame).toContain('—');
    unmount();
  });

  it('renders an empty-state message when there are no kinds', async () => {
    const { lastFrame, unmount } = render(<SupportedView load={async () => ({ kinds: [] })} onComplete={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toContain('No supported MPP methods');
    unmount();
  });

  it('shows the error message when load rejects', async () => {
    const { lastFrame, unmount } = render(
      <SupportedView
        load={async () => {
          throw new Error('network down');
        }}
        onComplete={vi.fn()}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toContain('network down');
    unmount();
  });
});
