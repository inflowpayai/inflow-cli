import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { HEADERS, type PaymentRequirements } from '@inflowpayai/x402';
import { type PreparedPayment, X402ApprovalCancelledError, X402ApprovalTimeoutError } from '@inflowpayai/x402-buyer';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildBodyAttachment,
  buildSettledMeta,
  type PayEvent,
  type PayPipelineDeps,
  type PayResultReplayRejected,
  type PayResultSuccess,
  reducePay,
  runPayPipeline,
} from '../../../src/flows/x402-pay.js';

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
    error: 'payment required',
  } as unknown as PaymentRequired;
}

interface SellerOptions {
  paidStatus?: number;
  paidBody?: string;
  paidHeaders?: Record<string, string>;
  requiredHeader?: string;
}

/**
 * Mock fetch as an x402 seller: every request without a PAYMENT-SIGNATURE header gets a 402 carrying the
 * PAYMENT-REQUIRED header; the replay (signature present) gets the paid response.
 */
function mockSeller(options: SellerOptions = {}) {
  const required = options.requiredHeader ?? encodePaymentRequiredHeader(paymentRequired());
  return vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    const headers = new Headers(init?.headers);
    if (headers.get(HEADERS.PAYMENT_SIGNATURE) !== null) {
      return Promise.resolve(
        new Response(options.paidBody ?? 'PAID-BODY', {
          status: options.paidStatus ?? 200,
          headers: { 'content-type': 'text/plain', ...(options.paidHeaders ?? {}) },
        }),
      );
    }
    return Promise.resolve(
      new Response('payment required', {
        status: 402,
        headers: { [HEADERS.PAYMENT_REQUIRED]: required },
      }),
    );
  });
}

function preparedPayment(payload = 'ENC-PAYLOAD'): PreparedPayment {
  return {
    transactionId: 'tx-1',
    approvalId: 'appr_1',
    awaitPayload: vi.fn(() => Promise.resolve({ encodedPayload: payload })),
  } as unknown as PreparedPayment;
}

function payingClient(overrides: Record<string, unknown> = {}): unknown {
  return {
    selectInflowRequirement: vi.fn((filtered: PaymentRequired) => Promise.resolve(filtered.accepts[0] ?? null)),
    prepareInflowPayment: vi.fn(() => Promise.resolve(preparedPayment())),
    getX402Payload: vi.fn(),
    cancelApproval: vi.fn(),
    getSupported: vi.fn(),
    ...overrides,
  };
}

function deps(overrides: Partial<PayPipelineDeps> = {}): PayPipelineDeps {
  return {
    client: payingClient() as never,
    apiBaseUrl: 'https://api.test',
    probeOptions: { method: 'GET', headers: {} },
    url: SELLER,
    signOptions: {},
    showBody: true,
    ...overrides,
  };
}

async function collect(d: PayPipelineDeps): Promise<PayEvent[]> {
  const events: PayEvent[] = [];
  await runPayPipeline(d, (e) => events.push(e));
  return events;
}

