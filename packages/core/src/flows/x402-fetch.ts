import { HEADERS } from '@inflowpayai/x402';
import type { InflowClient as X402InflowClient, X402PayloadResponse } from '@inflowpayai/x402-buyer';
import type { SellerProbeOptions } from '@inflowpayai/x402-buyer/probe';
import { buildSettledMeta, type PaySettledMeta } from './x402-pay.js';
import { classifyPayloadResponse, runX402Status } from './x402-status.js';
import {
  PAYMENT_REPLAY_OUTCOME_UNKNOWN_CODE,
  PAYMENT_REPLAY_OUTCOME_UNKNOWN_MESSAGE,
  replayPaymentRequest,
  SellerAuthenticationError,
  type SellerRequestTransport,
} from './payment-fetch.js';

export interface X402FetchSuccess {
  protocol: 'x402';
  outcome: 'paid';
  transactionId: string;
  url: string;
  method: string;
  responseStatus: number;
  responseContentType: string | undefined;
  bodySizeBytes: number;
  settled?: PaySettledMeta;
  body?: string;
  bodyBase64?: string;
  outputSavedTo?: string;
}

export interface X402FetchRejected {
  protocol: 'x402';
  outcome: 'replay-rejected';
  transactionId: string;
  url: string;
  method: string;
  responseStatus: number;
  responseContentType: string | undefined;
  bodySizeBytes: number;
  body?: string;
  bodyBase64?: string;
  outputSavedTo?: string;
}

export type X402FetchEvent =
  | { type: 'snapshot'; response: X402PayloadResponse }
  | { type: 'replaying'; response: X402PayloadResponse }
  | { type: 'replayed'; result: X402FetchSuccess }
  | { type: 'rejected'; result: X402FetchRejected }
  | { type: 'errored'; code: string; message: string; retryable?: boolean };

export interface X402FetchInput {
  client: X402InflowClient;
  transactionId: string;
  url: string;
  probeOptions: SellerProbeOptions;
  interval: number;
  maxAttempts: number;
  timeout: number;
  showBody: boolean;
  outputFile?: string;
  sellerTransport?: SellerRequestTransport;
  signal?: AbortSignal;
}

export interface X402FetchRun {
  events: AsyncIterable<X402FetchEvent>;
}

function terminalError(response: X402PayloadResponse, transactionId: string): X402FetchEvent {
  if (response.status === 'EXPIRED') {
    return {
      type: 'errored',
      code: 'APPROVAL_TIMEOUT',
      message: `Transaction ${transactionId} expired before a signed payload was available.`,
    };
  }
  if (response.status === 'DECLINED' || response.status === 'CANCELLED') {
    return {
      type: 'errored',
      code: 'APPROVAL_CANCELLED',
      message: `Transaction ${transactionId} terminated as ${response.status} with no payload.`,
    };
  }
  return {
    type: 'errored',
    code: 'APPROVAL_FAILED',
    message: `Transaction ${transactionId} terminated as ${response.status} with no payload.`,
  };
}

async function resolveSigned(input: X402FetchInput): Promise<X402PayloadResponse | { error: X402FetchEvent }> {
  if (input.interval <= 0) {
    const snapshot = await input.client.getX402Payload(input.transactionId);
    const classified = classifyPayloadResponse(snapshot);
    if (classified === 'signed') return snapshot;
    if (classified === 'failed') return { error: terminalError(snapshot, input.transactionId) };
    return {
      error: {
        type: 'errored',
        code: 'PAYMENT_NOT_READY',
        message: 'x402 transaction is still pending. Re-run fetch with --interval to wait for approval.',
        retryable: true,
      },
    };
  }

  const run = runX402Status({
    fetchOnce: () => input.client.getX402Payload(input.transactionId),
    interval: input.interval,
    maxAttempts: input.maxAttempts,
    timeout: input.timeout,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  for await (const event of run.events) {
    if (event.type === 'settled') return event.response;
    if (event.type === 'failed') return { error: terminalError(event.response, input.transactionId) };
    if (event.type === 'timedOut') {
      return {
        error: {
          type: 'errored',
          code: 'POLLING_TIMEOUT',
          message: 'Polling timed out before the transaction reached a signed state.',
          retryable: true,
        },
      };
    }
    if (event.type === 'crashed') {
      return { error: { type: 'errored', code: 'PAYMENT_FAILED', message: event.message } };
    }
  }

  return {
    error: {
      type: 'errored',
      code: 'PAYMENT_NOT_READY',
      message: 'x402 transaction did not reach a signed state.',
      retryable: true,
    },
  };
}

export function runX402Fetch(input: X402FetchInput): X402FetchRun {
  async function* generate(): AsyncGenerator<X402FetchEvent> {
    let signed: X402PayloadResponse | { error: X402FetchEvent };
    try {
      signed = await resolveSigned(input);
    } catch (err) {
      yield { type: 'errored', code: 'PAYMENT_FAILED', message: err instanceof Error ? err.message : String(err) };
      return;
    }

    if ('error' in signed) {
      yield signed.error;
      return;
    }
    if (signed.encodedPayload === undefined || signed.encodedPayload.length === 0) {
      yield {
        type: 'errored',
        code: 'PAYMENT_CREDENTIAL_MISSING',
        message: 'x402 transaction is signed but did not include an encoded payload.',
      };
      return;
    }

    yield { type: 'replaying', response: signed };
    let replay;
    try {
      replay = await replayPaymentRequest({
        url: input.url,
        method: input.probeOptions.method,
        headers: input.probeOptions.headers,
        ...(input.probeOptions.data !== undefined ? { data: input.probeOptions.data } : {}),
        paymentHeaderName: HEADERS.PAYMENT_SIGNATURE,
        paymentHeaderValue: signed.encodedPayload,
        showBody: input.showBody,
        ...(input.outputFile !== undefined ? { outputFile: input.outputFile } : {}),
        ...(input.sellerTransport !== undefined ? { sellerTransport: input.sellerTransport } : {}),
      });
    } catch (err) {
      if (err instanceof SellerAuthenticationError) {
        yield {
          type: 'errored',
          code: err.code,
          message: err.message,
          ...(err.retryable !== undefined ? { retryable: err.retryable } : {}),
        };
        return;
      }
      yield {
        type: 'errored',
        code: PAYMENT_REPLAY_OUTCOME_UNKNOWN_CODE,
        message: PAYMENT_REPLAY_OUTCOME_UNKNOWN_MESSAGE,
      };
      return;
    }

    const base = {
      protocol: 'x402' as const,
      transactionId: input.transactionId,
      url: input.url,
      method: input.probeOptions.method,
      responseStatus: replay.status,
      responseContentType: replay.contentType,
      bodySizeBytes: replay.bodySizeBytes,
      ...(replay.body !== undefined ? { body: replay.body } : {}),
      ...(replay.bodyBase64 !== undefined ? { bodyBase64: replay.bodyBase64 } : {}),
      ...(replay.outputSavedTo !== undefined ? { outputSavedTo: replay.outputSavedTo } : {}),
    };
    if (!replay.success) {
      yield { type: 'rejected', result: { ...base, outcome: 'replay-rejected' } };
      return;
    }
    const settled = buildSettledMeta(replay.headers);
    yield {
      type: 'replayed',
      result: {
        ...base,
        outcome: 'paid',
        ...(settled !== undefined ? { settled } : {}),
      },
    };
  }

  return { events: generate() };
}
