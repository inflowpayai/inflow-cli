import {
  HEADERS,
  type InflowPaymentOptions,
  type MppChallenge,
  type MppClient,
  type MppReceipt,
  type MppTransactionResponse,
  parseChallengeHeaders,
  readHeader,
  readHeaderAll,
  SCHEME_PAYMENT,
  decodeReceipt,
} from '@inflowpayai/mpp';
import { sellerProbe, type SellerProbeOptions } from '@inflowpayai/x402-buyer/probe';
import { userFacingApiError } from './api-error.js';
import { pollAsync } from '../utils/async-poll.js';
import { approvalUrlFor } from '../x402/dashboard-url.js';
import { type DecodedChallenge, summarizeChallenge } from './mpp-decode.js';
import { buildBodyAttachment } from './x402-pay.js';
import {
  buildNoFilteredMatchMessage,
  type ChallengeFilters,
  filterChallenges,
  filterInflowChallenges,
  hasAnyChallengeFilter,
  INVALID_402_CODE,
  isSuccessStatus,
  NO_FILTERED_MATCH_CODE,
  NO_INFLOW_MATCH_CODE,
  NO_INFLOW_MATCH_MESSAGE,
  UNEXPECTED_PROBE_STATUS_CODE,
} from './mpp-shared.js';

interface MppPayResultBase {
  url: string;
  method: string;
}

export interface MppPayResultNoPayment extends MppPayResultBase {
  outcome: 'no-payment-required';
  status: number;
  contentType: string | undefined;
  bodySizeBytes: number;
  body?: string;
  bodyBase64?: string;
  outputSavedTo?: string;
}

/** Compact projection of the `Payment-Receipt` header on a settled response. */
export interface MppPaySettlement {
  reference?: string;
  status?: string;
  timestamp?: string;
}

export interface MppPayResultSuccess extends MppPayResultBase {
  outcome: 'paid';
  transactionId: string;
  challengeId: string;
  intent: string;
  /** The base64url `MppCredential` sent as the `Authorization: Payment` value. */
  credential: string;
  responseStatus: number;
  responseContentType: string | undefined;
  bodySizeBytes: number;
  settled?: MppPaySettlement;
  body?: string;
  bodyBase64?: string;
  /** Absolute path the body bytes were written to when `outputFile` was set. */
  outputSavedTo?: string;
}

/**
 * Returned when the seller's reply to the resubmitted (`Authorization: Payment`-bearing) request is NOT 2xx — most
 * often the seller declining to honour the credential. Same metadata as {@link MppPayResultSuccess} minus the
 * `credential` (surfacing a rejected credential to the caller is not useful).
 */
export interface MppPayResultRejected extends MppPayResultBase {
  outcome: 'seller-rejected';
  transactionId: string;
  challengeId: string;
  responseStatus: number;
  responseContentType: string | undefined;
  bodySizeBytes: number;
  body?: string;
  bodyBase64?: string;
  outputSavedTo?: string;
}

/** The transaction state surfaced after `POST /v1/transactions/mpp`, before any inline poll/replay. */
export interface MppPayCreated {
  transactionId: string;
  state: MppTransactionResponse['state'];
  challenge: DecodedChallenge;
  approvalId?: string;
  approvalUrl?: string;
  retryAfterSeconds?: number;
  expires?: string;
}

export type MppPayPhase =
  | { kind: 'probing' }
  | { kind: 'no-payment'; probe: MppPayResultNoPayment }
  | { kind: 'decoded'; challenge: DecodedChallenge }
  | { kind: 'created'; created: MppPayCreated }
  | { kind: 'replaying'; created: MppPayCreated; credential: string }
  | { kind: 'success'; result: MppPayResultSuccess }
  | { kind: 'seller-rejected'; result: MppPayResultRejected }
  | { kind: 'no-payment-final'; result: MppPayResultNoPayment }
  | { kind: 'error'; code: string; message: string };

