import { HEADERS, type MppClient, type MppTransactionResponse, SCHEME_PAYMENT } from '@inflowpayai/mpp';
import { buildSettlement, type MppPaySettlement } from './mpp-pay.js';
import { runMppStatus } from './mpp-status.js';
import {
  PAYMENT_REPLAY_OUTCOME_UNKNOWN_CODE,
  PAYMENT_REPLAY_OUTCOME_UNKNOWN_MESSAGE,
  replayPaymentRequest,
} from './payment-fetch.js';
import type { SellerProbeOptions } from '@inflowpayai/x402-buyer/probe';

export interface MppFetchSuccess {
  protocol: 'mpp';
  outcome: 'paid';
  transactionId: string;
  url: string;
  method: string;
  responseStatus: number;
  responseContentType: string | undefined;
  bodySizeBytes: number;
  settled?: MppPaySettlement;
  body?: string;
  bodyBase64?: string;
  outputSavedTo?: string;
}

export interface MppFetchRejected {
  protocol: 'mpp';
  outcome: 'seller-rejected';
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

export type MppFetchEvent =
  | { type: 'snapshot'; response: MppTransactionResponse }
  | { type: 'replaying'; response: MppTransactionResponse }
  | { type: 'replayed'; result: MppFetchSuccess }
  | { type: 'rejected'; result: MppFetchRejected }
  | { type: 'errored'; code: string; message: string; retryable?: boolean };

export interface MppFetchInput {
  client: MppClient;
  transactionId: string;
  url: string;
  probeOptions: SellerProbeOptions;
  interval: number;
  maxAttempts: number;
  timeout: number;
  showBody: boolean;
  outputFile?: string;
}

export interface MppFetchRun {
  events: AsyncIterable<MppFetchEvent>;
}

function failedMessage(response: MppTransactionResponse): string {
  return response.problem?.detail ?? response.problem?.title ?? 'MPP transaction failed.';
}

async function resolveReady(input: MppFetchInput): Promise<MppTransactionResponse | { error: MppFetchEvent }> {
  if (input.interval <= 0) {
    const snapshot = await input.client.getTransaction(input.transactionId);
    if (snapshot.state === 'ready') return snapshot;
    if (snapshot.state === 'failed') {
      return { error: { type: 'errored', code: 'PAYMENT_FAILED', message: failedMessage(snapshot) } };
    }
    if (snapshot.state === 'expired') {
      return {
        error: { type: 'errored', code: 'PAYMENT_EXPIRED', message: 'MPP transaction expired before it was ready.' },
      };
    }
    return {
      error: {
        type: 'errored',
        code: 'PAYMENT_NOT_READY',
        message: 'MPP transaction is still pending. Re-run fetch with --interval to wait for approval.',
        retryable: true,
      },
    };
  }

  const run = runMppStatus({
    fetchOnce: () => input.client.getTransaction(input.transactionId),
    interval: input.interval,
    maxAttempts: input.maxAttempts,
    timeout: input.timeout,
  });
  for await (const event of run.events) {
    if (event.type === 'ready') return event.response;
    if (event.type === 'failed') {
      return { error: { type: 'errored', code: 'PAYMENT_FAILED', message: failedMessage(event.response) } };
    }
    if (event.type === 'expired') {
      return {
        error: { type: 'errored', code: 'PAYMENT_EXPIRED', message: 'MPP transaction expired before it was ready.' },
      };
    }
    if (event.type === 'timedOut') {
      return {
        error: {
          type: 'errored',
          code: 'POLLING_TIMEOUT',
          message: 'Polling timed out before the transaction reached a ready state.',
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
      message: 'MPP transaction did not reach a ready state.',
      retryable: true,
    },
  };
}

export function runMppFetch(input: MppFetchInput): MppFetchRun {
  async function* generate(): AsyncGenerator<MppFetchEvent> {
    let ready: MppTransactionResponse | { error: MppFetchEvent };
    try {
      ready = await resolveReady(input);
    } catch (err) {
      yield { type: 'errored', code: 'PAYMENT_FAILED', message: err instanceof Error ? err.message : String(err) };
      return;
    }

    if ('error' in ready) {
      yield ready.error;
      return;
    }
    if (ready.credential === undefined || ready.credential.length === 0) {
      yield {
        type: 'errored',
        code: 'PAYMENT_CREDENTIAL_MISSING',
        message: 'MPP transaction is ready but did not include a payment credential.',
      };
      return;
    }

    yield { type: 'replaying', response: ready };
    let replay;
    try {
      replay = await replayPaymentRequest({
        url: input.url,
        method: input.probeOptions.method,
        headers: input.probeOptions.headers,
        ...(input.probeOptions.data !== undefined ? { data: input.probeOptions.data } : {}),
        paymentHeaderName: HEADERS.AUTHORIZATION,
        paymentHeaderValue: `${SCHEME_PAYMENT} ${ready.credential}`,
        showBody: input.showBody,
        ...(input.outputFile !== undefined ? { outputFile: input.outputFile } : {}),
      });
    } catch {
      yield {
        type: 'errored',
        code: PAYMENT_REPLAY_OUTCOME_UNKNOWN_CODE,
        message: PAYMENT_REPLAY_OUTCOME_UNKNOWN_MESSAGE,
      };
      return;
    }

    const base = {
      protocol: 'mpp' as const,
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
      yield { type: 'rejected', result: { ...base, outcome: 'seller-rejected' } };
      return;
    }
    const settled = buildSettlement(replay.headers);
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
