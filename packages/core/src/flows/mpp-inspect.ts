import { HEADERS, parseChallengeHeaders, readHeaderAll } from '@inflowpayai/mpp';
import { sellerProbe, type SellerProbeOptions, type SellerProbeResult } from '@inflowpayai/x402-buyer/probe';
import { type DecodedChallenge, summarizeChallenge } from './mpp-decode.js';
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

/**
 * Result frame when the seller responds 2xx during the probe — there is no challenge to inspect, symmetric with the
 * no-payment branch of `mpp pay`. The body is never embedded; run `pay` to retrieve it.
 */
export interface MppInspectResultNoPayment {
  outcome: 'no-payment-required';
  url: string;
  method: string;
  status: number;
  contentType: string | undefined;
  bodySizeBytes: number;
}

/** Result frame when the seller responds 402 and at least one `inflow` challenge decoded cleanly. */
export interface MppInspectResultChallenges {
  outcome: 'challenges';
  url: string;
  method: string;
  realm: string;
  challenges: readonly DecodedChallenge[];
}

export type MppInspectPhase =
  | { kind: 'probing' }
  | { kind: 'challenges'; result: MppInspectResultChallenges }
  | { kind: 'no-payment'; result: MppInspectResultNoPayment }
  | { kind: 'error'; code: string; message: string };

export type MppInspectEvent =
  | { type: 'challenges'; result: MppInspectResultChallenges }
  | { type: 'no-payment'; result: MppInspectResultNoPayment }
  | { type: 'errored'; code: string; message: string };

export function reduceMppInspect(state: MppInspectPhase, event: MppInspectEvent): MppInspectPhase {
  switch (event.type) {
    case 'challenges':
      return { kind: 'challenges', result: event.result };
    case 'no-payment':
      return { kind: 'no-payment', result: event.result };
    case 'errored':
      return { kind: 'error', code: event.code, message: event.message };
    default:
      return state;
  }
}

export interface MppInspectPipelineDeps {
  probeOptions: SellerProbeOptions;
  url: string;
  /** Caller-supplied `--payment-method` filter — matches a challenge's `method`. Empty filtered set ⇒ NO_FILTERED_MATCH. */
  paymentMethodFilter?: string;
  /** Caller-supplied `--intent` filter — matches a challenge's `intent`. */
  intentFilter?: string;
  /** Caller-supplied `--currency` filter — matches the decoded request's `currency`. */
  currencyFilter?: string;
  /** Caller-supplied `--rail` filter — matches the decoded request's settlement `rail`. */
  railFilter?: string;
}

/**
 * One-shot probe → parse flow for `mpp inspect`. Mirrors the probe branch of {@link runMppPayPipeline} but stops at the
 * decode step — no challenge selection, no fulfilment, no replay. Emits exactly one terminal event via `emit`.
 */
export async function runMppInspectPipeline(
  deps: MppInspectPipelineDeps,
  emit: (event: MppInspectEvent) => void,
): Promise<void> {
  let probe: SellerProbeResult;
  try {
    probe = await sellerProbe(deps.url, deps.probeOptions);
  } catch (err) {
    emit({ type: 'errored', code: 'INSPECT_FAILED', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  if (probe.status !== 402) {
    if (!isSuccessStatus(probe.status)) {
      emit({
        type: 'errored',
        code: UNEXPECTED_PROBE_STATUS_CODE,
        message: `Seller returned status ${String(probe.status)} during probe; expected 2xx (no payment) or 402 (payment required).`,
      });
      return;
    }
    emit({
      type: 'no-payment',
      result: {
        outcome: 'no-payment-required',
        url: deps.url,
        method: deps.probeOptions.method,
        status: probe.status,
        contentType: probe.contentType,
        bodySizeBytes: probe.bytes.byteLength,
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

  let challenges: ReturnType<typeof parseChallengeHeaders>;
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
  const filtered = filterChallenges(inflowChallenges, filters);
  if (hasAnyChallengeFilter(filters) && filtered.length === 0) {
    emit({
      type: 'errored',
      code: NO_FILTERED_MATCH_CODE,
      message: buildNoFilteredMatchMessage(inflowChallenges, filters),
    });
    return;
  }

  const realm = filtered[0]?.realm ?? '';
  emit({
    type: 'challenges',
    result: {
      outcome: 'challenges',
      url: deps.url,
      method: deps.probeOptions.method,
      realm,
      challenges: filtered.map(summarizeChallenge),
    },
  });
}