export type MppPayEvent =
  | { type: 'decoded'; challenge: DecodedChallenge }
  | { type: 'created'; created: MppPayCreated }
  | { type: 'replayed'; result: MppPayResultSuccess }
  | { type: 'rejected'; result: MppPayResultRejected }
  | { type: 'short-circuited'; result: MppPayResultNoPayment }
  | { type: 'errored'; code: string; message: string };

export function reduceMppPay(state: MppPayPhase, event: MppPayEvent): MppPayPhase {
  switch (event.type) {
    case 'decoded':
      return { kind: 'decoded', challenge: event.challenge };
    case 'created':
      return { kind: 'created', created: event.created };
    case 'replayed':
      return { kind: 'success', result: event.result };
    case 'rejected':
      return { kind: 'seller-rejected', result: event.result };
    case 'short-circuited':
      return { kind: 'no-payment-final', result: event.result };
    case 'errored':
      return { kind: 'error', code: event.code, message: event.message };
    default:
      return state;
  }
}

export interface MppPayPipelineDeps {
  client: MppClient;
  apiBaseUrl: string;
  url: string;
  probeOptions: SellerProbeOptions;
  /** Funding instrument id for an instrument-rail challenge. The buyer does not choose the rail — only this selector. */
  instrumentId?: string;
  /** Caller-supplied `--payment-method` filter — matches a challenge's `method`. Empty filtered set ⇒ NO_FILTERED_MATCH. */
  paymentMethodFilter?: string;
  /** Caller-supplied `--intent` filter — matches a challenge's `intent`. */
  intentFilter?: string;
  /** Caller-supplied `--currency` filter — matches the decoded request's `currency`. */
  currencyFilter?: string;
  /** Caller-supplied `--rail` filter — matches the decoded request's settlement `rail`. */
  railFilter?: string;
  showBody: boolean;
  /** When set, body bytes are written here and the result carries `outputSavedTo` instead of inline `body`. */
  outputFile?: string;
  /** Poll cadence in seconds while awaiting a `pending → ready` transition. */
  interval: number;
  /** Hard cap on poll attempts. `0` means unlimited. */
  maxAttempts: number;
  /** Polling deadline in seconds. `0` means no timeout. */
  timeout: number;
  /**
   * Optional abort signal. When fired, the inline `pending → ready` poll stops promptly (aborting the sleep between
   * ticks) so callers can tear down without waiting out the poll deadline.
   */
  signal?: AbortSignal;
  /**
   * When `false`, the pipeline returns after emitting `created` for a `pending` transaction — no inline poll, no
   * replay. Use for the two-process agent pattern: hand the approval URL to the user, then resume via `mpp status`.
   * Defaults to `true`.
   */
  awaitPayment?: boolean;
}

/**
 * Map a thrown error (network / API) into the agent-mode `{ code, message }` envelope. An MPP API rejection surfaces
 * the server's own code + human message (endpoint / status / request id stripped); anything else falls back to a
 * generic `PAYMENT_FAILED` with the raw message.
 */
export function mapMppError(err: unknown): { code: string; message: string } {
  return userFacingApiError(err, 'PAYMENT_FAILED');
}

