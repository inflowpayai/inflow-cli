import { HEADERS } from '@inflowpayai/x402';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type InspectEvent,
  type InspectResultAccepts,
  type InspectResultNoPayment,
  reduceX402Inspect,
  runInspectPipeline,
} from '../../../src/flows/x402-inspect.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const SELLER = 'https://seller.test/api';

function paymentRequired(): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: SELLER, method: 'GET' },
    accepts: [
      {
        scheme: 'balance',
        network: 'inflow:1',
        asset: '',
        amount: '10',
        payTo: 'acct_1',
        maxTimeoutSeconds: 60,
        extra: { assetName: 'USDC' },
      },
      {
        scheme: 'exact',
        network: 'eip155:84532',
        asset: '0xabc',
        amount: '10',
        payTo: '0xdef',
        maxTimeoutSeconds: 60,
        extra: { assetName: 'USDT' },
      },
    ],
    extensions: { foo: 'bar' },
  } as unknown as PaymentRequired;
}

function mock402(headerValue = encodePaymentRequiredHeader(paymentRequired())): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('payment required', { status: 402, headers: { [HEADERS.PAYMENT_REQUIRED]: headerValue } }),
  );
}

async function collect(deps: Parameters<typeof runInspectPipeline>[0]): Promise<InspectEvent[]> {
  const events: InspectEvent[] = [];
  await runInspectPipeline(deps, (e) => events.push(e));
  return events;
}

describe('runInspectPipeline — accepts decoding', () => {
  it('emits the decoded accepts list with resource, version and extensions', async () => {
    mock402();
    const events = await collect({ url: SELLER, probeOptions: { method: 'GET', headers: {} } });
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.type).toBe('accepts');
    if (ev?.type === 'accepts') {
      expect(ev.result.outcome).toBe('accepts');
      expect(ev.result.url).toBe(SELLER);
      expect(ev.result.method).toBe('GET');
      expect(ev.result.resource).toBe(SELLER);
      expect(ev.result.x402Version).toBe(2);
      expect(ev.result.extensions).toEqual({ foo: 'bar' });
      expect(ev.result.accepts).toHaveLength(2);
      expect(ev.result.accepts[0]?.scheme).toBe('balance');
      expect(ev.result.accepts[1]?.network).toBe('eip155:84532');
    }
  });

  it('narrows the rendered accepts when scheme/network/asset/asset-name filters all match one entry', async () => {
    mock402();
    const events = await collect({
      url: SELLER,
      probeOptions: { method: 'GET', headers: {} },
      schemeFilter: 'exact',
      networkFilter: 'eip155:84532',
      assetFilter: '0xabc',
      assetNameFilter: 'USDT',
    });
    const ev = events[0];
    expect(ev?.type).toBe('accepts');
    if (ev?.type === 'accepts') {
      expect(ev.result.accepts).toHaveLength(1);
      expect(ev.result.accepts[0]?.scheme).toBe('exact');
    }
  });

  it('errors NO_FILTERED_MATCH with the available pairs when filters match nothing', async () => {
    mock402();
    const events = await collect({
      url: SELLER,
      probeOptions: { method: 'GET', headers: {} },
      schemeFilter: 'bogus',
    });
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.type).toBe('errored');
    if (ev?.type === 'errored') {
      expect(ev.code).toBe('NO_FILTERED_MATCH');
      expect(ev.message).toContain('--scheme=bogus');
      expect(ev.message).toContain('balance/inflow:1');
      expect(ev.message).toContain('exact/eip155:84532');
    }
  });

  it('errors DECODE_FAILED when the PAYMENT-REQUIRED header does not decode', async () => {
    mock402('%%%not-a-header%%%');
    const events = await collect({ url: SELLER, probeOptions: { method: 'GET', headers: {} } });
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.type).toBe('errored');
    if (ev?.type === 'errored') {
      expect(ev.code).toBe('DECODE_FAILED');
      expect(ev.message.length).toBeGreaterThan(0);
    }
  });
});

describe('reduceX402Inspect — remaining transitions', () => {
  it('accepts → accepts phase carrying the result', () => {
    const result = { outcome: 'accepts', url: SELLER } as unknown as InspectResultAccepts;
    expect(reduceX402Inspect({ kind: 'probing' }, { type: 'accepts', result })).toEqual({ kind: 'accepts', result });
  });

  it('no-payment → no-payment phase carrying the result', () => {
    const result = { outcome: 'no-payment-required', url: SELLER } as unknown as InspectResultNoPayment;
    expect(reduceX402Inspect({ kind: 'probing' }, { type: 'no-payment', result })).toEqual({
      kind: 'no-payment',
      result,
    });
  });

  it('returns the prior state for an unrecognised event (default branch)', () => {
    const prior = { kind: 'probing' } as const;
    expect(reduceX402Inspect(prior, { type: 'bogus' } as never)).toBe(prior);
  });
});
