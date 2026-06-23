import type { CombinedInspectResult } from '@inflowpayai/inflow-core';
import { encode, type MppChallenge, renderChallengeHeader } from '@inflowpayai/mpp';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCombinedFrame,
  type InspectCommandContext,
  runCombinedInspectCommand,
} from '../../../../src/commands/inspect/index.js';

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

function ctx(): InspectCommandContext {
  return {
    agent: true,
    formatExplicit: true,
    args: { url: URL },
    options: { method: 'GET', header: [] },
    error: (o: { code: string; message: string }) => {
      throw new Error(`${o.code}: ${o.message}`);
    },
  } as InspectCommandContext;
}

describe('buildCombinedFrame', () => {
  it('both protocols: fixed-shape arrays, detected lists both, no warnings', () => {
    const result: CombinedInspectResult = {
      outcome: 'inspected',
      url: URL,
      method: 'GET',
      status: 402,
      mpp: {
        kind: 'challenges',
        realm: 'mpp.test',
        challenges: [
          {
            id: 'c',
            realm: 'mpp.test',
            method: 'inflow',
            intent: 'charge',
            amount: '0.10',
            currency: 'USDC',
            rail: 'balance',
          },
        ],
      },
      x402: {
        kind: 'accepts',
        resource: URL,
        x402Version: 2,
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:84532',
            amount: '10000',
            asset: '0xabc',
            payTo: '0xdef',
            maxTimeoutSeconds: 300,
            extra: { name: 'USDC' },
          },
        ],
      },
    };
    const frame = buildCombinedFrame(result);
    expect(frame.detected).toEqual(['mpp', 'x402']);
    expect((frame.mpp as unknown[]).length).toBe(1);
    expect((frame.x402 as unknown[]).length).toBe(1);
    expect(frame.x402_version).toBe(2);
    expect('warnings' in frame).toBe(false);
  });

  it('neither header: empty arrays, empty detected, NO_PAYMENT_CHALLENGE warning', () => {
    const result: CombinedInspectResult = {
      outcome: 'inspected',
      url: URL,
      method: 'GET',
      status: 402,
      mpp: { kind: 'absent' },
      x402: { kind: 'absent' },
    };
    const frame = buildCombinedFrame(result);
    expect(frame.detected).toEqual([]);
    expect(frame.mpp).toEqual([]);
    expect(frame.x402).toEqual([]);
    const warnings = frame.warnings as Array<{ protocol: string; code: string }>;
    expect(warnings.some((w) => w.code === 'NO_PAYMENT_CHALLENGE')).toBe(true);
  });

  it('unsupported MPP method + x402 decode error: warnings carry both, name the offered method, detected empty', () => {
    const result: CombinedInspectResult = {
      outcome: 'inspected',
      url: URL,
      method: 'GET',
      status: 402,
      mpp: { kind: 'none-inflow', methods: ['other'] },
      x402: { kind: 'error', code: 'DECODE_FAILED', message: 'bad header' },
    };
    const frame = buildCombinedFrame(result);
    expect(frame.detected).toEqual([]);
    const warnings = frame.warnings as Array<{ protocol: string; code: string; message: string; methods?: string[] }>;
    const mppWarning = warnings.find((w) => w.protocol === 'mpp' && w.code === 'NO_INFLOW_MATCH');
    expect(mppWarning).toBeDefined();
    expect(mppWarning?.methods).toEqual(['other']);
    expect(mppWarning?.message).toContain('other');
    expect(warnings.some((w) => w.protocol === 'x402' && w.code === 'DECODE_FAILED')).toBe(true);
  });
});

describe('runCombinedInspectCommand (agent path)', () => {
  it('returns a combined frame decoding both protocols from one 402', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('payment required', {
        status: 402,
        headers: { 'WWW-Authenticate': mppHeader(), 'PAYMENT-REQUIRED': x402Header() },
      }),
    );
    const frame = await runCombinedInspectCommand(ctx());
    expect(frame?.detected).toEqual(['mpp', 'x402']);
    expect((frame?.mpp as unknown[]).length).toBe(1);
    expect((frame?.x402 as unknown[]).length).toBe(1);
  });

  it('returns a no-payment frame on a 2xx probe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('hi', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const frame = await runCombinedInspectCommand(ctx());
    expect(frame?.outcome).toBe('no-payment-required');
    expect(frame?.status).toBe(200);
  });

  it('errors UNEXPECTED_PROBE_STATUS on a 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(runCombinedInspectCommand(ctx())).rejects.toThrow('UNEXPECTED_PROBE_STATUS');
  });
});
