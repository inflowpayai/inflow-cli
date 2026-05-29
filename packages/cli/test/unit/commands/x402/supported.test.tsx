import type { X402BuyerSupportedResponse } from '@inflowpayai/x402';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SupportedView } from '../../../../src/commands/x402/supported.js';

function makeResponse(kinds: X402BuyerSupportedResponse['kinds']): X402BuyerSupportedResponse {
  return { kinds };
}

describe('SupportedView', () => {
  it('renders a table of (scheme, network) pairs with proper-cased headers', async () => {
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <SupportedView
        load={async () =>
          makeResponse([
            { scheme: 'balance', network: 'inflow:1', x402Version: 2 },
            { scheme: 'exact', network: 'eip155:8453', x402Version: 2 },
          ])
        }
        onComplete={onComplete}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Scheme');
    expect(frame).toContain('Network');
    expect(frame).toContain('balance');
    expect(frame).toContain('inflow:1');
    expect(frame).toContain('exact');
    expect(frame).toContain('eip155:8453');
    expect(frame).toMatch(/-{6,}\s+-{7,}/);
    expect(frame).not.toContain('Supported schemes');
    unmount();
  });

  it('renders an empty-state message when kinds is []', async () => {
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <SupportedView load={async () => makeResponse([])} onComplete={onComplete} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lastFrame() ?? '').toContain('No supported');
    unmount();
  });

  it('shows the error message when load rejects', async () => {
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <SupportedView
        load={async () => {
          throw new Error('server unavailable');
        }}
        onComplete={onComplete}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lastFrame() ?? '').toContain('server unavailable');
    unmount();
  });
});