describe('runPayPipeline — full lifecycle', () => {
  it('drives decoded → matched → prepared → awaited → replayed and settles with the seller body', async () => {
    const fetchSpy = mockSeller({
      paidHeaders: {
        [HEADERS.PAYMENT_RESPONSE]: encodePaymentResponseHeader({
          success: true,
          network: 'eip155:84532',
          transaction: '0xtx99',
        } as never),
      },
    });
    const events = await collect(deps());
    expect(events.map((e) => e.type)).toEqual(['decoded', 'matched', 'prepared', 'awaited', 'replayed']);

    const decoded = events[0];
    if (decoded?.type === 'decoded') {
      expect(decoded.decoded.extensions).toEqual({ foo: 'bar' });
      expect(decoded.decoded.error).toBe('payment required');
      expect(decoded.decoded.accepts).toHaveLength(2);
    }

    const prepared = events[2];
    if (prepared?.type === 'prepared') {
      expect(prepared.approvalUrl).toBe('https://api.test/approvals/appr_1/view/');
      expect(prepared.requirement.scheme).toBe('balance');
    }

    const terminal = events.at(-1);
    expect(terminal?.type).toBe('replayed');
    if (terminal?.type === 'replayed') {
      expect(terminal.result.outcome).toBe('paid');
      expect(terminal.result.transactionId).toBe('tx-1');
      expect(terminal.result.approvalId).toBe('appr_1');
      expect(terminal.result.approvalUrl).toBe('https://api.test/approvals/appr_1/view/');
      expect(terminal.result.scheme).toBe('balance');
      expect(terminal.result.network).toBe('inflow:1');
      expect(terminal.result.encodedPayload).toBe('ENC-PAYLOAD');
      expect(terminal.result.responseStatus).toBe(200);
      expect(terminal.result.body).toBe('PAID-BODY');
      expect(terminal.result.settled).toEqual({ network: 'eip155:84532', transaction: '0xtx99' });
    }

    const replayInit = fetchSpy.mock.calls.at(-1)?.[1];
    expect(new Headers(replayInit?.headers).get(HEADERS.PAYMENT_SIGNATURE)).toBe('ENC-PAYLOAD');
  });

  it('passes the decoded signing context (resource + version + extensions) to prepareInflowPayment', async () => {
    mockSeller();
    const client = payingClient() as {
      prepareInflowPayment: ReturnType<typeof vi.fn>;
    };
    await collect(deps({ client: client as never }));
    expect(client.prepareInflowPayment).toHaveBeenCalledTimes(1);
    const [, signingContext, signOptions] = client.prepareInflowPayment.mock.calls[0] as [
      unknown,
      { resource: { url: string }; x402Version: number; extensions?: Record<string, unknown> },
      unknown,
    ];
    expect(signingContext.resource.url).toBe(SELLER);
    expect(signingContext.x402Version).toBe(2);
    expect(signingContext.extensions).toEqual({ foo: 'bar' });
    expect(signOptions).toEqual({});
  });

  it('emits rejected when the seller answers the replay with a non-2xx status', async () => {
    mockSeller({ paidStatus: 402, paidBody: 'still want money' });
    const events = await collect(deps());
    expect(events.map((e) => e.type)).toEqual(['decoded', 'matched', 'prepared', 'awaited', 'rejected']);
    const terminal = events.at(-1);
    if (terminal?.type === 'rejected') {
      expect(terminal.result.outcome).toBe('replay-rejected');
      expect(terminal.result.responseStatus).toBe(402);
      expect(terminal.result.transactionId).toBe('tx-1');
      expect(terminal.result.body).toBe('still want money');
      expect(terminal.result).not.toHaveProperty('encodedPayload');
    }
  });

  it('stops after prepared (no awaitPayload, no replay) when awaitPayment is false', async () => {
    const fetchSpy = mockSeller();
    const prepared = preparedPayment();
    const client = payingClient({ prepareInflowPayment: vi.fn(() => Promise.resolve(prepared)) });
    const events = await collect(deps({ client: client as never, awaitPayment: false }));
    expect(events.map((e) => e.type)).toEqual(['decoded', 'matched', 'prepared']);
    expect((prepared as unknown as { awaitPayload: ReturnType<typeof vi.fn> }).awaitPayload).not.toHaveBeenCalled();
    // only the probe hit the network — no replay
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('narrows accepts with --scheme so the second entry is matched', async () => {
    mockSeller();
    const events = await collect(deps({ schemeFilter: 'exact' }));
    const matched = events.find((e) => e.type === 'matched');
    expect(matched).toBeDefined();
    if (matched?.type === 'matched') {
      expect(matched.requirement.scheme).toBe('exact');
      expect(matched.requirement.network).toBe('eip155:84532');
    }
    expect(events.at(-1)?.type).toBe('replayed');
  });

  it('applies network + asset + asset-name filters together', async () => {
    mockSeller();
    const events = await collect(
      deps({ networkFilter: 'eip155:84532', assetFilter: '0xabc', assetNameFilter: 'USDT' }),
    );
    const matched = events.find((e) => e.type === 'matched');
    if (matched?.type === 'matched') {
      expect(matched.requirement.scheme).toBe('exact');
    }
    expect(events.at(-1)?.type).toBe('replayed');
  });

  it('errors NO_FILTERED_MATCH listing the available pairs when filters match nothing', async () => {
    mockSeller();
    const events = await collect(deps({ assetNameFilter: 'EUR' }));
    expect(events.map((e) => e.type)).toEqual(['decoded', 'errored']);
    const terminal = events.at(-1);
    if (terminal?.type === 'errored') {
      expect(terminal.code).toBe('NO_FILTERED_MATCH');
      expect(terminal.message).toContain('--asset-name=EUR');
      expect(terminal.message).toContain('balance/inflow:1');
      expect(terminal.message).toContain('assetName=USDT');
    }
  });

  it('errors NO_INFLOW_MATCH when the client cannot sign any accepts entry', async () => {
    mockSeller();
    const client = payingClient({ selectInflowRequirement: vi.fn(() => Promise.resolve(null)) });
    const events = await collect(deps({ client: client as never }));
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({ type: 'errored', code: 'NO_INFLOW_MATCH' });
  });

  it('errors DECODE_FAILED when the PAYMENT-REQUIRED header is malformed', async () => {
    mockSeller({ requiredHeader: '%%%not-a-header%%%' });
    const events = await collect(deps());
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('errored');
    if (terminal?.type === 'errored') {
      expect(terminal.code).toBe('DECODE_FAILED');
    }
  });

  it('maps a prepare-time SDK error (approval cancelled) into its canonical code', async () => {
    mockSeller();
    const client = payingClient({
      prepareInflowPayment: vi.fn(() => Promise.reject(new X402ApprovalCancelledError('appr_1'))),
    });
    const events = await collect(deps({ client: client as never }));
    expect(events.map((e) => e.type)).toEqual(['decoded', 'matched', 'errored']);
    expect(events.at(-1)).toMatchObject({ type: 'errored', code: 'APPROVAL_CANCELLED' });
  });

  it('maps an awaitPayload timeout into APPROVAL_TIMEOUT after prepared', async () => {
    mockSeller();
    const prepared = {
      transactionId: 'tx-1',
      approvalId: 'appr_1',
      awaitPayload: vi.fn(() => Promise.reject(new X402ApprovalTimeoutError('appr_1', 1000))),
    } as unknown as PreparedPayment;
    const client = payingClient({ prepareInflowPayment: vi.fn(() => Promise.resolve(prepared)) });
    const events = await collect(deps({ client: client as never }));
    expect(events.map((e) => e.type)).toEqual(['decoded', 'matched', 'prepared', 'errored']);
    expect(events.at(-1)).toMatchObject({ type: 'errored', code: 'APPROVAL_TIMEOUT' });
  });

  it('collapses a probe-time network failure into the generic PAYMENT_FAILED frame', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const events = await collect(deps());
    expect(events).toEqual([{ type: 'errored', code: 'PAYMENT_FAILED', message: 'network down' }]);
  });
});

describe('buildSettledMeta', () => {
  it('returns undefined when the PAYMENT-RESPONSE header is absent', () => {
    expect(buildSettledMeta(new Headers())).toBeUndefined();
  });

  it('returns undefined when the header is not decodable', () => {
    expect(buildSettledMeta(new Headers({ [HEADERS.PAYMENT_RESPONSE]: '%%%' }))).toBeUndefined();
  });

  it('returns undefined when the decoded response carries neither network nor transaction', () => {
    const header = encodePaymentResponseHeader({ success: true } as never);
    expect(buildSettledMeta(new Headers({ [HEADERS.PAYMENT_RESPONSE]: header }))).toBeUndefined();
  });

  it('projects network + transaction from a settled response header', () => {
    const header = encodePaymentResponseHeader({
      success: true,
      network: 'eip155:84532',
      transaction: '0xtx42',
    } as never);
    expect(buildSettledMeta(new Headers({ [HEADERS.PAYMENT_RESPONSE]: header }))).toEqual({
      network: 'eip155:84532',
      transaction: '0xtx42',
    });
  });
});

describe('buildBodyAttachment — outputFile', () => {
  it('writes the bytes to the file and reports the absolute path instead of an inline body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'x402-pay-test-'));
    const target = join(dir, 'out.bin');
    try {
      const out = await buildBodyAttachment(new TextEncoder().encode('saved!'), true, target);
      expect(out.outputSavedTo).toBe(resolvePath(target));
      expect(out.body).toBeUndefined();
      expect(out.bodyBase64).toBeUndefined();
      expect(out.bodySizeBytes).toBe(6);
      await expect(readFile(target, 'utf8')).resolves.toBe('saved!');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('reducePay — remaining transitions', () => {
  const requirement = { scheme: 'balance', network: 'inflow:1' } as unknown as PaymentRequirements;
  const decoded = {
    x402Version: 2,
    resource: { url: SELLER, method: 'GET' },
    accepts: [],
  };
  const probe = {
    status: 200,
    headers: new Headers(),
    bytes: new Uint8Array(),
    contentType: undefined,
  };

  it('probed → no-payment', () => {
    expect(reducePay({ kind: 'probing' }, { type: 'probed', probe })).toEqual({ kind: 'no-payment', probe });
  });

  it('decoded → matching', () => {
    expect(reducePay({ kind: 'probing' }, { type: 'decoded', decoded })).toEqual({ kind: 'matching', decoded });
  });

  it('matched → preparing', () => {
    expect(reducePay({ kind: 'probing' }, { type: 'matched', decoded, requirement })).toEqual({
      kind: 'preparing',
      decoded,
      requirement,
    });
  });

  it('prepared → awaiting-approval', () => {
    const prepared = preparedPayment();
    expect(
      reducePay({ kind: 'probing' }, { type: 'prepared', decoded, requirement, prepared, approvalUrl: 'https://a/' }),
    ).toEqual({ kind: 'awaiting-approval', decoded, requirement, prepared, approvalUrl: 'https://a/' });
  });

  it('awaited → replaying', () => {
    const encoded = { encodedPayload: 'ENC' } as never;
    expect(
      reducePay(
        { kind: 'probing' },
        { type: 'awaited', encoded, approvalUrl: 'https://a/', scheme: 'balance', network: 'inflow:1' },
      ),
    ).toEqual({ kind: 'replaying', encoded, approvalUrl: 'https://a/', scheme: 'balance', network: 'inflow:1' });
  });

  it('replayed → success', () => {
    const result = { outcome: 'paid' } as unknown as PayResultSuccess;
    expect(reducePay({ kind: 'probing' }, { type: 'replayed', result })).toEqual({ kind: 'success', result });
  });

  it('rejected → replay-rejected', () => {
    const result = { outcome: 'replay-rejected' } as unknown as PayResultReplayRejected;
    expect(reducePay({ kind: 'probing' }, { type: 'rejected', result })).toEqual({
      kind: 'replay-rejected',
      result,
    });
  });

  it('returns the prior state for an unrecognised event (default branch)', () => {
    const prior = { kind: 'probing' } as const;
    expect(reducePay(prior, { type: 'bogus' } as never)).toBe(prior);
  });
});
