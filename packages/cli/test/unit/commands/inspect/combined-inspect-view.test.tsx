import { encode, type MppChallenge, renderChallengeHeader } from '@inflowpayai/mpp';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CombinedInspectView } from '../../../../src/commands/inspect/combined-inspect-view.js';

const URL = 'https://seller.test/api';

afterEach(() => {
  vi.restoreAllMocks();
});

function mppHeader(method = 'inflow'): string {
  const request =
    method === 'tempo'
      ? {
          amount: '10000',
          currency: '0x20c0000000000000000000000000000000000000',
          methodDetails: { chainId: 42431, feePayer: false, supportedModes: ['pull'] },
          recipient: '0x61d64bdb13debd1844defecd45cf737403de9813',
        }
      : { amount: '0.10', currency: 'USDC', methodDetails: { rail: 'balance' } };
  const challenge: MppChallenge = {
    id: `chal-${method}`,
    realm: 'mpp.test',
    method,
    intent: 'charge',
    request: encode(request),
    expires: '2999-01-01T00:00:00Z',
  };
  return renderChallengeHeader(challenge);
}

function x402Header(): string {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url: URL, mimeType: 'application/json' },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:84532',
        amount: '10000',
        payTo: '0xabc',
        maxTimeoutSeconds: 300,
        asset: '0xUSDCcontractaddress0000000000000000000000',
        extra: { name: 'USDC' },
      },
    ],
  });
}

function renderView() {
  return render(
    <CombinedInspectView
      url={URL}
      method="GET"
      deps={{ probeOptions: { method: 'GET', headers: {} }, url: URL }}
      onComplete={vi.fn()}
    />,
  );
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('CombinedInspectView', () => {
  it('renders both sections with detected: mpp, x402 and triage columns', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'WWW-Authenticate': mppHeader(), 'PAYMENT-REQUIRED': x402Header() },
      }),
    );
    const { lastFrame, unmount } = renderView();
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('detected: mpp, x402');
    expect(frame).toContain('── MPP ──');
    expect(frame).toContain('── x402 ──');
    // MPP triage columns
    for (const h of ['Method', 'Intent', 'Amount', 'Currency', 'Rail']) expect(frame).toContain(h);
    expect(frame).toContain('USDC');
    // x402 triage columns + the FULL asset string rendered verbatim (no truncation)
    for (const h of ['Scheme', 'Network', 'Asset']) expect(frame).toContain(h);
    expect(frame).toContain('eip155:84532');
    expect(frame).toContain('0xUSDCcontractaddress0000000000000000000000');
    expect(frame).toContain('--format json');
    unmount();
  });

  it('shows "none advertised" for the missing protocol (x402-only)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', { status: 402, headers: { 'PAYMENT-REQUIRED': x402Header() } }),
    );
    const { lastFrame, unmount } = renderView();
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('detected: x402');
    expect(frame).toContain('── MPP ──');
    expect(frame).toContain('none advertised');
    unmount();
  });

  it('shows Tempo as an MPP challenge', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', { status: 402, headers: { 'WWW-Authenticate': mppHeader('tempo') } }),
    );
    const { lastFrame, unmount } = renderView();
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('detected: mpp');
    expect(frame).toContain('tempo');
    // Raw wire amount — the CLI does not translate base units to a decimal.
    expect(frame).toContain('10000');
    unmount();
  });

  it('names the advertised unsupported method(s) in the none-inflow line', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', { status: 402, headers: { 'WWW-Authenticate': mppHeader('other') } }),
    );
    const { lastFrame, unmount } = renderView();
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('detected: none');
    expect(frame).toContain('not payable by InFlow: other');
    unmount();
  });

  it('reports detected: none on a 402 with neither header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 402 }));
    const { lastFrame, unmount } = renderView();
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('detected: none');
    unmount();
  });

  it('renders the no-payment branch on a 2xx probe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const { lastFrame, unmount } = renderView();
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Seller accepted without payment');
    unmount();
  });

  it('renders the probe error branch with code + message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('server error', { status: 503 }));
    const { lastFrame, unmount } = renderView();
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('UNEXPECTED_PROBE_STATUS');
    expect(frame).toContain('503');
    unmount();
  });
});
