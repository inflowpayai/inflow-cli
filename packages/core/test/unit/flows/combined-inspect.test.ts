import { encode, type MppChallenge, renderChallengeHeader } from '@inflowpayai/mpp';
import { AepInspectError } from '@aep-foundation/agent';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServiceInspection } from '@offering-protocol/agent';
import {
  type CombinedInspectEvent,
  reduceCombinedInspect,
  runCombinedInspectPipeline,
} from '../../../src/flows/combined-inspect.js';
import { DEFAULT_ACCEPT_PAYMENT_HEADER } from '../../../src/flows/mpp-shared.js';

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

const aepInspect = {
  document: {
    commands: { supported: ['inspect', 'enroll', 'status'] },
    identity: { methods: ['did:web'] },
    service: { did: 'did:web:service.test' },
  },
  finalUrl: new globalThis.URL('https://seller.test/.well-known/aep'),
  inspectUrl: new globalThis.URL('https://seller.test/.well-known/aep'),
};

const odpInspect = {
  capabilities: {
    enrollment: [{ name: 'aep' }],
    operations: [
      { authentication: 'not-required', name: 'get-offering' },
      { authentication: 'not-required', name: 'list-offerings' },
    ],
    payments: [],
  },
  document: {
    description: 'Example products',
    http: { endpoint_base: '/odp' },
    language: 'en',
    localizations: ['en'],
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

describe('runCombinedInspectPipeline', () => {
  async function collectWithHeaders(
    probeHeaders: Record<string, string>,
    customFetch?: (
      input: Parameters<typeof globalThis.fetch>[0],
      init: Parameters<typeof globalThis.fetch>[1],
    ) => Promise<Response>,
  ): Promise<Headers | undefined> {
    let observed: Headers | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
        observed = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
        const response =
          customFetch === undefined ? new Response('payment required', { status: 200 }) : customFetch(input, init);
        return Promise.resolve(response);
      },
    );
    await runCombinedInspectPipeline(
      { probeOptions: { method: 'GET', headers: probeHeaders }, url: URL },
      () => undefined,
    );
    return observed;
  }

  it('includes independent ODP inspection without changing the resource probe', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('hi', { status: 200 }));
    const events: CombinedInspectEvent[] = [];

    await runCombinedInspectPipeline(
      {
        inspectOdp: vi.fn().mockResolvedValue(odpInspect),
        probeOptions: { method: 'GET', headers: {} },
        url: URL,
      },
      (event) => events.push(event),
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(events[0]?.type).toBe('no-payment');
    if (events[0]?.type === 'no-payment')
      expect(events[0].result.odp).toEqual({ kind: 'service', inspect: odpInspect });
  });

  it('blocks definitive OpenAPI AEP policy without probing the resource when no credential is available', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('probe should not run'));
    const inspectAep = vi.fn().mockResolvedValue(aepInspect);
    const inspectAepPolicy = vi.fn().mockResolvedValue({
      freshness: 'fresh',
      matchedOperation: { method: 'GET', pathTemplate: '/api' },
      methods: ['api-key'],
      source: 'openapi',
      state: 'required',
    });
    const events: CombinedInspectEvent[] = [];

    await runCombinedInspectPipeline(
      { inspectAep, inspectAepPolicy, url: URL, probeOptions: { method: 'GET', headers: {} } },
      (event) => events.push(event),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(inspectAep).toHaveBeenCalledWith(URL);
    expect(inspectAepPolicy).toHaveBeenCalledWith(aepInspect, { method: 'GET', url: URL });
    expect(events[0]?.type).toBe('inspected');
    if (events[0]?.type !== 'inspected') return;
    expect(events[0].result.aep).toMatchObject({
      kind: 'blocked',
      policy: { state: 'required', matchedOperation: { method: 'GET', pathTemplate: '/api' } },
      source: 'openapi',
    });
    expect(events[0].result.mpp).toEqual({ kind: 'absent' });
  });

  it('uses a supplied stored-credential probe to reveal payment terms behind definitive OpenAPI AEP policy', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('anonymous probe should not run'));
    const authenticatedResponse = new Response('payment required', {
      status: 402,
      headers: { 'WWW-Authenticate': renderChallengeHeader(mppChallenge()), 'PAYMENT-REQUIRED': x402Header() },
    });
    const authenticatedProbe = vi.fn().mockResolvedValue({
      bytes: new Uint8Array(await authenticatedResponse.arrayBuffer()),
      contentType: authenticatedResponse.headers.get('content-type') ?? undefined,
      headers: authenticatedResponse.headers,
      status: authenticatedResponse.status,
    });
    const events: CombinedInspectEvent[] = [];

    await runCombinedInspectPipeline(
      {
        authenticatedProbe,
        inspectAep: vi.fn().mockResolvedValue(aepInspect),
        inspectAepPolicy: vi.fn().mockResolvedValue({
          freshness: 'fresh',
          matchedOperation: { method: 'GET', pathTemplate: '/api' },
          methods: ['api-key'],
          source: 'openapi',
          state: 'required',
        }),
        url: URL,
        probeOptions: { method: 'GET', headers: {} },
      },
      (event) => events.push(event),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(authenticatedProbe).toHaveBeenCalledOnce();
    expect(authenticatedProbe).toHaveBeenCalledWith(aepInspect, {
      url: URL,
      method: 'GET',
      headers: { 'Accept-Payment': DEFAULT_ACCEPT_PAYMENT_HEADER },
    });
    expect(events[0]?.type).toBe('inspected');
    if (events[0]?.type !== 'inspected') return;
    expect(events[0].result.aep.kind).toBe('openapi');
    expect(events[0].result.mpp.kind).toBe('challenges');
    expect(events[0].result.x402.kind).toBe('accepts');
  });

  it('falls back to one resource probe when OpenAPI is not definitive', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('hi', { status: 200 }));
    const events: CombinedInspectEvent[] = [];

    await runCombinedInspectPipeline(
      {
        inspectAep: vi.fn().mockResolvedValue(aepInspect),
        inspectAepPolicy: vi.fn().mockResolvedValue({
          freshness: 'fresh',
          methods: [],
          source: 'openapi',
          state: 'fallback',
        }),
        url: URL,
        probeOptions: { method: 'GET', headers: {} },
      },
      (event) => events.push(event),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(events[0]?.type).toBe('no-payment');
    if (events[0]?.type !== 'no-payment') return;
    expect(events[0].result.aep).toEqual({
      kind: 'discovered',
      inspect: aepInspect,
      source: 'anonymous_probe',
    });
  });

  it('probes for payment after OpenAPI classifies the resource as public', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('payment required', {
        status: 402,
        headers: { 'WWW-Authenticate': renderChallengeHeader(mppChallenge()) },
      }),
    );
    const policy = {
      freshness: 'fresh' as const,
      matchedOperation: { method: 'GET', pathTemplate: '/api' },
      methods: [] as string[],
      source: 'openapi' as const,
      state: 'public' as const,
    };
    const events: CombinedInspectEvent[] = [];

    await runCombinedInspectPipeline(
      {
        inspectAep: vi.fn().mockResolvedValue(aepInspect),
        inspectAepPolicy: vi.fn().mockResolvedValue(policy),
        url: URL,
        probeOptions: { method: 'GET', headers: {} },
      },
      (event) => events.push(event),
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(events[0]?.type).toBe('inspected');
    if (events[0]?.type !== 'inspected') return;
    expect(events[0].result.aep).toEqual({ kind: 'openapi', inspect: aepInspect, policy });
    expect(events[0].result.mpp.kind).toBe('challenges');
  });

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

  it('discovers AEP from a 401 authentication challenge', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('authentication required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'AEP reason="not_recognized"' },
      }),
    );
    const inspectAep = vi.fn().mockResolvedValue(aepInspect);
    const events: CombinedInspectEvent[] = [];
    await runCombinedInspectPipeline({ inspectAep, url: URL, probeOptions: { method: 'GET', headers: {} } }, (event) =>
      events.push(event),
    );
    expect(inspectAep).toHaveBeenCalledWith(URL);
    expect(events[0]?.type).toBe('inspected');
    if (events[0]?.type !== 'inspected') return;
    expect(events[0].result.aep).toMatchObject({ kind: 'service', reason: 'not_recognized', source: 'challenge' });
    expect(events[0].result.mpp).toEqual({ kind: 'absent' });
  });

  it('keeps an AEP discovery failure inside the AEP section', async () => {
    mock402({ 'WWW-Authenticate': 'AEP' });
    const events: CombinedInspectEvent[] = [];
    await runCombinedInspectPipeline(
      {
        inspectAep: vi.fn().mockRejectedValue(new Error('discovery failed')),
        url: URL,
        probeOptions: { method: 'GET', headers: {} },
      },
      (event) => events.push(event),
    );
    expect(events[0]?.type).toBe('inspected');
    if (events[0]?.type !== 'inspected') return;
    expect(events[0].result.aep).toEqual({
      kind: 'error',
      code: 'AEP_INSPECT_FAILED',
      message: 'discovery failed',
      source: 'challenge',
    });
  });

  it('reports an AEP Service identity mismatch without obscuring the security failure', async () => {
    mock402({ 'WWW-Authenticate': 'AEP' });
    const mismatch = new AepInspectError('Service identity mismatch');
    Object.defineProperty(mismatch, 'code', { value: 'service_identity_mismatch' });
    const events: CombinedInspectEvent[] = [];
    await runCombinedInspectPipeline(
      {
        inspectAep: vi.fn().mockRejectedValue(mismatch),
        url: URL,
        probeOptions: { method: 'GET', headers: {} },
      },
      (event) => events.push(event),
    );
    expect(events[0]?.type).toBe('inspected');
    if (events[0]?.type !== 'inspected') return;
    expect(events[0].result.aep).toEqual({
      kind: 'error',
      code: 'AEP_SERVICE_IDENTITY_MISMATCH',
      message: 'Service identity mismatch',
      source: 'challenge',
    });
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

  it('MPP header present with Tempo challenge: MPP section carries Tempo', async () => {
    mock402({ 'WWW-Authenticate': renderChallengeHeader(mppChallenge('tempo')) });
    const [event] = await collect();
    expect(event?.type).toBe('inspected');
    if (event?.type !== 'inspected') return;
    expect(event.result.mpp.kind).toBe('challenges');
    if (event.result.mpp.kind === 'challenges') expect(event.result.mpp.challenges[0]?.method).toBe('tempo');
  });

  it('MPP header present but only unsupported method challenges: none-inflow, carrying the offered method(s)', async () => {
    mock402({ 'WWW-Authenticate': renderChallengeHeader(mppChallenge('other')) });
    const [event] = await collect();
    expect(event?.type).toBe('inspected');
    if (event?.type !== 'inspected') return;
    expect(event.result.mpp.kind).toBe('none-inflow');
    if (event.result.mpp.kind === 'none-inflow') expect(event.result.mpp.methods).toEqual(['other']);
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

  it('injects the default Accept-Payment header when probing with no caller header', async () => {
    const observed = await collectWithHeaders({}, () =>
      Promise.resolve(
        new Response('payment required', {
          status: 402,
          headers: { 'WWW-Authenticate': renderChallengeHeader(mppChallenge()) },
        }),
      ),
    );
    expect(observed?.get('accept-payment')).toBe(DEFAULT_ACCEPT_PAYMENT_HEADER);
  });

  it('preserves a caller-supplied lowercase Accept-Payment header on probe', async () => {
    const observed = await collectWithHeaders({ 'accept-payment': 'tempo/charge' }, () =>
      Promise.resolve(
        new Response('payment required', {
          status: 402,
          headers: { 'WWW-Authenticate': renderChallengeHeader(mppChallenge('tempo')) },
        }),
      ),
    );
    expect(observed?.get('accept-payment')).toBe('tempo/charge');
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