/** Best-effort decode of the `Payment-Receipt` header on the settled response into a compact settlement summary. */
export function buildSettlement(headers: Headers): MppPaySettlement | undefined {
  const raw = readHeader(headers, HEADERS.PAYMENT_RECEIPT);
  if (raw === undefined) return undefined;
  let receipt: MppReceipt;
  try {
    receipt = decodeReceipt(raw);
  } catch {
    return undefined;
  }
  const out: MppPaySettlement = {};
  if (receipt.reference !== '') out.reference = receipt.reference;
  if (receipt.status !== '') out.status = receipt.status;
  if (receipt.timestamp !== '') out.timestamp = receipt.timestamp;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Poll `getTransaction` to a terminal state. Returns the terminal response, or `undefined` on poll exhaustion. */
async function resolveTransaction(
  client: MppClient,
  transactionId: string,
  deps: Pick<MppPayPipelineDeps, 'interval' | 'maxAttempts' | 'timeout' | 'signal'>,
): Promise<{ response: MppTransactionResponse } | { timedOut: true; latest?: MppTransactionResponse }> {
  const generator = pollAsync<MppTransactionResponse>({
    fn: () => client.getTransaction(transactionId),
    isTerminal: (response) => response.state !== 'pending',
    isEqual: (a, b) => a.state === b.state,
    // A 0 interval reaches here only on the TTY path (the agent path gates inline polling on interval > 0); fall back
    // to a 5s cadence so the poll loop doesn't spin.
    interval: deps.interval > 0 ? deps.interval : 5,
    maxAttempts: deps.maxAttempts,
    timeout: deps.timeout,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  });
  for await (const outcome of generator) {
    if (!outcome.terminal) continue;
    if (outcome.reason !== undefined) return { timedOut: true, latest: outcome.value };
    return { response: outcome.value };
  }
  return { timedOut: true };
}

/**
 * Drives the full `mpp pay` pipeline: probe → parse `WWW-Authenticate: Payment` challenge(s) → select the `inflow`
 * challenge → `POST /v1/transactions/mpp` → (poll `GET …/{id}/mpp` to `ready`) → resubmit with `Authorization: Payment
 * <credential>` → report. Emits an event per phase transition (and exactly one terminal event) via `emit`.
 */
export async function runMppPayPipeline(deps: MppPayPipelineDeps, emit: (event: MppPayEvent) => void): Promise<void> {
  try {
    const probe = await sellerProbe(deps.url, deps.probeOptions);
    if (probe.status !== 402) {
      if (!isSuccessStatus(probe.status)) {
        emit({
          type: 'errored',
          code: UNEXPECTED_PROBE_STATUS_CODE,
          message: `Seller returned status ${String(probe.status)} during probe; expected 2xx (no payment) or 402 (payment required).`,
        });
        return;
      }
      const attachment = await buildBodyAttachment(probe.bytes, deps.showBody, deps.outputFile);
      emit({
        type: 'short-circuited',
        result: {
          outcome: 'no-payment-required',
          url: deps.url,
          method: deps.probeOptions.method,
          status: probe.status,
          contentType: probe.contentType,
          ...attachment,
        },
      });
      return;
    }

    const headerValues = readHeaderAll(probe.headers, HEADERS.WWW_AUTHENTICATE);
    if (headerValues.length === 0) {
      emit({
        type: 'errored',
        code: INVALID_402_CODE,
        message: 'Seller returned 402 but did not include a WWW-Authenticate: Payment header.',
      });
      return;
    }

    let challenges: MppChallenge[];
    try {
      challenges = parseChallengeHeaders(headerValues);
    } catch (err) {
      emit({ type: 'errored', code: 'DECODE_FAILED', message: err instanceof Error ? err.message : String(err) });
      return;
    }

    const inflowChallenges = filterInflowChallenges(challenges);
    if (inflowChallenges.length === 0) {
      emit({ type: 'errored', code: NO_INFLOW_MATCH_CODE, message: NO_INFLOW_MATCH_MESSAGE });
      return;
    }

    const filters: ChallengeFilters = {
      ...(deps.paymentMethodFilter !== undefined ? { paymentMethod: deps.paymentMethodFilter } : {}),
      ...(deps.intentFilter !== undefined ? { intent: deps.intentFilter } : {}),
      ...(deps.currencyFilter !== undefined ? { currency: deps.currencyFilter } : {}),
      ...(deps.railFilter !== undefined ? { rail: deps.railFilter } : {}),
    };
    const selected = filterChallenges(inflowChallenges, filters);
    if (hasAnyChallengeFilter(filters) && selected.length === 0) {
      emit({
        type: 'errored',
        code: NO_FILTERED_MATCH_CODE,
        message: buildNoFilteredMatchMessage(inflowChallenges, filters),
      });
      return;
    }

    const challenge = selected[0] as MppChallenge;
    emit({ type: 'decoded', challenge: summarizeChallenge(challenge) });

    const options: InflowPaymentOptions = deps.instrumentId !== undefined ? { instrumentId: deps.instrumentId } : {};

    let created: MppTransactionResponse;
    try {
      created = await deps.client.createTransaction({ challenge, options });
    } catch (err) {
      const mapped = mapMppError(err);
      emit({ type: 'errored', code: mapped.code, message: mapped.message });
      return;
    }

    const createdFrame: MppPayCreated = {
      transactionId: created.transactionId ?? '',
      state: created.state,
      challenge: summarizeChallenge(challenge),
      ...(created.approvalId !== undefined ? { approvalId: created.approvalId } : {}),
      ...(created.approvalId !== undefined ? { approvalUrl: approvalUrlFor(deps.apiBaseUrl, created.approvalId) } : {}),
      ...(created.retryAfterSeconds !== undefined ? { retryAfterSeconds: created.retryAfterSeconds } : {}),
      ...(created.expires !== undefined ? { expires: created.expires } : {}),
    };
    emit({ type: 'created', created: createdFrame });

    let resolved = created;
    if (created.state === 'pending') {
      if (deps.awaitPayment === false) return;
      if (createdFrame.transactionId === '') {
        emit({
          type: 'errored',
          code: 'PAYMENT_FAILED',
          message: 'Pending transaction carried no transactionId to poll.',
        });
        return;
      }
      const outcome = await resolveTransaction(deps.client, createdFrame.transactionId, deps);
      if ('timedOut' in outcome) {
        emit({
          type: 'errored',
          code: 'POLLING_TIMEOUT',
          message: 'Polling timed out before the transaction reached a ready state.',
        });
        return;
      }
      resolved = outcome.response;
    }

    if (resolved.state === 'failed') {
      emit({
        type: 'errored',
        code: 'PAYMENT_FAILED',
        message: resolved.problem?.detail ?? resolved.problem?.title ?? 'MPP transaction failed.',
      });
      return;
    }
    if (resolved.state === 'expired') {
      emit({ type: 'errored', code: 'PAYMENT_EXPIRED', message: 'MPP transaction expired before it was ready.' });
      return;
    }
    if (resolved.state !== 'ready' || resolved.credential === undefined) {
      emit({
        type: 'errored',
        code: 'PAYMENT_FAILED',
        message: 'Transaction reached a ready state without a credential.',
      });
      return;
    }

    const credential = resolved.credential;
    const replay = await sellerProbe(deps.url, {
      method: deps.probeOptions.method,
      headers: { ...deps.probeOptions.headers, [HEADERS.AUTHORIZATION]: `${SCHEME_PAYMENT} ${credential}` },
      ...(deps.probeOptions.data !== undefined ? { data: deps.probeOptions.data } : {}),
    });
    const attachment = await buildBodyAttachment(replay.bytes, deps.showBody, deps.outputFile);

    if (!isSuccessStatus(replay.status)) {
      emit({
        type: 'rejected',
        result: {
          outcome: 'seller-rejected',
          url: deps.url,
          method: deps.probeOptions.method,
          transactionId: createdFrame.transactionId,
          challengeId: challenge.id,
          responseStatus: replay.status,
          responseContentType: replay.contentType,
          ...attachment,
        },
      });
      return;
    }

    const settled = buildSettlement(replay.headers);
    emit({
      type: 'replayed',
      result: {
        outcome: 'paid',
        url: deps.url,
        method: deps.probeOptions.method,
        transactionId: createdFrame.transactionId,
        challengeId: challenge.id,
        intent: challenge.intent,
        credential,
        responseStatus: replay.status,
        responseContentType: replay.contentType,
        ...(settled !== undefined ? { settled } : {}),
        ...attachment,
      },
    });
  } catch (err) {
    const mapped = mapMppError(err);
    emit({ type: 'errored', code: mapped.code, message: mapped.message });
  }
}
