import {
  AepStorage,
  Inflow,
  SecureStorageError,
  MemoryStorage,
  type CombinedInspectNoPayment,
  type CombinedInspectResult,
  type ITapResource,
  type ServiceInspection,
} from '@inflowpayai/inflow-core';
import { encode, type MppChallenge, renderChallengeHeader } from '@inflowpayai/mpp';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCombinedFrame as combinedFrame,
  buildNoPaymentFrame as noPaymentFrame,
  createInspectCommand,
  type InspectCommandContext,
  runCombinedInspectCommand as combinedCommand,
} from '../../../../src/commands/inspect/index.js';
import { inspectOutput } from '../../../../src/commands/inspect/schema.js';

function checkedFrame<T>(frame: T): T {
  if (frame !== undefined) expect(inspectOutput.safeParse(frame).error).toBeUndefined();
  return frame;
}
const buildCombinedFrame = (...args: Parameters<typeof combinedFrame>) => checkedFrame(combinedFrame(...args));
const buildNoPaymentFrame = (...args: Parameters<typeof noPaymentFrame>) => checkedFrame(noPaymentFrame(...args));
const runCombinedInspectCommand = async (...args: Parameters<typeof combinedCommand>) =>
  checkedFrame(await combinedCommand(...args));

const URL = 'https://seller.test/api';

const odpInspect = {
  capabilities: {
    enrollment: [{ name: 'aep' }],
    operations: [
      { authentication: 'not-required', name: 'get-offering' },
      { authentication: 'not-required', name: 'list-offerings' },
    ],
    payments: [],
    trust: [],
  },
  document: {
    description: 'Example products',
    http: { endpoint_base: '/odp' },
    language: 'en',
    localizations: ['en'],
    mcp: [
      {
        description: 'Browse the example catalog.',
        name: 'Catalog',
        type: 'streamable-http',
        url: '/mcp',
      },
    ],
    name: 'Example',
    odp_version: '1.0',
    operations: [
      { authentication: 'not-required', name: 'get-offering' },
      { authentication: 'not-required', name: 'list-offerings' },
    ],
  },
  finalUrl: new globalThis.URL('https://seller.test/.well-known/odp'),
  freshness: 'fetched',
  requestedUrl: new globalThis.URL('https://seller.test/.well-known/odp'),
  serviceOrigin: 'https://seller.test',
} satisfies ServiceInspection;

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

