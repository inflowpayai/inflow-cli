import type { MppTransactionResponse, MppTransactionState } from '@inflowpayai/mpp';
import { userFacingErrorMessage } from './api-error.js';
import { pollAsync } from '../utils/async-poll.js';

/** Non-`pending` transaction states are terminal for the buyer poll. */
export const TERMINAL_STATES: ReadonlySet<MppTransactionState> = new Set(['expired', 'failed', 'ready']);

/**
 * Classify a transaction response by its server-authoritative `state`. `ready` means the credential is available;
 * `failed` / `expired` are terminal failures; `pending` means the caller should keep polling.
 */
export function classifyTransaction(response: MppTransactionResponse): MppTransactionState {
  return response.state;
}

export type MppStatusPhase =
  | { kind: 'polling'; latest?: MppTransactionResponse }
  | { kind: 'ready'; response: MppTransactionResponse }
  | { kind: 'failed'; response: MppTransactionResponse }
  | { kind: 'expired'; response: MppTransactionResponse }
  | { kind: 'timeout'; response?: MppTransactionResponse }
  | { kind: 'error'; message: string };

export type MppStatusEvent =
  | { type: 'snapshot'; response: MppTransactionResponse }
  | { type: 'ready'; response: MppTransactionResponse }
  | { type: 'failed'; response: MppTransactionResponse }
  | { type: 'expired'; response: MppTransactionResponse }
  | { type: 'timedOut'; response?: MppTransactionResponse }
  | { type: 'crashed'; message: string };

export function reduceMppStatus(state: MppStatusPhase, event: MppStatusEvent): MppStatusPhase {
  switch (event.type) {
    case 'snapshot':
      return { kind: 'polling', latest: event.response };
    case 'ready':
      return { kind: 'ready', response: event.response };
    case 'failed':
      return { kind: 'failed', response: event.response };
    case 'expired':
      return { kind: 'expired', response: event.response };
    case 'timedOut':
      return event.response !== undefined ? { kind: 'timeout', response: event.response } : { kind: 'timeout' };
    case 'crashed':
      return { kind: 'error', message: event.message };
    default:
      return state;
  }
}

export interface MppStatusInput {
  /** Function that fetches the latest transaction snapshot. Typically `() => client.getTransaction(transactionId)`. */
  fetchOnce: () => Promise<MppTransactionResponse>;
  /** Poll interval in seconds. */
  interval: number;
  /** Hard cap on poll attempts. Pass `0` for no cap. */
  maxAttempts: number;
  /** Wall-clock timeout in seconds. Pass `0` for no timeout. */
  timeout: number;
}

export interface MppStatusRun {
  events: AsyncIterable<MppStatusEvent>;
}

/**
 * Drive the polling loop for `mpp status`. Yields a `snapshot` event for every non-terminal change in the transaction
 * state, then exactly one terminal event (`ready` / `failed` / `expired` / `timedOut` / `crashed`).
 */
export function runMppStatus(input: MppStatusInput): MppStatusRun {
  async function* generate(): AsyncGenerator<MppStatusEvent> {
    try {
      const generator = pollAsync<MppTransactionResponse>({
        fn: input.fetchOnce,
        isTerminal: (response) => TERMINAL_STATES.has(response.state),
        isEqual: (a, b) => a.state === b.state && (a.credential !== undefined) === (b.credential !== undefined),
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
        const state = outcome.value.state;
        if (state === 'ready') {
          yield { type: 'ready', response: outcome.value };
          return;
        }
        if (state === 'expired') {
          yield { type: 'expired', response: outcome.value };
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
