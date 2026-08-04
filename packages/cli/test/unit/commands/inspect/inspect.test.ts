import { MemoryStorage, type CombinedInspectResult } from '@inflowpayai/inflow-core';
import { encode, type MppChallenge, renderChallengeHeader } from '@inflowpayai/mpp';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCombinedFrame,
  createInspectCommand,
  type InspectCommandContext,
  runCombinedInspectCommand,
} from '../../../../src/commands/inspect/index.js';

const URL = 'https://seller.test/api';

afterEach(() => {
  vi.restoreAllMocks();
});

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof Request) return input.url;
  return input.href;
}

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
  };
}

describe('buildCombinedFrame', () => {
  it('includes the AEP Inspect document and lists AEP first', () => {
    const result: CombinedInspectResult = {
      outcome: 'inspected',
      url: URL,
      method: 'GET',
      status: 401,
      aep: {
        kind: 'service',
        reason: 'not_recognized',
        source: 'challenge',
        inspect: {
          commandUrl: (command: string) => new globalThis.URL(`https://seller.test/aep/${command}`),
          document: {
            aep_version: '1.0',
            bindings: { supported: ['http'] },
            commands: { supported: ['inspect', 'enroll', 'status'] },
            core: { signing_algorithms: ['ES256'] },
            http: { endpoint_base: '/aep' },
            identity: { methods: ['did:web'] },
            service: { did: 'did:web:service.test' },
          },
          finalUrl: new globalThis.URL('https://seller.test/.well-known/aep'),
          inspectUrl: new globalThis.URL('https://seller.test/.well-known/aep'),
        },
      },
      mpp: { kind: 'absent' },
      x402: { kind: 'absent' },
    };
    const frame = buildCombinedFrame(result);
    expect(frame['detected']).toEqual(['aep']);
    expect(frame['aep']).toMatchObject({
      required: true,
      challenge: { reason: 'not_recognized' },
      inspect: { service_url: 'https://seller.test' },
      source: 'challenge',
    });
  });

  it('reports an AEP discovery failure without hiding the authentication requirement', () => {
    const frame = buildCombinedFrame({
      outcome: 'inspected',
      url: URL,
      method: 'GET',
      status: 401,
      aep: { kind: 'error', code: 'AEP_INSPECT_FAILED', message: 'discovery failed', source: 'challenge' },
      mpp: { kind: 'absent' },
      x402: { kind: 'absent' },
    });
    expect(frame['detected']).toEqual(['aep']);
    expect(frame['aep']).toEqual({
      required: true,
      error: { code: 'AEP_INSPECT_FAILED', message: 'discovery failed' },
      source: 'challenge',
    });
    expect(frame['warnings']).toEqual([{ protocol: 'aep', code: 'AEP_INSPECT_FAILED', message: 'discovery failed' }]);
  });

  it('both protocols: fixed-shape arrays, detected lists both, no warnings', () => {
    const result: CombinedInspectResult = {
      outcome: 'inspected',
      url: URL,
      method: 'GET',
      status: 402,
      aep: { kind: 'absent', source: 'anonymous_probe' },
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
    expect(frame['detected']).toEqual(['mpp', 'x402']);
    expect((frame['mpp'] as unknown[]).length).toBe(1);
    expect((frame['x402'] as unknown[]).length).toBe(1);
    expect(frame['x402_version']).toBe(2);
    expect('warnings' in frame).toBe(false);
  });

  it('neither header: empty arrays, empty detected, NO_PAYMENT_CHALLENGE warning', () => {
    const result: CombinedInspectResult = {
      outcome: 'inspected',
      url: URL,
      method: 'GET',
      status: 402,
      aep: { kind: 'absent', source: 'anonymous_probe' },
      mpp: { kind: 'absent' },
      x402: { kind: 'absent' },
    };
    const frame = buildCombinedFrame(result);
    expect(frame['detected']).toEqual([]);
    expect(frame['mpp']).toEqual([]);
    expect(frame['x402']).toEqual([]);
    const warnings = frame['warnings'] as Array<{ protocol: string; code: string }>;
    expect(warnings.some((w) => w.code === 'NO_PAYMENT_CHALLENGE')).toBe(true);
  });

  it('unsupported MPP method + x402 decode error: warnings carry both, name the offered method, detected empty', () => {
    const result: CombinedInspectResult = {
      outcome: 'inspected',
      url: URL,
      method: 'GET',
      status: 402,
      aep: { kind: 'absent', source: 'anonymous_probe' },
      mpp: { kind: 'none-inflow', methods: ['other'] },
      x402: { kind: 'error', code: 'DECODE_FAILED', message: 'bad header' },
    };
    const frame = buildCombinedFrame(result);
    expect(frame['detected']).toEqual([]);
    const warnings = frame['warnings'] as Array<{
      protocol: string;
      code: string;
      message: string;
      methods?: string[];
    }>;
    const mppWarning = warnings.find((w) => w.protocol === 'mpp' && w.code === 'NO_INFLOW_MATCH');
    expect(mppWarning).toBeDefined();
    expect(mppWarning?.methods).toEqual(['other']);
    expect(mppWarning?.message).toContain('other');
    expect(warnings.some((w) => w.protocol === 'x402' && w.code === 'DECODE_FAILED')).toBe(true);
  });

  it('keeps OpenAPI fallback metadata on anonymous-probe AEP source', () => {
    const frame = buildCombinedFrame({
      outcome: 'inspected',
      url: URL,
      method: 'GET',
      status: 200,
      aep: {
        kind: 'absent',
        openApiPolicy: {
          freshness: 'fresh',
          methods: [],
          source: 'openapi',
          state: 'fallback',
          strictSlashSuggestion: '/api',
        },
        source: 'anonymous_probe',
      },
      mpp: { kind: 'absent' },
      x402: { kind: 'absent' },
    });

    expect(frame['aep']).toEqual({
      openapi: { accepted_methods: [], freshness: 'fresh', state: 'fallback', strict_slash_suggestion: '/api' },
      required: false,
      source: 'anonymous_probe',
    });
  });

  it('reports blocked AEP payment inspection from definitive OpenAPI policy', () => {
    const frame = buildCombinedFrame({
      outcome: 'inspected',
      url: URL,
      method: 'GET',
      status: 401,
      aep: {
        kind: 'blocked',
        inspect: {
          commandUrl: (command: string) => new globalThis.URL(`https://seller.test/aep/${command}`),
          document: {
            aep_version: '1.0',
            bindings: { supported: ['http'] },
            commands: { supported: ['inspect', 'status'] },
            core: { signing_algorithms: ['ES256'] },
            http: { endpoint_base: '/aep' },
            identity: { methods: ['did:web'] },
            service: { did: 'did:web:seller.test' },
          },
          finalUrl: new globalThis.URL('https://seller.test/.well-known/aep'),
          inspectUrl: new globalThis.URL('https://seller.test/.well-known/aep'),
        },
        message: 'AEP authentication is required before payment terms can be inspected.',
        policy: {
          freshness: 'fresh',
          matchedOperation: { method: 'GET', pathTemplate: '/api' },
          methods: ['aep-jwt'],
          source: 'openapi',
          state: 'required',
        },
        source: 'openapi',
      },
      mpp: { kind: 'absent' },
      x402: { kind: 'absent' },
    });

    expect(frame['detected']).toEqual(['aep']);
    expect(frame['aep']).toMatchObject({
      blocked: true,
      inspect: { service_url: 'https://seller.test' },
      message: 'AEP authentication is required before payment terms can be inspected.',
      openapi: {
        accepted_methods: ['aep-jwt'],
        matched_operation: { method: 'GET', path_template: '/api' },
        state: 'required',
      },
      required: true,
      source: 'openapi',
    });
    expect(frame['warnings']).toEqual([
      {
        code: 'AEP_PAYMENT_INSPECT_BLOCKED',
        message: 'AEP authentication is required before payment terms can be inspected.',
        protocol: 'aep',
      },
    ]);
  });
});

describe('runCombinedInspectCommand (agent path)', () => {
  it('registers the top-level Inspect command metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const command = createInspectCommand({} as never, new MemoryStorage());
    expect(command.description).toBe('Inspect a URL for agent enrollment and payment requirements');
    expect(command.outputPolicy).toBe('agent-only');
    expect(command.examples).toHaveLength(2);
    expect(await command.run(ctx())).toBeDefined();
  });

  it('returns a combined frame decoding both protocols from one 402', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('payment required', {
        status: 402,
        headers: { 'WWW-Authenticate': mppHeader(), 'PAYMENT-REQUIRED': x402Header() },
      }),
    );
    const frame = await runCombinedInspectCommand(ctx());
    expect(frame?.['detected']).toEqual(['mpp', 'x402']);
    expect((frame?.['mpp'] as unknown[]).length).toBe(1);
    expect((frame?.['x402'] as unknown[]).length).toBe(1);
  });

  it('returns OpenAPI AEP policy without probing the protected resource', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = requestUrl(input);
      if (url !== 'https://seller.test/openapi.json') {
        return Promise.reject(new Error(`Unexpected fetch: ${url}`));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            openapi: '3.1.0',
            components: {
              securitySchemes: {
                session: { type: 'http', scheme: 'bearer', 'x-aep-authentication-method': 'aep-jwt' },
              },
            },
            security: [{ session: [] }],
            paths: { '/api': { get: {} } },
          }),
          { headers: { 'cache-control': 'max-age=300', 'content-type': 'application/json' } },
        ),
      );
    });
    const inspect = {
      commandUrl: (command: string) => new globalThis.URL(`https://seller.test/aep/${command}`),
      document: {
        aep_version: '1.0',
        bindings: { supported: ['http'] },
        commands: { supported: ['inspect', 'status'] },
        core: { signing_algorithms: ['ES256'] },
        http: {
          endpoint_base: '/aep',
          openapi: { path_matching: { trailing_slash: 'strict' }, url: '/openapi.json' },
        },
        identity: { methods: ['did:web'] },
        service: { did: 'did:web:seller.test' },
      },
      finalUrl: new globalThis.URL('https://seller.test/.well-known/aep'),
      inspectUrl: new globalThis.URL('https://seller.test/.well-known/aep'),
    };

    const frame = await runCombinedInspectCommand(
      ctx(),
      { aep: { inspect: vi.fn().mockResolvedValue(inspect) } } as never,
      new MemoryStorage(),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(frame?.['aep']).toMatchObject({
      openapi: {
        freshness: 'fetched',
        matched_operation: { method: 'GET', path_template: '/api' },
        state: 'required',
      },
      required: true,
      source: 'openapi',
    });
  });

  it('returns a no-payment frame on a 2xx probe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('hi', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const frame = await runCombinedInspectCommand(ctx());
    expect(frame?.['outcome']).toBe('no-payment-required');
    expect(frame?.['status']).toBe(200);
  });

  it('errors UNEXPECTED_PROBE_STATUS on a 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(runCombinedInspectCommand(ctx())).rejects.toThrow('UNEXPECTED_PROBE_STATUS');
  });
});