it('includes an x402 warning without losing the inspected resource or version', () => {
  const frame = buildCombinedFrame({
    outcome: 'inspected',
    url: URL,
    method: 'GET',
    odp: { kind: 'absent' },
    aep: { kind: 'absent', source: 'anonymous_probe' },
    mpp: { kind: 'absent' },
    x402: { kind: 'accepts', resource: URL, x402Version: 2, accepts: [], warning: 'Unsupported offers' },
  });
  expect(frame).toMatchObject({
    x402: [],
    x402_resource: URL,
    x402_version: 2,
    warnings: [{ protocol: 'x402', code: 'NO_INFLOW_MATCH', message: 'Unsupported offers' }],
  });
});

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
  it.each(['discovered', 'openapi', 'service', 'blocked'] as const)(
    'retains the original inspection URL when %s has no redirect URL',
    (kind) => {
      const inspect = {
        commandUrl: (command: string) => new globalThis.URL(`https://seller.test/aep/${command}`),
        inspectUrl: new globalThis.URL('https://seller.test/.well-known/aep'),
        document: {
          aep_version: '1.0',
          bindings: { supported: ['http'] },
          commands: { supported: ['inspect', 'status'] },
          core: { signing_algorithms: ['ES256'] },
          http: {},
          identity: { methods: ['did:web'] },
          service: { did: 'did:web:seller.test' },
        },
      };
      const policy = {
        freshness: 'fetched' as const,
        methods: ['api-key'],
        source: 'openapi' as const,
        state: 'required' as const,
      };
      const aep: CombinedInspectResult['aep'] =
        kind === 'discovered'
          ? { kind, inspect, source: 'anonymous_probe' }
          : kind === 'openapi'
            ? { kind, inspect, policy }
            : kind === 'blocked'
              ? { kind, inspect, policy, source: 'openapi', message: 'Authenticate first.' }
              : { kind, inspect, source: 'challenge', openApiPolicy: policy };
      const frame = buildCombinedFrame({
        outcome: 'inspected',
        method: 'GET',
        url: URL,
        odp: { kind: 'absent' },
        aep,
        mpp: { kind: 'absent' },
        x402: { kind: 'absent' },
      });
      expect(frame['aep']).toMatchObject({
        required: kind !== 'discovered',
        inspect: { service_url: 'https://seller.test' },
      });
      expect(frame['aep']).not.toHaveProperty('challenge');
      if (kind !== 'discovered') expect(frame['aep']).toHaveProperty('openapi.accepted_methods', ['api-key']);
    },
  );

  it('preserves authentication diagnostics on a free response without misclassifying it as a payment', () => {
    const frame = buildNoPaymentFrame({
      outcome: 'no-payment-required',
      method: 'GET',
      url: URL,
      status: 401,
      contentType: undefined,
      bodySizeBytes: 0,
      odp: { kind: 'absent' },
      aep: {
        kind: 'error',
        code: 'AEP_INSPECT_FAILED',
        message: 'Unavailable',
        reason: 'authentication_required',
        source: 'challenge',
        openApiPolicy: { freshness: 'fetched', methods: [], source: 'openapi', state: 'fallback' },
      },
    });
    expect(frame).toMatchObject({
      outcome: 'no-payment-required',
      status: 401,
      aep: { required: true, challenge: { reason: 'authentication_required' }, openapi: { state: 'fallback' } },
      warnings: [{ protocol: 'aep', code: 'AEP_INSPECT_FAILED' }],
    });
    expect(frame).not.toHaveProperty('x402');
    expect(frame).not.toHaveProperty('mpp');
  });

  it('retains x402 extensions for agent output', () => {
    const extensions = { 'payment-identifier': { info: { required: false } } };
    const frame = buildCombinedFrame({
      outcome: 'inspected',
      method: 'GET',
      url: URL,
      odp: { kind: 'absent' },
      aep: { kind: 'absent', source: 'anonymous_probe' },
      mpp: { kind: 'absent' },
      x402: { kind: 'accepts', x402Version: 2, resource: URL, accepts: [], extensions },
    });
    expect(frame['x402_extensions']).toEqual(extensions);
  });

  it('includes ODP and AEP inspection documents in protocol order', () => {
    const result: CombinedInspectResult = {
      outcome: 'inspected',
      url: URL,
      method: 'GET',
      status: 401,
      odp: { kind: 'service', inspect: odpInspect },
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
    expect(frame['detected']).toEqual(['odp', 'aep']);
    expect(frame['odp']).toMatchObject({
      available: true,
      inspect: {
        document: { mcp: odpInspect.document.mcp },
        service_origin: 'https://seller.test',
      },
    });
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
      odp: { kind: 'absent' },
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
      odp: { kind: 'absent' },
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
      odp: { kind: 'absent' },
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
      odp: { kind: 'absent' },
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
      odp: { kind: 'absent' },
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
      odp: { kind: 'absent' },
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
  it('rejects a malformed header before any network request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(
      runCombinedInspectCommand({ ...ctx(), options: { method: 'GET', header: ['missing-separator'] } }),
    ).rejects.toThrow('INVALID_HEADER');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a malformed MPP challenge without losing the valid x402 offer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 402,
        headers: { 'WWW-Authenticate': 'Payment id="invalid"', 'PAYMENT-REQUIRED': x402Header() },
      }),
    );
    const frame = await runCombinedInspectCommand(ctx());
    expect(frame?.['detected']).toEqual(['x402']);
    expect(frame?.['warnings']).toEqual(expect.arrayContaining([expect.objectContaining({ protocol: 'mpp' })]));
  });
  it.each([
    [new SecureStorageError('vault_locked', 'Locked'), 'VAULT_LOCKED'],
    [new Error('Unavailable'), 'Unavailable'],
  ])('prepares credentials before inspecting a resource: %s', async (error, expected) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const prepare = vi.fn().mockRejectedValue(error);
    const command = createInspectCommand(
      new Inflow({ authStorage: new MemoryStorage() }),
      undefined,
      undefined,
      undefined,
      prepare,
    );
    await expect(command.run(ctx())).rejects.toThrow(expected);
    expect(prepare).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('registers the top-level Inspect command metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const command = createInspectCommand(
      {
        aep: { inspect: vi.fn().mockRejectedValue(new Error('AEP absent')) },
        capabilities: { has: vi.fn().mockResolvedValue(false) },
        odp: { inspect: vi.fn().mockRejectedValue(new Error('ODP absent')) },
        tap: { canSign: () => true, sign: vi.fn() },
      } as never,
      new MemoryStorage(),
    );
    expect(command.description).toBe('Inspect a URL for agent discovery, enrollment, and payment capabilities');
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

  it('signs the primary combined-inspection request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const has = vi.fn().mockResolvedValue(true);
    const sign = vi.fn<ITapResource['sign']>().mockResolvedValue({
      created: 1,
      expires: 301,
      keyid: 'key',
      nonce: 'nonce',
      signature: 'sig2=:value:',
      signatureInput: 'sig2=("@method")',
    });

    await runCombinedInspectCommand(
      ctx(),
      {
        aep: { inspect: vi.fn().mockRejectedValue(new Error('AEP absent')) },
        capabilities: { has },
        tap: { canSign: () => true, sign },
      } as never,
      undefined,
      { inspect: vi.fn().mockRejectedValue(new Error('ODP absent')) },
    );

    expect(has).toHaveBeenCalled();
    const signOptions = sign.mock.calls[0]?.[1];
    expect(signOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(sign).toHaveBeenCalledWith({ method: 'GET', operation: 'odp.browse', targetUrl: URL }, signOptions);
    expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('Signature')).toBe('sig2=:value:');
  });

  it('sends POST inspection data with an inferred JSON content type', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await runCombinedInspectCommand(
      {
        ...ctx(),
        options: { data: '{"query":"gpu"}', header: [], method: 'POST' },
      },
      {
        aep: { inspect: vi.fn().mockRejectedValue(new Error('AEP absent')) },
        capabilities: { has: vi.fn().mockResolvedValue(false) },
        tap: { canSign: () => true, sign: vi.fn() },
      } as never,
      undefined,
      { inspect: vi.fn().mockRejectedValue(new Error('ODP absent')) },
    );

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(Buffer.from(init?.body as Uint8Array).toString()).toBe('{"query":"gpu"}');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
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
      {
        aep: { inspect: vi.fn().mockResolvedValue(inspect) },
        capabilities: { has: vi.fn().mockResolvedValue(false) },
        tap: { canSign: () => true, sign: vi.fn() },
      } as never,
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

  it.each([
    { method: 'GET', scenario: 'success' },
    { method: 'POST', scenario: 'success' },
    { method: 'POST', scenario: 'explicit-content-type' },
    { method: 'GET', scenario: 'no-credential' },
    { method: 'GET', scenario: 'no-storage' },
    { method: 'GET', scenario: 'user-unavailable' },
    { method: 'GET', scenario: 'request-failed' },
  ])('inspects a protected resource: $method $scenario', async ({ method, scenario }) => {
    const storage = new MemoryStorage();
    const client = new Inflow({ apiBaseUrl: 'https://platform.example', apiKey: 'platform-key' });
    vi.spyOn(client.capabilities, 'has').mockResolvedValue(false);
    vi.spyOn(client.tap, 'canSign').mockReturnValue(false);
    vi.spyOn(client.user, 'retrieve').mockResolvedValue({
      userId: 'user-1',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
      email: null,
      firstName: null,
      lastName: null,
      username: null,
      mobile: null,
      locale: 'EN_US',
      timezone: 'UTC',
    });
    if (scenario === 'user-unavailable')
      vi.spyOn(client.user, 'retrieve').mockRejectedValue(new Error('user unavailable'));
    if (scenario !== 'no-credential')
      await new AepStorage(storage, { platformOrigin: 'https://platform.example', userId: 'user-1' })
        .credentials()
        .saveCredential({
          credential: {
            access_token: 'stored-token',
            credential_id: 'cred-1',
            expires_at: '2999-01-01T00:00:00Z',
            scopes: [],
            token_type: 'Bearer',
          },
          credentialId: 'cred-1',
          expiresAt: '2999-01-01T00:00:00Z',
          grantType: 'oauth-bearer',
          issuedAt: '2026-01-01T00:00:00Z',
          serviceDid: 'did:web:seller.test',
        });
    const requests: RequestInit[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === URL) {
        requests.push(init ?? {});
        if (scenario === 'request-failed') throw new Error('resource unavailable');
        return Promise.resolve(
          new Response('', {
            status: 402,
            headers: { 'www-authenticate': mppHeader(), 'payment-required': x402Header() },
          }),
        );
      }
      expect(new Headers(init?.headers).has('AEP-Authorization')).toBe(false);
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      if (url === 'https://seller.test/.well-known/aep') {
        return Promise.resolve(
          Response.json(
            {
              aep_version: '1.0',
              authentication: { methods: ['oauth-bearer'] },
              bindings: { supported: ['http'] },
              commands: { supported: ['inspect', 'status', 'grant'], grant_types: ['oauth-bearer'] },
              core: { signing_algorithms: ['EdDSA', 'ES256'] },
              identity: { methods: ['did:web'] },
              http: {
                endpoint_base: '/aep',
                openapi: { url: '/openapi.json', path_matching: { trailing_slash: 'strict' } },
              },
              service: { did: 'did:web:seller.test' },
            },
            { headers: { 'content-type': 'application/aep+json', 'cache-control': 'max-age=300' } },
          ),
        );
      }
      if (url === 'https://seller.test/openapi.json') {
        return Promise.resolve(
          Response.json({
            openapi: '3.1.0',
            components: {
              securitySchemes: {
                session: { type: 'http', scheme: 'bearer', 'x-aep-authentication-method': 'oauth-bearer' },
              },
            },
            paths: { '/api': { [method.toLowerCase()]: { security: [{ session: [] }] } } },
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const frame = await runCombinedInspectCommand(
      {
        ...ctx(),
        options: {
          method,
          header: [
            'X-Request: example',
            ...(scenario === 'explicit-content-type' ? ['Content-Type: application/custom+json'] : []),
          ],
          ...(method === 'POST' ? { data: '{"query":"gpu"}' } : {}),
        },
      },
      client,
      scenario === 'no-storage' ? undefined : storage,
      { inspect: vi.fn().mockResolvedValue(odpInspect) },
    );
    if (['no-credential', 'no-storage', 'user-unavailable', 'request-failed'].includes(scenario)) {
      expect(frame?.['detected']).toEqual(['odp', 'aep']);
      expect(frame?.['aep']).toMatchObject({ required: true, source: 'openapi', blocked: true });
      expect(requests).toHaveLength(scenario === 'request-failed' ? 1 : 0);
      if (scenario === 'request-failed')
        expect(new Headers(requests[0]?.headers).get('AEP-Authorization')).toBe('Bearer stored-token');
      return;
    }
    expect(frame?.['detected']).toEqual(['odp', 'aep', 'mpp', 'x402']);
    expect(frame?.['aep']).toMatchObject({ required: true, source: 'openapi', openapi: { state: 'required' } });
    expect(requests).toHaveLength(1);
    const headers = new Headers(requests[0]?.headers);
    expect(headers.get('AEP-Authorization')).toBe('Bearer stored-token');
    expect(headers.get('X-Request')).toBe('example');
    expect(requests[0]?.method).toBe(method);
    if (method === 'POST') {
      expect(await new Response(requests[0]?.body).text()).toBe('{"query":"gpu"}');
      expect(headers.get('Content-Type')).toBe(
        scenario === 'explicit-content-type' ? 'application/custom+json' : 'application/json',
      );
    } else expect(requests[0]?.body).toBeUndefined();
  });

  it.each([200, 500])('finishes real interactive inspection for HTTP %i', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('response', { status }));
    const error = vi.fn(ctx().error);
    const run = runCombinedInspectCommand({ ...ctx(), agent: false, formatExplicit: false, error });
    if (status === 200) {
      await expect(run).resolves.toBeUndefined();
      expect(error).not.toHaveBeenCalled();
    } else {
      await expect(run).rejects.toThrow('UNEXPECTED_PROBE_STATUS');
      expect(error).toHaveBeenCalledOnce();
    }
  });

  it('returns a no-payment frame on a 2xx probe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('hi', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const frame = await runCombinedInspectCommand(ctx());
    expect(frame?.['outcome']).toBe('no-payment-required');
    expect(frame?.['status']).toBe(200);
  });

  it('preserves AEP Service discovery when the probed URL is public', () => {
    const frame = buildNoPaymentFrame({
      outcome: 'no-payment-required',
      url: URL,
      method: 'GET',
      status: 200,
      contentType: 'text/html',
      bodySizeBytes: 2,
      odp: { kind: 'service', inspect: odpInspect },
      aep: {
        kind: 'discovered',
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
        source: 'anonymous_probe',
      },
    } satisfies CombinedInspectNoPayment);

    expect(frame['detected']).toEqual(['odp', 'aep']);
    expect(frame['odp']).toMatchObject({
      available: true,
      inspect: {
        document: { mcp: odpInspect.document.mcp },
        service_origin: 'https://seller.test',
      },
    });
    expect(frame['aep']).toMatchObject({
      required: false,
      source: 'anonymous_probe',
      inspect: { service_url: 'https://seller.test' },
    });
  });

  it('errors UNEXPECTED_PROBE_STATUS on a 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(runCombinedInspectCommand(ctx())).rejects.toThrow('UNEXPECTED_PROBE_STATUS');
  });
});
