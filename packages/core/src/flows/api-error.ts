/**
 * Map an SDK API error into the user-facing `{ code, message }` envelope the CLI prints.
 *
 * The `@inflowpayai/x402` and `@inflowpayai/mpp` `InflowApiError`s both serialize their `.message` as `[<requestId>]
 * <endpoint>: <httpStatus> <code> — <serverMessage>`. The request id, endpoint path, and HTTP status are
 * transport/debugging details that don't belong in front of an end user — so this surfaces the server's own `code` and
 * the human-readable message segment instead (e.g. `INSUFFICIENT_FUNDS` + "Insufficient funds…" rather than
 * `PAYMENT_FAILED` + "/v1/transactions/x402: 400 INSUFFICIENT_FUNDS — Insufficient funds…").
 *
 * Detection is structural (duck-typed on `code` + `endpoint` + `message`) so it covers both SDK error classes without
 * importing either. Anything that isn't a recognizable SDK API error falls back to `fallbackCode` with the raw message,
 * so non-API failures (decode, network, validation) are unchanged.
 */
export function userFacingApiError(err: unknown, fallbackCode: string): { code: string; message: string } {
  if (isSdkApiError(err)) {
    // Surface the server's code only when it's meaningful. `UNEXPECTED_ERROR` is the SDK's sentinel for "the response
    // carried no code" (e.g. a bare 5xx) — no more informative than the caller's own fallback, so prefer the fallback
    // there. Either way the message is stripped of the endpoint / status / request-id prefix.
    const code = isMeaningfulCode(err.code) ? err.code : fallbackCode;
    return { code, message: stripDiagnosticPrefix(err.message) };
  }
  return { code: fallbackCode, message: err instanceof Error ? err.message : String(err) };
}

/** The SDK's placeholder code when a non-2xx response carried no application code of its own. */
const UNCODED_SENTINEL = 'UNEXPECTED_ERROR';

function isMeaningfulCode(code: string): boolean {
  return code.length > 0 && code !== UNCODED_SENTINEL;
}

/**
 * Clean just the message off an arbitrary thrown error, for call sites whose headline is a fixed label (e.g. status
 * polling) rather than the error code. Strips the SDK diagnostic prefix when present; otherwise returns the raw
 * message.
 */
export function userFacingErrorMessage(err: unknown): string {
  if (isSdkApiError(err)) return stripDiagnosticPrefix(err.message);
  return err instanceof Error ? err.message : String(err);
}

interface SdkApiErrorShape {
  code: string;
  endpoint: string;
  message: string;
}

function isSdkApiError(err: unknown): err is SdkApiErrorShape {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return typeof e.code === 'string' && typeof e.endpoint === 'string' && typeof e.message === 'string';
}

/**
 * Drop the `[<requestId>] <endpoint>: <httpStatus> <code> — ` prefix the SDK prepends, leaving just the server's
 * human-readable message (everything after the first `—`). Returns the whole message when the separator is absent.
 */
function stripDiagnosticPrefix(message: string): string {
  const separator = ' — ';
  const index = message.indexOf(separator);
  return index >= 0 ? message.slice(index + separator.length) : message;
}
