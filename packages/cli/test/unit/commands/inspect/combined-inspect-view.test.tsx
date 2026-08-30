import { encode, type MppChallenge, renderChallengeHeader } from '@inflowpayai/mpp';
import type { ServiceInspection } from '@inflowpayai/inflow-core';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CombinedInspectView } from '../../../../src/commands/inspect/combined-inspect-view.js';

const URL = 'https://seller.test/api';

const odpInspect = {
  capabilities: {
    enrollment: [{ name: 'aep' }],
    operations: [{ authentication: 'not-required', name: 'list-offerings' }],
    payments: [
      { authentication: 'required', name: 'mpp' },
      { authentication: 'required', name: 'x402' },
    ],
    trust: [],
  },
  document: {
    description: 'Plant store',
    http: { endpoint_base: '/odp' },
    language: 'en',
    localizations: ['en'],
    mcp: [
      {
        description: 'Browse the plant catalog.',
        name: 'Storefront',
        type: 'streamable-http',
        url: '/mcp',
      },
    ],
    name: 'Indica Flowers',
    odp_version: '1.0',
    operations: [{ authentication: 'not-required', name: 'list-offerings' }],
    protocols: {
      enrollment: [{ name: 'aep' }],
      payments: [
        { authentication: 'required', name: 'mpp' },
        { authentication: 'required', name: 'x402' },
      ],
    },
  },
  finalUrl: new globalThis.URL('https://seller.test/.well-known/odp'),
  freshness: 'fetched',
  requestedUrl: new globalThis.URL('https://seller.test/.well-known/odp'),
  serviceOrigin: 'https://seller.test',
} satisfies ServiceInspection;

afterEach(() => {
  vi.restoreAllMocks();
});

