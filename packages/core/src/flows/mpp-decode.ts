import {
  decode,
  decodeCredential,
  decodeReceipt,
  type InflowChallengeRequest,
  type MppChallenge,
  type MppCredential,
  type MppReceipt,
  parseChallengeHeader,
} from '@inflowpayai/mpp';

/**
 * Compact projection of an MPP challenge for display. The opaque base64url-JCS `request` blob is decoded into its
 * `amount` / `currency` / rail fields; the top-level auth-params (`id`, `realm`, `method`, `intent`, `expires`,
 * `description`, `digest`) are surfaced verbatim. Every method's `amount` and `currency` are surfaced exactly as the
 * seller put them on the wire — the CLI never translates token addresses or base units through a baked-in registry.
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
  expires?: string;
  description?: string;
  digest?: string;
}

/**
 * Decode a challenge's base64url-JCS `request` into its method request shape (typed against the `inflow` method's
 * `InflowChallengeRequest`; the codec is a permissive JSON decode, so a `tempo` request decodes through the same path
 * and exposes its `amount` / `currency` / `recipient` verbatim). Returns `undefined` when the blob is absent or not
 * decodable.
 */
export function decodeChallengeRequest(challenge: MppChallenge): InflowChallengeRequest | undefined {
  if (challenge.request === '') return undefined;
  try {
    return decode<InflowChallengeRequest>(challenge.request, 'challenge request');
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
    out.amount = request.amount;
    out.currency = request.currency;
    if (request.recipient !== undefined) out.recipient = request.recipient;
    if (request.methodDetails?.rail !== undefined) out.rail = request.methodDetails.rail;
    if (request.methodDetails?.instrumentId !== undefined) out.instrumentId = request.methodDetails.instrumentId;
  }
  if (challenge.expires !== undefined) out.expires = challenge.expires;
  if (challenge.description !== undefined) out.description = challenge.description;
  if (challenge.digest !== undefined) out.digest = challenge.digest;
  return out;
}

/** Tagged decode result for `mpp decode`: a challenge header, a base64url credential, or a base64url receipt. */
export type DecodeResult =
  | { kind: 'challenge'; challenge: DecodedChallenge }
  | { kind: 'credential'; credential: MppCredential }
  | { kind: 'receipt'; receipt: MppReceipt };

/**
 * Decode a raw MPP artifact into structured JSON, auto-detecting its kind:
 *
 * - A `WWW-Authenticate: Payment …` header value (the `Payment ` scheme prefix or auth-param `key="value"` pairs) is
 *   parsed as a challenge.
 * - Otherwise the value is a base64url-JCS artifact: a `Payment-Receipt` (`challengeId` present) or an `Authorization:
 *   Payment` credential (`challenge` + `payload`).
 *
 * Throws when the value matches none of these shapes (the underlying codec raises a typed error).
 */
export function decodeMppValue(raw: string): DecodeResult {
  const trimmed = raw.trim();
  if (/^payment\s+/i.test(trimmed) || /[a-zA-Z0-9-]+="/.test(trimmed)) {
    return { kind: 'challenge', challenge: summarizeChallenge(parseChallengeHeader(trimmed)) };
  }
  const probe = decode<Record<string, unknown>>(trimmed, 'value');
  if ('challengeId' in probe) {
    return { kind: 'receipt', receipt: decodeReceipt(trimmed) };
  }
  return { kind: 'credential', credential: decodeCredential(trimmed) };
}
