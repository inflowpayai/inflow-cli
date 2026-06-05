import { encode, type MppChallenge, renderChallengeHeader } from '@inflowpayai/mpp';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CombinedInspectEvent,
  reduceCombinedInspect,
  runCombinedInspectPipeline,
} from '../../../src/flows/combined-inspect.js';

const URL = 'https://seller.test/api';

afterEach(() => {
  vi.restoreAllMocks();
});

function mppChallenge(method = 'inflow'): MppChallenge {
  return {
    id: `chal-${method}`,
    realm: 'mpp.test',
    method,
    intent: 'charge',
    request: encode({ amount: '0.10', currency: 'USDC', methodDetails: { rail: 'balance' } }),
    expires: '2999-01-01T00:00:00Z',
  };
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
        asset: '0xUSDCcontract',
        extra: { name: 'USDC', version: '2' },
      },
    ],
  });
}

function mock402(headers: Record<string, string>): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('payment required', { status: 402, headers }));
}

async function collect(): Promise<CombinedInspectEvent[]> {
  const events: CombinedInspectEvent[] = [];
  await runCombinedInspectPipeline({ url: URL, probeOptions: { method: 'GET', headers: {} } }, (e) => events.push(e));
  return events;
}

describe('runCombinedInspectPipeline', () => {
  it('decodes BOTH protocols from one 402 (single probe)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('payment required', {
        status: 402,
        headers: { 'WWW-Authenticate': renderChallengeHeader(mppChallenge()), 'PAYMENT-REQUIRED': x402Header() },
      }),
    );
    const [event] = await collect();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // one HTTP request for both protocols
    expect(event?.type).toBe('inspected');
    if (event?.type !== 'inspected') return;
    expect(event.result.mpp.kind).toBe('challenges');
    expect(event.result.x402.kind).toBe('accepts');
    if (event.result.mpp.kind === 'challenges') {
      expect(event.result.mpp.challenges[0]?.amount).toBe('0.10');
      expect(event.result.mpp.challenges[0]?.currency).toBe('USDC');
    }
    if (event.result.x402.kind === 'accepts') {
      expect(event.result.x402.accepts).toHaveLength(1);
      expect(event.result.x402.x402Version).toBe(2);
    }
  });

  it('MPP-only: x402 section is absent', async () => {
    mock402({ 'WWW-Authenticate': renderChallengeHeader(mppChallenge()) });
    const [event] = await collect();
    expect(event?.type).toBe('inspected');
    if (event?.type !== 'inspected') return;
    expect(event.result.mpp.kind).toBe('challenges');
    expect(event.result.x402.kind).toBe('absent');
  });

  it('x402-only: MPP section is absent', async () => {
    mock402({ 'PAYMENT-REQUIRED': x402Header() });
    const [event] = await collect();
    expect(event?.type).toBe('inspected');
    if (event?.type !== 'inspected') return;
    expect(event.result.x402.kind).toBe('accepts');
    expect(event.result.mpp.kind).toBe('absent');
  });

  it('402 with neither header: both sections absent (not an error)', async () => {
    mock402({});
    const [event] = await collect();
    expect(event?.type).toBe('inspected');
    if (event?.type !== 'inspected') return;
    expect(event.result.mpp.kind).toBe('absent');
    expect(event.result.x402.kind).toBe('absent');
  });

  it('MPP header present but only non-inflow challenges: none-inflow, carrying the offered method(s)', async () => {
    mock402({ 'WWW-Authenticate': renderChallengeHeader(mppChallenge('tempo')) });
    const [event] = await collect();
    expect(event?.type).toBe('inspected');
    if (event?.type !== 'inspected') return;
    expect(event.result.mpp.kind).toBe('none-inflow');
    if (event.result.mpp.kind === 'none-inflow') expect(event.result.mpp.methods).toEqual(['tempo']);
  });

  it('one side malformed surfaces as a section error, not a whole-command failure', async () => {
    mock402({
      'WWW-Authenticate': renderChallengeHeader(mppChallenge()),
      'PAYMENT-REQUIRED': 'not-base64-at-all!!!',
    });
    const [event] = await collect();
    expect(event?.type).toBe('inspected');
    if (event?.type !== 'inspected') return;
    expect(event.result.mpp.kind).toBe('challenges');
    expect(event.result.x402.kind).toBe('error');
    if (event.result.x402.kind === 'error') expect(event.result.x402.code).toBe('DECODE_FAILED');
  });

  it('2xx probe emits no-payment', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('hi', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const [event] = await collect();
    expect(event?.type).toBe('no-payment');
  });

  it('non-2xx / non-402 emits UNEXPECTED_PROBE_STATUS', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const [event] = await collect();
    expect(event?.type).toBe('errored');
    if (event?.type === 'errored') expect(event.code).toBe('UNEXPECTED_PROBE_STATUS');
  });

  it('fetch rejection emits INSPECT_FAILED', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const [event] = await collect();
    expect(event?.type).toBe('errored');
    if (event?.type === 'errored') expect(event.code).toBe('INSPECT_FAILED');
  });
});

describe('reduceCombinedInspect', () => {
  it('errored -> error phase', () => {
    expect(reduceCombinedInspect({ kind: 'probing' }, { type: 'errored', code: 'X', message: 'oops' })).toEqual({
      kind: 'error',
      code: 'X',
      message: 'oops',
    });
  });

  it('returns prior state for an unrecognised event', () => {
    const prior = { kind: 'probing' } as const;
    expect(reduceCombinedInspect(prior, { type: 'bogus' } as never)).toBe(prior);
  });
});
