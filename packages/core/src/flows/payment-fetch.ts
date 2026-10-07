import { sellerProbe, type SellerProbeOptions, type SellerProbeResult } from '@inflowpayai/x402-buyer/probe';
import { buildBodyAttachment, type BodyAttachment } from './x402-pay.js';
import { isSuccessStatus } from './x402-shared.js';
import type { PaymentStatusResponse } from '@inflowpayai/mpp';
import { pollAsync } from '../utils/async-poll.js';
import { dashboardHostFor } from '../x402/dashboard-url.js';

export const PAYMENT_REPLAY_OUTCOME_UNKNOWN_CODE = 'PAYMENT_REPLAY_OUTCOME_UNKNOWN';
export const PAYMENT_REPLAY_OUTCOME_UNKNOWN_MESSAGE =
  'The seller request failed after the payment credential was attached. The seller might have received or consumed the credential; do not automatically replay this request.';

export class PaymentReplayOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(PAYMENT_REPLAY_OUTCOME_UNKNOWN_MESSAGE, { cause });
    this.name = 'PaymentReplayOutcomeUnknownError';
  }
}

export class SellerAuthenticationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = 'SellerAuthenticationError';
  }
}

export interface PaymentInspectionBlocked {
  method: string;
  url: string;
  message: string;
  source: 'openapi' | 'challenge';
  serviceDid?: string;
  serviceUrl?: string;
}

export class PaymentInspectionBlockedError extends Error {
  constructor(readonly blocked: PaymentInspectionBlocked) {
    super(blocked.message);
    this.name = 'PaymentInspectionBlockedError';
  }
}

export interface PaymentReplayInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  data?: string;
  paymentHeaderName: string;
  paymentHeaderValue: string;
  showBody: boolean;
  outputFile?: string;
  sellerTransport?: SellerRequestTransport;
  transactionId?: string;
}

export interface PaymentReplayResult extends BodyAttachment {
  status: number;
  contentType: string | undefined;
  success: boolean;
  headers: Headers;
}

export interface CardVerification {
  transactionId: string;
  verificationUrl: string;
  url: string;
  method: string;
  waiting: boolean;
  reason: 'action-required' | 'timeout' | 'stopped';
}

export type CardVerificationEvent =
  { type: 'verification-required'; verification: CardVerification } | { type: 'verification-completed' };

export interface CardVerificationOptions {
  apiBaseUrl: string;
  getStatus: () => Promise<PaymentStatusResponse>;
  interval: number;
  maxAttempts: number;
  timeout: number;
  signal?: AbortSignal;
}

export interface SellerRequestInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  data?: string;
  additionalAuthenticationHeaders?: Record<string, string>;
  transactionId?: string;
}

export interface SellerRequestTransport {
  request(input: SellerRequestInput): Promise<SellerRequestResult>;
}

export type SellerRequestResult = SellerProbeResult & { tapEvidenceId?: string };

function withoutHeader(headers: Record<string, string>, headerName: string): Record<string, string> {
  const blocked = headerName.toLowerCase();
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== blocked));
}

export const defaultSellerRequestTransport: SellerRequestTransport = {
  request: (input) => {
    const options: SellerProbeOptions = {
      method: input.method,
      headers: {
        ...input.headers,
        ...(input.additionalAuthenticationHeaders ?? {}),
      },
      ...(input.data !== undefined ? { data: input.data } : {}),
    };
    return sellerProbe(input.url, options);
  },
};

export async function sellerRequest(
  transport: SellerRequestTransport | undefined,
  input: SellerRequestInput,
): Promise<SellerRequestResult> {
  return (transport ?? defaultSellerRequestTransport).request(input);
}

async function requestPaymentReplay(input: PaymentReplayInput): Promise<SellerProbeResult> {
  try {
    const options: SellerRequestInput = {
      additionalAuthenticationHeaders: {
        [input.paymentHeaderName]: input.paymentHeaderValue,
      },
      method: input.method,
      headers: withoutHeader(input.headers, input.paymentHeaderName),
      ...(input.data !== undefined ? { data: input.data } : {}),
      ...(input.transactionId !== undefined ? { transactionId: input.transactionId } : {}),
      url: input.url,
    };
    return await sellerRequest(input.sellerTransport, options);
  } catch (err) {
    if (err instanceof SellerAuthenticationError) throw err;
    throw new PaymentReplayOutcomeUnknownError(err);
  }
}

