import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { encode, renderChallengeHeader } from '@inflowpayai/mpp';
import { callOpenApiOperation } from '../../src/openapi/call.js';
import { operationPayment } from '../../src/openapi/payments.js';
import { readOpenApi } from '../../src/openapi/reader.js';
import { PublicSourceDocuments } from '../../src/openapi/documents.js';
import type { PublicSourceCache } from '../../src/openapi/cache.js';

const cache: PublicSourceCache = { get: () => undefined, set: () => undefined, delete: () => undefined };
async function document(raw: Record<string, unknown> = {}) {
  return readOpenApi(
    {
      sourceUrl: 'https://example.com/openapi.json',
      finalUrl: 'https://example.com/openapi.json',
      headers: {},
      cacheable: false,
      expiresAt: 0,
      status: 200,
      value: {
        openapi: '3.1.0',
        info: { title: 'Example' },
        components: { securitySchemes: { key: { type: 'apiKey', in: 'query', name: 'key' } } },
        paths: {
          '/search': {
            post: { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, ...raw },
          },
        },
      },
    },
    new PublicSourceDocuments(cache),
    {},
  );
}
const input = { method: 'POST', path: '/search', data: '{"query":"weather"}' };

describe('operation payment declarations', () => {
  it.each([
    [{ offers: [{ method: 'tempo', intent: 'charge', amount: '100' }] }, ['mpp']],
    [{ method: 'tempo', intent: 'session', amount: null }, ['mpp']],
    [{ protocols: ['x402', 'mpp', 'x402'] }, ['x402', 'mpp']],
    [{ protocols: [{ x402: {} }, { mpp: { method: 'tempo' } }] }, ['x402', 'mpp']],
    [{ protocols: ['future', null, { x402: false }] }, []],
    [{ offers: [null, {}, { method: 'tempo', intent: 'charge', amount: '1.5' }] }, []],
    [{}, []],
    [null, []],
  ])('recognizes only documented structures: %j', (info, protocols) => {
    const original = structuredClone(info);
    const payment = operationPayment({ 'x-payment-info': info, responses: { '402': {} } });
    expect(payment).toMatchObject({ advertised: true, protocols, response402: true });
    expect(info).toEqual(original);
  });
  it('does not treat 402 alone, security definitions or prices as a paid requirement', () => {
    expect(operationPayment({ responses: { '402': {} }, price: 1, securitySchemes: { payment: {} } })).toMatchObject({
      advertised: false,
      protocols: [],
      response402: true,
    });
    expect(operationPayment({})).toEqual({
      advertised: false,
      protocols: [],
      response402: false,
      offers: [],
      notes: [],
    });
    expect(operationPayment({ 'x-payment-required': true })).toMatchObject({
      advertised: true,
      protocols: [],
    });
    expect(operationPayment({ 'x-payment-required': true }).notes).toContain(
      'Payment is advertised, but its protocol is not recognized.',
    );
  });
  it('copies offers and recognizes zero without treating it as free', () => {
    const raw = { offers: [{ method: 'tempo', intent: 'charge', amount: '0' }] };
    const payment = operationPayment({ 'x-payment-info': raw });
    expect(payment).toMatchObject({ advertised: true, protocols: ['mpp'] });
    const first = raw.offers[0];
    if (first !== undefined) first.method = 'changed';
    expect(payment.offers[0]?.['method']).toBe('tempo');
  });
});

