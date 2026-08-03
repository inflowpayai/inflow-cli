import { encode, type MppChallenge, renderChallengeHeader } from '@inflowpayai/mpp';
import { PaymentInspectionBlockedError } from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildBlockedFrame, buildChallengesFrame, InspectView } from '../../../../src/commands/mpp/inspect.js';

const SELLER = 'https://seller.test/api';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function challenge(): MppChallenge {
  return {
    id: 'chal-1',
    realm: 'mpp.test',
    method: 'inflow',
    intent: 'charge',
    request: encode({ amount: '10', currency: 'USDC', methodDetails: { rail: 'balance' } }),
  };
}

describe('InspectView', () => {
  it('renders the challenge table for a 402', async () => {
    server.use(
      http.get(
        SELLER,
        () =>
          new HttpResponse(null, { status: 402, headers: { 'WWW-Authenticate': renderChallengeHeader(challenge()) } }),
      ),
    );
    const { lastFrame, unmount } = render(
      <InspectView
        url={SELLER}
        method="GET"
        deps={{ url: SELLER, probeOptions: { method: 'GET', headers: {} } }}
        onComplete={vi.fn()}
      />,
    );
    await new Promise((r) => setTimeout(r, 80));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('USDC');
    expect(frame).toContain('charge');
    unmount();
  });

  it('renders the no-payment branch on a 2xx probe', async () => {
    server.use(http.get(SELLER, () => new HttpResponse('hi', { status: 200 })));
    const { lastFrame, unmount } = render(
      <InspectView
        url={SELLER}
        method="GET"
        deps={{ url: SELLER, probeOptions: { method: 'GET', headers: {} } }}
        onComplete={vi.fn()}
      />,
    );
    await new Promise((r) => setTimeout(r, 80));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Payment required');
    expect(frame).toContain('Status');
    expect(frame).toContain('Response size');
    expect(frame).toContain('mpp fetch');
    expect(frame).not.toContain('mpp pay');
    unmount();
  });

  it('renders the error branch with the code and message on an unexpected status', async () => {
    server.use(http.get(SELLER, () => new HttpResponse('boom', { status: 500 })));
    const { lastFrame, unmount } = render(
      <InspectView
        url={SELLER}
        method="GET"
        deps={{ url: SELLER, probeOptions: { method: 'GET', headers: {} } }}
        onComplete={vi.fn()}
      />,
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(lastFrame() ?? '').toContain('UNEXPECTED_PROBE_STATUS');
    unmount();
  });

  it('renders an AEP authentication block with Service details', async () => {
    const blocked = {
      method: 'GET',
      url: SELLER,
      source: 'openapi' as const,
      message: 'Authenticate before inspecting payment terms.',
      serviceUrl: 'https://seller.test',
      serviceDid: 'did:web:seller.test',
    };
    const { lastFrame, unmount } = render(
      <InspectView
        url={SELLER}
        method="GET"
        deps={{
          url: SELLER,
          probeOptions: { method: 'GET', headers: {} },
          probe: () => Promise.reject(new PaymentInspectionBlockedError(blocked)),
        }}
        onComplete={vi.fn()}
      />,
    );
    await new Promise((r) => setTimeout(r, 80));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('AEP authentication required');
    expect(frame).toContain('https://seller.test');
    expect(frame).toContain('did:web:seller.test');
    expect(frame).toContain(blocked.message);
    unmount();
  });
});

describe('structured frames', () => {
  it('projects challenge details and omits absent optional fields', () => {
    expect(
      buildChallengesFrame({
        outcome: 'challenges',
        url: SELLER,
        method: 'GET',
        realm: 'mpp.test',
        challenges: [
          {
            id: 'chal-1',
            realm: 'mpp.test',
            method: 'inflow',
            intent: 'charge',
            amount: '10',
            currency: 'USDC',
            recipient: 'seller',
            rail: 'balance',
            instrumentId: 'wallet-1',
            expires: '2999-01-01T00:00:00Z',
            description: 'Widgets',
            digest: 'sha-256=:abc:',
          },
          { id: 'chal-2', realm: 'mpp.test', method: 'inflow', intent: 'charge' },
        ],
      }),
    ).toEqual({
      outcome: 'challenges',
      url: SELLER,
      method: 'GET',
      realm: 'mpp.test',
      challenges: [
        {
          id: 'chal-1',
          realm: 'mpp.test',
          method: 'inflow',
          intent: 'charge',
          amount: '10',
          currency: 'USDC',
          recipient: 'seller',
          rail: 'balance',
          instrument_id: 'wallet-1',
          expires: '2999-01-01T00:00:00Z',
          description: 'Widgets',
          digest: 'sha-256=:abc:',
        },
        { id: 'chal-2', realm: 'mpp.test', method: 'inflow', intent: 'charge' },
      ],
    });
  });

  it('projects an authentication block with and without optional Service details', () => {
    const base = {
      method: 'GET',
      url: SELLER,
      source: 'challenge' as const,
      message: 'Authentication required.',
    };
    expect(buildBlockedFrame(base)).toEqual({
      outcome: 'aep-authentication-required',
      url: SELLER,
      method: 'GET',
      source: 'challenge',
      message: 'Authentication required.',
    });
    expect(
      buildBlockedFrame({ ...base, serviceUrl: 'https://seller.test', serviceDid: 'did:web:seller.test' }),
    ).toMatchObject({ service_url: 'https://seller.test', service_did: 'did:web:seller.test' });
  });
});

describe('buildNoPaymentFrame', () => {
  it('projects the no-payment result fields, including content_type when present', async () => {
    const { buildNoPaymentFrame } = await import('../../../../src/commands/mpp/inspect.js');
    expect(
      buildNoPaymentFrame({
        outcome: 'no-payment-required',
        url: SELLER,
        method: 'GET',
        status: 200,
        contentType: 'text/plain',
        bodySizeBytes: 4,
      }),
    ).toEqual({
      outcome: 'no-payment-required',
      url: SELLER,
      method: 'GET',
      status: 200,
      body_size_bytes: 4,
      content_type: 'text/plain',
    });
  });

  it('omits content_type when undefined', async () => {
    const { buildNoPaymentFrame } = await import('../../../../src/commands/mpp/inspect.js');
    const frame = buildNoPaymentFrame({
      outcome: 'no-payment-required',
      url: SELLER,
      method: 'GET',
      status: 204,
      contentType: undefined,
      bodySizeBytes: 0,
    });
    expect(frame['content_type']).toBeUndefined();
  });
});
