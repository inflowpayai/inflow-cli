import type { X402PayloadResponse } from '@inflowpayai/x402-buyer';
import { userFacingErrorMessage } from './api-error.js';
import { pollAsync } from '../utils/async-poll.js';

/**
 * Status strings the server uses to report a terminal-failure outcome for an x402 approval. Anything not in this set
 * (and not yet `signed`) is treated as `pending` by {@link classifyPayloadResponse}.
 */
export const TERMINAL_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'DECLINED',
  'EXPIRED',
  'GENERAL_ERROR',
  'INSUFFICIENT_FUNDS',
]);

/**
 * Tri-state classifier for an x402 payload response. `signed` means both `encodedPayload` and `paymentPayload` are
 * present and the approval has settled; `failed` means the server moved to a terminal failure status; everything else
 * is `pending` and the caller should keep polling.
 */
export function classifyPayloadResponse(response: X402PayloadResponse): 'signed' | 'failed' | 'pending' {
  if (response.encodedPayload !== undefined && response.paymentPayload !== undefined) {
    return 'signed';
  }
  if (TERMINAL_FAILURE_STATUSES.has(response.status)) return 'failed';
  return 'pending';
}

export type X402StatusPhase =
  | { kind: 'polling'; latest?: X402PayloadResponse }
  | { kind: 'signed'; response: X402PayloadResponse }
  | { kind: 'failed'; response: X402PayloadResponse }
  | { kind: 'timeout'; response?: X402PayloadResponse }
  | { kind: 'error'; message: string };

export type X402StatusEvent =
  | { type: 'snapshot'; response: X402PayloadResponse }
  | { type: 'settled'; response: X402PayloadResponse }
  | { type: 'failed'; response: X402PayloadResponse }
  | { type: 'timedOut'; response?: X402PayloadResponse }
  | { type: 'crashed'; message: string };

export function reduceX402Status(state: X402StatusPhase, event: X402StatusEvent): X402StatusPhase {
  switch (event.type) {
    case 'snapshot':
      return { kind: 'polling', latest: event.response };
    case 'settled':
      return { kind: 'signed', response: event.response };
    case 'failed':
      return { kind: 'failed', response: event.response };
    case 'timedOut':
      return event.response !== undefined ? { kind: 'timeout', response: event.response } : { kind: 'timeout' };
    case 'crashed':
      return { kind: 'error', message: event.message };
    default:
      return state;
  }
}

export interface X402StatusInput {
  /** Function that fetches the latest payload snapshot. Typically `() => client.getX402Payload(transactionId)`. */
  fetchOnce: () => Promise<X402PayloadResponse>;
  /** Poll interval in seconds. */
  interval: number;
  /** Hard cap on poll attempts. Pass `0` for no cap. */
  maxAttempts: number;
  /** Wall-clock timeout in seconds. Pass `0` for no timeout. */
  timeout: number;
}

export interface X402StatusRun {
  events: AsyncIterable<X402StatusEvent>;
}

/**
 * Drives the polling loop for `x402 status`. Yields a `snapshot` event for every non-terminal change in the payload,
 * then exactly one terminal event (`settled` / `failed` / `timedOut` / `crashed`).
 */
export function runX402Status(input: X402StatusInput): X402StatusRun {
  async function* generate(): AsyncGenerator<X402StatusEvent> {
    try {
      const generator = pollAsync<X402PayloadResponse>({
        fn: input.fetchOnce,
        isTerminal: (response) => classifyPayloadResponse(response) !== 'pending',
        isEqual: (a, b) =>
          a.status === b.status &&
          (a.encodedPayload !== undefined) === (b.encodedPayload !== undefined) &&
          (a.paymentPayload !== undefined) === (b.paymentPayload !== undefined),
        interval: input.interval,
        maxAttempts: input.maxAttempts,
        timeout: input.timeout,
      });
      for await (const outcome of generator) {
        if (!outcome.terminal) {
          yield { type: 'snapshot', response: outcome.value };
          continue;
        }
        if (outcome.reason !== undefined) {
          yield { type: 'timedOut', response: outcome.value };
          return;
        }
        const kind = classifyPayloadResponse(outcome.value);
        if (kind === 'signed') {
          yield { type: 'settled', response: outcome.value };
          return;
        }
        yield { type: 'failed', response: outcome.value };
        return;
      }
    } catch (err) {
      yield { type: 'crashed', message: userFacingErrorMessage(err) };
    }
  }

  return { events: generate() };
}