describe('OpenAPI operation calls', () => {
  it('routes paid operations without invoking them and preserves POST inputs without leaking credentials', async () => {
    const doc = await document({ 'x-payment-info': { protocols: ['mpp', 'x402'] }, responses: { '402': {} } });
    const fetch = vi.fn();
    const result = await callOpenApiOperation(
      doc,
      { ...input, headers: { Authorization: 'Bearer secret' }, parameters: { query: { key: 'private' } } },
      fetch,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      sent: false,
      outcome: 'payment-required',
      next: [
        {
          command: ['mpp', 'pay'],
          options: { method: 'POST', data: input.data },
          requiredInputs: [
            { location: 'header', name: 'authorization' },
            { location: 'query', name: 'key' },
          ],
        },
        { command: ['x402', 'pay'] },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private/);
  });
  it('sends one request with caller credentials and receives a normal response', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ answer: 42 }));
    const result = await callOpenApiOperation(
      await document(),
      { ...input, headers: { Authorization: 'Bearer secret' } },
      fetch,
    );
    expect(result).toMatchObject({ sent: true, outcome: 'response', status: 200, body: '{"answer":42}', next: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: input.data,
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      redirect: 'manual',
      credentials: 'omit',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it.each([302, 400, 401, 403, 500])('preserves HTTP %s without following redirects or retrying', async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('failure', { status, headers: { location: 'https://other.example' } }));
    expect(await callOpenApiOperation(await document(), input, fetch)).toMatchObject({
      status,
      outcome: 'http-error',
      body: 'failure',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports unadvertised payment from the runtime x402 challenge', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response('pay', {
        status: 402,
        headers: {
          'payment-required': Buffer.from(
            JSON.stringify({
              x402Version: 2,
              accepts: [
                {
                  scheme: 'exact',
                  network: 'eip155:8453',
                  amount: '10',
                  asset: 'usdc',
                  payTo: 'seller',
                  maxTimeoutSeconds: 60,
                },
              ],
              resource: { url: 'https://example.com/search' },
            }),
          ).toString('base64'),
        },
      }),
    );
    expect(await callOpenApiOperation(await document({ responses: { '402': {} } }), input, fetch)).toMatchObject({
      sent: true,
      status: 402,
      outcome: 'payment-required',
      payment: { protocols: ['x402'] },
      next: [{ command: ['x402', 'pay'], options: { data: input.data, method: 'POST' } }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('recognizes a real MPP challenge rendered by the SDK', async () => {
    const value = renderChallengeHeader({
      id: 'challenge',
      realm: 'example.com',
      method: 'inflow',
      intent: 'charge',
      request: encode({ amount: '10', currency: 'USDC' }),
    });
    const result = await callOpenApiOperation(await document(), { method: 'POST', path: '/search' }, () =>
      Promise.resolve(new Response(null, { status: 402, headers: { 'www-authenticate': value } })),
    );
    expect(result).toMatchObject({ payment: { protocols: ['mpp'] }, next: [{ command: ['mpp', 'pay'] }] });
    expect(result.next[0]?.options).not.toHaveProperty('data');
  });
  it.each([
    {},
    { 'payment-required': 'garbage', 'www-authenticate': 'Payment garbage' },
    {
      'payment-required': Buffer.from(JSON.stringify({ x402Version: 2, accepts: [] })).toString('base64'),
      'www-authenticate': 'Bearer realm="api"',
    },
  ])('does not invent a payment protocol from unrecognized 402 headers: %j', async (headers) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 402, headers }));
    expect(await callOpenApiOperation(await document(), input, fetch)).toMatchObject({
      outcome: 'payment-required',
      payment: { protocols: [] },
      next: [],
    });
  });
  it('hands AEP authentication to the existing explicit fetch command without enrollment or replay', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 401,
        headers: {
          'www-authenticate': 'AEP service_did="did:web:example.com", inspect="https://example.com/.well-known/aep"',
        },
      }),
    );
    expect(await callOpenApiOperation(await document(), input, fetch)).toMatchObject({
      outcome: 'authentication-required',
      next: [{ command: ['aep', 'fetch'], options: { method: 'POST', data: input.data } }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('supports empty, suppressed and binary response bodies', async () => {
    const doc = await document();
    expect(
      await callOpenApiOperation(doc, input, () => Promise.resolve(new Response(null, { status: 204 }))),
    ).toMatchObject({
      status: 204,
      response_size_bytes: 0,
    });
    const result = await callOpenApiOperation(doc, { ...input, showBody: false }, () =>
      Promise.resolve(new Response('answer')),
    );
    expect(result).not.toHaveProperty('body');
    expect(
      await callOpenApiOperation(doc, input, () => Promise.resolve(new Response(new Uint8Array([0, 255, 1])))),
    ).toMatchObject({ body_base64: 'AP8B' });
  });
  it('saves response files and reports write failures without resending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openapi-call-'));
    try {
      const outputFile = join(dir, 'answer');
      const doc = await document();
      expect(
        await callOpenApiOperation(doc, { ...input, outputFile }, () => Promise.resolve(new Response('answer'))),
      ).toMatchObject({ output_saved_to: outputFile });
      expect(await readFile(outputFile, 'utf8')).toBe('answer');
      const fetch = vi.fn().mockResolvedValue(new Response('answer'));
      await expect(callOpenApiOperation(doc, { ...input, outputFile: dir }, fetch)).rejects.toMatchObject({
        code: 'OPENAPI_OUTPUT_WRITE_FAILED',
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each([
    { timeout: 0 },
    { timeout: Infinity },
    { timeout: 901 },
    { maxResponseBytes: -1 },
    { maxResponseBytes: 0.5 },
  ])('rejects invalid limits before sending: %j', async (limits) => {
    const fetch = vi.fn();
    await expect(callOpenApiOperation(await document(), { ...input, ...limits }, fetch)).rejects.toMatchObject({
      code: 'OPENAPI_CALL_INPUT_INVALID',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not send already cancelled requests', async () => {
    const fetch = vi.fn();
    await expect(
      callOpenApiOperation(await document(), { ...input, signal: AbortSignal.abort() }, fetch),
    ).rejects.toMatchObject({ code: 'OPENAPI_CALL_CANCELLED' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cancels oversized streaming responses and makes no retry', async () => {
    const cancel = vi.fn();
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
          cancel,
        }),
      ),
    );
    await expect(
      callOpenApiOperation(await document(), { ...input, maxResponseBytes: 2 }, fetch),
    ).rejects.toMatchObject({ code: 'OPENAPI_RESPONSE_TOO_LARGE' });
    expect(cancel).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('treats transport and response-stream failure as ambiguous, without exposing errors or retrying', async () => {
    const doc = await document();
    for (const fetch of [
      vi.fn().mockRejectedValue(new Error('secret')),
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('secret'));
            },
          }),
        ),
      ),
    ]) {
      await expect(callOpenApiOperation(doc, input, fetch)).rejects.toMatchObject({
        code: 'OPENAPI_CALL_OUTCOME_UNKNOWN',
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
});