function mppHeader(method = 'inflow', subscription = false): string {
  const request =
    method === 'tempo'
      ? {
          amount: '10000',
          currency: '0x20c0000000000000000000000000000000000000',
          methodDetails: { chainId: 42431, feePayer: false, supportedModes: ['pull'] },
          recipient: '0x61d64bdb13debd1844defecd45cf737403de9813',
        }
      : {
          amount: '0.10',
          currency: 'USDC',
          methodDetails: { rail: 'balance' },
          ...(subscription ? { periodCount: 1, periodUnit: 'month', subscriptionExpires: '2999-12-31T00:00:00Z' } : {}),
        };
  const challenge: MppChallenge = {
    id: `chal-${method}`,
    realm: 'mpp.test',
    method,
    intent: subscription ? 'subscription' : 'charge',
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

function renderAepView() {
  return render(
    <CombinedInspectView
      url={URL}
      method="GET"
      deps={{
        inspectAep: () =>
          Promise.resolve({
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
          }),
        probeOptions: { method: 'GET', headers: {} },
        url: URL,
      }}
      onComplete={vi.fn()}
    />,
  );
}

function renderOpenApiAepView(authenticated = false) {
  return render(
    <CombinedInspectView
      url={URL}
      method="GET"
      deps={{
        ...(authenticated
          ? {
              authenticatedProbe: () =>
                Promise.resolve({
                  bytes: new Uint8Array(),
                  contentType: undefined,
                  headers: new Headers(),
                  status: 200,
                }),
            }
          : {}),
        inspectAep: () =>
          Promise.resolve({
            commandUrl: (command: string) => new globalThis.URL(`https://seller.test/aep/${command}`),
            document: {
              aep_version: '1.0',
              bindings: { supported: ['http'] },
              commands: { supported: ['inspect', 'status'] },
              core: { signing_algorithms: ['ES256'] },
              http: { endpoint_base: '/aep' },
              identity: { methods: ['did:web'] },
              service: { did: 'did:web:service.test' },
            },
            finalUrl: new globalThis.URL('https://seller.test/.well-known/aep'),
            inspectUrl: new globalThis.URL('https://seller.test/.well-known/aep'),
          }),
        inspectAepPolicy: () =>
          Promise.resolve({
            freshness: 'fresh',
            matchedOperation: { method: 'GET', pathTemplate: '/api' },
            methods: ['aep-jwt'],
            source: 'openapi',
            state: 'required',
          }),
        probeOptions: { method: 'GET', headers: {} },
        url: URL,
      }}
      onComplete={vi.fn()}
    />,
  );
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('CombinedInspectView', () => {
  it('renders definitive OpenAPI AEP policy without waiting for a resource probe', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { lastFrame, unmount } = renderOpenApiAepView();
    await settle();
    const frame = lastFrame() ?? '';
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(frame).toContain('authentication required');
    expect(frame).toContain('Resource path');
    expect(frame).toContain('/api');
    expect(frame).toContain('aep-jwt');
    expect(frame).not.toContain('Policy freshness');
    unmount();
  });

  it('summarizes OpenAPI authentication after an authenticated resource probe', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { lastFrame, unmount } = renderOpenApiAepView(true);
    await settle();
    const frame = lastFrame() ?? '';
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(frame).toContain('Authentication required');
    expect(frame).toContain('AEP OpenAPI, HTTP 200');
    expect(frame).toContain('No live challenge');
    unmount();
  });

  it('renders AEP before MPP and x402 when authentication is required', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('authentication required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'AEP reason="not_recognized"' },
      }),
    );
    const { lastFrame, unmount } = renderAepView();
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('detected:');
    expect(frame).toContain('Service DID');
    expect(frame).toContain('did:web:service.test');
    expect(frame).not.toContain('── MPP ──');
    expect(frame).not.toContain('── x402 ──');
    unmount();
  });

  it('renders supported payment sections and triage columns', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'WWW-Authenticate': mppHeader(), 'PAYMENT-REQUIRED': x402Header() },
      }),
    );
    const { lastFrame, unmount } = renderView();
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('detected:');
    expect(frame).toContain('Capability summary');
    expect(frame).toContain('Catalog unavailable');
    expect(frame).not.toContain('── ODP ──');
    expect(frame).toContain('── MPP ──');
    expect(frame).toContain('── x402 ──');
    // MPP triage columns
    for (const h of ['Method', 'Intent', 'Amount', 'Currency', 'Rail']) expect(frame).toContain(h);
    expect(frame).toContain('USDC');
    // x402 triage columns + the FULL asset string rendered verbatim (no truncation)
    for (const h of ['Scheme', 'Network', 'Asset']) expect(frame).toContain(h);
    expect(frame).toContain('eip155:84532');
    expect(frame).toContain('0xUSDCcontractaddress0000000000000000000000');
    expect(frame).not.toContain('Full detail:');
    unmount();
  });

  it('renders recurring terms in the combined MPP section', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', {
        status: 402,
        headers: { 'WWW-Authenticate': mppHeader('inflow', true) },
      }),
    );
    const { lastFrame, unmount } = renderView();
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('subscription');
    expect(frame).toContain('Subscription option 1');
    expect(frame).toContain('Billing frequency');
    expect(frame).toContain('Every month');
    expect(frame).toContain('Subscription ends');
    expect(frame).toContain('2999-12-31T00:00:00Z');
    unmount();
  });

  it('hides the absent payment detail section (x402-only)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', { status: 402, headers: { 'PAYMENT-REQUIRED': x402Header() } }),
    );
    const { lastFrame, unmount } = renderView();
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('detected:');
    expect(frame).not.toContain('── MPP ──');
    expect(frame).toContain('── x402 ──');
    unmount();
  });

  it('shows Tempo as an MPP challenge', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', { status: 402, headers: { 'WWW-Authenticate': mppHeader('tempo') } }),
    );
    const { lastFrame, unmount } = renderView();
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('detected:');
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
    expect(frame).not.toContain('detected:');
    expect(frame).toContain('not payable by InFlow: other');
    unmount();
  });

  it('hides all absent detail sections on a 402 with neither header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 402 }));
    const { lastFrame, unmount } = renderView();
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('detected:');
    expect(frame).not.toContain('── ODP ──');
    expect(frame).not.toContain('── AEP ──');
    expect(frame).not.toContain('── MPP ──');
    expect(frame).not.toContain('── x402 ──');
    unmount();
  });

  it('renders the no-payment branch on a 2xx probe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const { lastFrame, unmount } = renderView();
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('HTTP requirements');
    expect(frame).toContain('Capability summary');
    expect(frame).toContain('ODP');
    expect(frame).toContain('Service capability');
    expect(frame).toContain('Current request');
    expect(frame).toContain('Payment not required');
    expect(frame).not.toContain('── AEP ──');
    expect(frame).not.toContain('── ODP ──');
    expect(frame).not.toContain('HTTP response');
    expect(frame).not.toContain('Response size');
    expect(frame).not.toContain('Seller accepted without payment');
    unmount();
  });

  it('distinguishes ODP payment support from a public resource', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('hello', { status: 200 }));
    const { lastFrame, unmount } = render(
      <CombinedInspectView
        url={URL}
        method="GET"
        deps={{
          inspectOdp: () => Promise.resolve(odpInspect),
          probeOptions: { method: 'GET', headers: {} },
          url: URL,
        }}
        onComplete={vi.fn()}
      />,
    );
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('MPP');
    expect(frame).toContain('x402');
    expect(frame).toContain('Supported');
    expect(frame).toContain('Payment not required');
    expect(frame).toContain('ODP, HTTP 200');
    expect(frame).toContain('MCP endpoints');
    expect(frame).toContain('https://seller.test/mcp');
    unmount();
  });

  it('renders discovered AEP metadata when OpenAPI cannot classify the resource', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('hello', { status: 200 }));
    const { lastFrame, unmount } = render(
      <CombinedInspectView
        url={URL}
        method="GET"
        deps={{
          inspectAep: () =>
            Promise.resolve({
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
            }),
          inspectAepPolicy: () =>
            Promise.resolve({ freshness: 'fresh', methods: [], source: 'openapi', state: 'fallback' }),
          probeOptions: { method: 'GET', headers: {} },
          url: URL,
        }}
        onComplete={vi.fn()}
      />,
    );
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('available; authentication not required for this URL');
    expect(frame).toContain('AEP, HTTP 200');
    expect(frame).toContain('did:web:service.test');
    unmount();
  });

  it('reports an ODP inspection error without hiding the resource probe result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('hello', { status: 200 }));
    const inspectionFailure = Object.assign(new Error('invalid ODP document'), {
      code: 'validation_failed',
      status: 500,
    });
    const { lastFrame, unmount } = render(
      <CombinedInspectView
        url={URL}
        method="GET"
        deps={{
          inspectOdp: () => Promise.reject(inspectionFailure),
          probeOptions: { method: 'GET', headers: {} },
          url: URL,
        }}
        onComplete={vi.fn()}
      />,
    );
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('inspection failed (validation_failed)');
    expect(frame).toContain('invalid ODP document');
    expect(frame).toContain('Payment not required');
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
