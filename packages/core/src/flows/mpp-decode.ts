import {
  decode,
  decodeCredential,
  decodeReceipt,
  type MppChallenge,
  type MppCredential,
  type MppReceipt,
  parseChallengeHeaders,
  readMppPaymentAmount,
  subscriptionOptionFingerprint,
  subscriptionOptionFingerprints,
} from '@inflowpayai/mpp';

/**
 * Payment summary with CARD and Stripe USD amounts in dollars. Token amounts retain their advertised units. The
 * original challenge is kept separately for payment and verification.
 */
export interface DecodedChallenge {
  id: string;
  realm: string;
  method: string;
  intent: string;
  amount?: string;
  currency?: string;
  recipient?: string;
  rail?: string;
  instrumentId?: string;
  periodCount?: number;
  periodUnit?: string;
  subscriptionExpires?: string;
  externalId?: string;
  expires?: string;
  description?: string;
  digest?: string;
  opaque?: string;
  optionId?: string;
  optionFingerprint?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Decode raw method-specific fields without interpreting amounts or validating payment eligibility. */
export function decodeChallengeRequest(challenge: MppChallenge): Record<string, unknown> | undefined {
  if (challenge.request === '') return undefined;
  try {
    const request = decode<unknown>(challenge.request, 'challenge request');
    return isRecord(request) ? request : undefined;
  } catch {
    return undefined;
  }
}

/** Project an `MppChallenge` into the compact {@link DecodedChallenge} the CLI renders. */
export function summarizeChallenge(challenge: MppChallenge): DecodedChallenge {
  const out: DecodedChallenge = {
    id: challenge.id,
    realm: challenge.realm,
    method: challenge.method,
    intent: challenge.intent,
  };
  const request = decodeChallengeRequest(challenge);
  if (request !== undefined) {
    Object.assign(out, readMppPaymentAmount(challenge.method, request));
    if (typeof request['recipient'] === 'string') out.recipient = request['recipient'];
    if (challenge.method === 'inflow') {
      const details = request['methodDetails'];
      if (isRecord(details)) {
        if (typeof details['rail'] === 'string') out.rail = details['rail'];
        if (typeof details['instrumentId'] === 'string') out.instrumentId = details['instrumentId'];
      }
      if (typeof request['periodCount'] === 'number') out.periodCount = request['periodCount'];
      if (typeof request['periodUnit'] === 'string') out.periodUnit = request['periodUnit'];
      if (typeof request['subscriptionExpires'] === 'string') out.subscriptionExpires = request['subscriptionExpires'];
    }
    if (typeof request['externalId'] === 'string') out.externalId = request['externalId'];
  }
  if (challenge.expires !== undefined) out.expires = challenge.expires;
  if (challenge.description !== undefined) out.description = challenge.description;
  if (challenge.digest !== undefined) out.digest = challenge.digest;
  if (challenge.opaque !== undefined) out.opaque = challenge.opaque;
  const option = subscriptionOptionFingerprint(challenge);
  if (option !== undefined) {
    out.optionId = option.optionId;
    out.optionFingerprint = option.fingerprint;
  }
  return out;
}

export function summarizeChallenges(challenges: readonly MppChallenge[]): DecodedChallenge[] {
  const options = subscriptionOptionFingerprints(challenges);
  return challenges.map((challenge, index) => {
    const summary = summarizeChallenge(challenge);
    const option = options[index];
    if (option !== undefined) {
      summary.optionId = option.optionId;
      summary.optionFingerprint = option.fingerprint;
    }
    return summary;
  });
}

/** Tagged decode result for `mpp decode`: a challenge header, a base64url credential, or a base64url receipt. */
export type DecodeResult =
  | { kind: 'challenge'; challenge: DecodedChallenge }
  | { kind: 'challenges'; challenges: DecodedChallenge[] }
  | { kind: 'credential'; credential: MppCredential }
  | { kind: 'receipt'; receipt: MppReceipt };

/**
 * Decode a raw MPP artifact into structured JSON, auto-detecting its kind:
 *
 * - A `WWW-Authenticate: Payment …` header value (the `Payment ` scheme prefix or auth-param `key="value"` pairs) is
 *   parsed as one or more challenges.
 * - Otherwise the value is a base64url-JCS artifact: a `Payment-Receipt` (the receipt base fields are present) or an
 *   `Authorization: Payment` credential (`challenge` + `payload`).
 *
 * Throws when the value matches none of these shapes (the underlying codec raises a typed error).
 */
export function decodeMppValue(raw: string): DecodeResult {
  const trimmed = raw.trim();
  if (/^payment\s+/i.test(trimmed) || /[a-zA-Z0-9-]+="/.test(trimmed)) {
    const challenges = summarizeChallenges(parseChallengeHeaders(trimmed));
    const first = challenges[0];
    if (challenges.length === 1 && first !== undefined) return { kind: 'challenge', challenge: first };
    return { kind: 'challenges', challenges };
  }
  const probe = decode<Record<string, unknown>>(trimmed, 'value');
  if ('method' in probe && 'reference' in probe && 'status' in probe && 'timestamp' in probe) {
    return { kind: 'receipt', receipt: decodeReceipt(trimmed) };
  }
  if ('challenge' in probe && 'payload' in probe) {
    return { kind: 'credential', credential: decodeCredential(trimmed) };
  }
  throw new Error('Value is not an MPP challenge, credential, or receipt');
}
