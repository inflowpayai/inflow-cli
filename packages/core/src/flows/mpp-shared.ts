import { METHOD_INFLOW, type MppChallenge } from '@inflowpayai/mpp';
import { decodeChallengeRequest } from './mpp-decode.js';

/** Error code emitted when a seller returns 402 but carries no `WWW-Authenticate: Payment` challenge header. */
export const INVALID_402_CODE = 'INVALID_402';

/**
 * Error code emitted when none of the seller's parsed challenges use the `inflow` method — the InFlow buyer cannot
 * fulfil a challenge minted for another method.
 */
export const NO_INFLOW_MATCH_CODE = 'NO_INFLOW_MATCH';

export const NO_INFLOW_MATCH_MESSAGE =
  "Seller's 402 carries no `inflow`-method MPP challenge; the InFlow buyer cannot fulfil it.";

/** Error code emitted when the `--currency` filter narrows the `inflow` challenge set to empty. */
export const NO_FILTERED_MATCH_CODE = 'NO_FILTERED_MATCH';

/** Error code emitted when the seller rejects the resubmitted `Authorization: Payment` credential (non-2xx replay). */
export const PAYMENT_NOT_ACCEPTED_CODE = 'PAYMENT_NOT_ACCEPTED';

/** Error code emitted when the seller responds with neither 2xx nor 402 to the initial probe. */
export const UNEXPECTED_PROBE_STATUS_CODE = 'UNEXPECTED_PROBE_STATUS';

/** True when `status` is a 2xx HTTP status. */
export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Keep only the challenges minted for the `inflow` method (the only method the InFlow buyer can fulfil). */
export function filterInflowChallenges(challenges: readonly MppChallenge[]): MppChallenge[] {
  return challenges.filter((challenge) => challenge.method === METHOD_INFLOW);
}

/**
 * Filters applied to the seller's `inflow` challenges. Each field is matched independently; `paymentMethod` and
 * `intent` match the challenge's top-level fields, `currency` and `rail` the decoded request. All fields undefined
 * returns the input unchanged.
 */
export interface ChallengeFilters {
  paymentMethod?: string;
  intent?: string;
  currency?: string;
  rail?: string;
}

/** True when any challenge filter is set. */
export function hasAnyChallengeFilter(filters: ChallengeFilters): boolean {
  return (
    filters.paymentMethod !== undefined ||
    filters.intent !== undefined ||
    filters.currency !== undefined ||
    filters.rail !== undefined
  );
}

/**
 * Narrow a list of challenges to those matching the caller's `--payment-method` / `--intent` / `--currency` / `--rail`
 * flags. Each filter is independent; all undefined returns the input unchanged. `currency` and `rail` are read from the
 * decoded request — a challenge whose request can't decode never matches a `currency`/`rail` filter.
 */
export function filterChallenges(challenges: readonly MppChallenge[], filters: ChallengeFilters): MppChallenge[] {
  if (!hasAnyChallengeFilter(filters)) return [...challenges];
  const { paymentMethod, intent, currency, rail } = filters;
  return challenges.filter((challenge) => {
    if (paymentMethod !== undefined && challenge.method !== paymentMethod) return false;
    if (intent !== undefined && challenge.intent !== intent) return false;
    if (currency !== undefined || rail !== undefined) {
      const request = decodeChallengeRequest(challenge);
      if (currency !== undefined && request?.currency !== currency) return false;
      if (rail !== undefined && request?.methodDetails?.rail !== rail) return false;
    }
    return true;
  });
}

/**
 * Build the human-readable message for {@link NO_FILTERED_MATCH_CODE}, listing the method/intent/currency/rail tuples
 * the seller advertises so the user can correct the flag.
 */
export function buildNoFilteredMatchMessage(challenges: readonly MppChallenge[], filters: ChallengeFilters): string {
  const { paymentMethod, intent, currency, rail } = filters;
  const filterDescription = [
    paymentMethod !== undefined ? `--payment-method=${paymentMethod}` : null,
    intent !== undefined ? `--intent=${intent}` : null,
    currency !== undefined ? `--currency=${currency}` : null,
    rail !== undefined ? `--rail=${rail}` : null,
  ]
    .filter((s): s is string => s !== null)
    .join(' ');
  const available = challenges
    .map((challenge) => {
      const request = decodeChallengeRequest(challenge);
      const parts = [`${challenge.method}/${challenge.intent}`];
      if (request?.currency !== undefined && request.currency !== '') parts.push(`currency=${request.currency}`);
      const railValue = request?.methodDetails?.rail;
      if (railValue !== undefined && railValue !== '') parts.push(`rail=${railValue}`);
      return parts.join(' ');
    })
    .join(', ');
  return `Seller has no \`inflow\` challenge matching ${filterDescription}. Available: ${available || '(none)'}.`;
}