async function finishPaymentReplay(input: PaymentReplayInput, result: SellerProbeResult): Promise<PaymentReplayResult> {
  const attachment = await buildBodyAttachment(result.bytes, input.showBody, input.outputFile);
  return {
    status: result.status,
    contentType: result.contentType,
    success: isSuccessStatus(result.status),
    headers: result.headers,
    ...attachment,
  };
}

export async function replayPaymentRequest(input: PaymentReplayInput): Promise<PaymentReplayResult> {
  return finishPaymentReplay(input, await requestPaymentReplay(input));
}

function verificationUrl(response: PaymentStatusResponse, transactionId: string, apiBaseUrl: string): string {
  const action = response.nextAction;
  let url: URL;
  try {
    url = new URL(action?.url ?? '');
  } catch {
    throw new SellerAuthenticationError(
      'INVALID_CARD_VERIFICATION',
      'The platform returned an invalid card verification URL.',
    );
  }
  const base = new URL(apiBaseUrl);
  const protocol =
    base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) ? 'http:' : 'https:';
  if (
    action?.type !== 'authenticate_card' ||
    url.protocol !== protocol ||
    url.host !== dashboardHostFor(apiBaseUrl) ||
    url.pathname !== `/transactions/${encodeURIComponent(transactionId)}/verify/` ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new SellerAuthenticationError(
      'INVALID_CARD_VERIFICATION',
      'The platform returned an invalid card verification URL.',
    );
  }
  return url.href;
}

export async function* replayWithCardVerification(
  input: PaymentReplayInput,
  options?: CardVerificationOptions,
): AsyncGenerator<CardVerificationEvent | { type: 'replay-response'; response: PaymentReplayResult }> {
  if (options?.signal?.aborted) return;
  let response = await requestPaymentReplay(input);
  if (!isSuccessStatus(response.status) && options !== undefined && input.transactionId !== undefined) {
    const transactionId = input.transactionId.toLowerCase();
    const read = async (): Promise<PaymentStatusResponse> => {
      options.signal?.throwIfAborted();
      let status: PaymentStatusResponse;
      try {
        status = await options.getStatus();
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        throw new SellerAuthenticationError(
          'PAYMENT_STATUS_UNAVAILABLE',
          'Unable to check the submitted card payment. Resume the original transaction; do not start another payment.',
        );
      }
      options.signal?.throwIfAborted();
      if (status.transactionId.toLowerCase() !== transactionId) {
        throw new SellerAuthenticationError(
          'INVALID_CARD_VERIFICATION',
          'The platform returned a different payment transaction.',
        );
      }
      return status;
    };
    const initial = await read();
    if (initial.nextAction !== undefined && ['PENDING', 'PROCESSING'].includes(initial.status)) {
      const verification: CardVerification = {
        transactionId,
        verificationUrl: verificationUrl(initial, transactionId, options.apiBaseUrl),
        url: input.url,
        method: input.method,
        waiting: options.interval > 0,
        reason: 'action-required',
      };
      yield { type: 'verification-required', verification };
      if (!verification.waiting) return;
      let first = true;
      for await (const outcome of pollAsync({
        fn: () => {
          if (first) {
            first = false;
            return Promise.resolve(initial);
          }
          return read();
        },
        isTerminal: (value) => !['PENDING', 'PROCESSING'].includes(value.status),
        interval: options.interval,
        maxAttempts: options.maxAttempts,
        timeout: options.timeout,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })) {
        options.signal?.throwIfAborted();
        if (outcome.value.nextAction !== undefined) verificationUrl(outcome.value, transactionId, options.apiBaseUrl);
        if (outcome.reason !== undefined) {
          yield { type: 'verification-required', verification: { ...verification, waiting: false, reason: 'timeout' } };
          return;
        }
        if (!outcome.terminal) continue;
        if (outcome.value.status !== 'SETTLED') {
          throw new SellerAuthenticationError(
            'CARD_PAYMENT_FAILED',
            `Card payment ${transactionId} ended with status ${outcome.value.status}. No replacement payment was started.`,
          );
        }
        options.signal?.throwIfAborted();
        yield { type: 'verification-completed' };
        options.signal?.throwIfAborted();
        response = await requestPaymentReplay(input);
        break;
      }
    }
  }
  yield { type: 'replay-response', response: await finishPaymentReplay(input, response) };
}
