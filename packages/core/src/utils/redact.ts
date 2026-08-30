/**
 * Body-field redaction helpers shared by the verbose logger ({@link logRequest} / {@link logResponse} in `api-client.ts`)
 * and the {@link InflowApiError} constructor. Server responses and error envelopes can carry `access_token` /
 * `refresh_token` / `device_code` / `code_verifier` — anything that reaches stderr (`--verbose`) or lands on a caught
 * `err.rawBody` should be passed through here first.
 *
 * @internal
 */
export const REDACTED_BODY_FIELDS = new Set([
  'device_code',
  'refresh_token',
  'token',
  'access_token',
  'code_verifier',
  'cvc',
  'number',
  'signature',
  'signingRequestId',
  'tapEvidenceId',
]);

/** @internal */
export function redactJsonBody(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => redactJsonBody(entry));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTED_BODY_FIELDS.has(k) ? '<redacted>' : redactJsonBody(v);
    }
    return out;
  }
  return value;
}

/**
 * Apply field redaction to a serialised response body. Parses as JSON, redacts known sensitive fields, re-serialises
 * compactly. Non-JSON inputs pass through unchanged — error pages from load balancers, HTML, plain text are not known
 * to carry secrets in this SDK's deployments.
 *
 * @internal
 */
export function redactRawBody(rawBody: string): string {
  if (rawBody.length === 0) return rawBody;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
  return JSON.stringify(redactJsonBody(parsed));
}

/** @internal */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization') {
      redacted[key] = 'Bearer <redacted>';
    } else if (key.toLowerCase() === 'x-api-key') {
      redacted[key] = '<redacted>';
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

/** @internal */
export function redactBodyParams(params: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    redacted[key] = REDACTED_BODY_FIELDS.has(key) ? '<redacted>' : value;
  }
  return redacted;
}
