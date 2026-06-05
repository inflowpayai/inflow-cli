import { HEADERS, type PaymentRequirements, readHeader } from '@inflowpayai/x402';
import { fromFoundationRequirements } from '@inflowpayai/x402-buyer';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { sellerProbe, type SellerProbeOptions, type SellerProbeResult } from '@inflowpayai/x402-buyer/probe';
import {
  type AcceptsFilters,
  buildNoFilteredMatchMessage,
  filterAccepts,
  INVALID_402_CODE,
  isSuccessStatus,
  NO_FILTERED_MATCH_CODE,
  UNEXPECTED_PROBE_STATUS_CODE,
} from './x402-shared.js';

/**
 * Result frame returned to `x402 inspect` when the seller responds 2xx during the probe — there is no payment
 * requirement to inspect, so the frame is symmetric with the no-payment branch of `pay`. The body itself is never
 * embedded; if the caller wants the body they should run `pay`.
 */
export interface InspectResultNoPayment {
  outcome: 'no-payment-required';
  url: string;
  method: string;
  status: number;
  contentType: string | undefined;
  bodySizeBytes: number;
}

/**
 * Result frame returned when the seller responds 402 and the PAYMENT-REQUIRED header decoded cleanly. Carries the
 * decoded accepts list (post-filter, if `schemeFilter` / `networkFilter` were applied).
 */
export interface InspectResultAccepts {
  outcome: 'accepts';
  url: string;
  method: string;
  resource: string;
  x402Version: number;
  accepts: readonly PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export type InspectPhase =
  | { kind: 'probing' }
  | { kind: 'accepts'; result: InspectResultAccepts }
  | { kind: 'no-payment'; result: InspectResultNoPayment }
  | { kind: 'error'; code: string; message: string };

export type InspectEvent =
  | { type: 'accepts'; result: InspectResultAccepts }
  | { type: 'no-payment'; result: InspectResultNoPayment }
  | { type: 'errored'; code: string; message: string };

/**
 * Outcome of reading + decoding the `PAYMENT-REQUIRED` header off a probe response, before any caller filtering. Shared
 * by {@link runInspectPipeline} and the combined-inspect pipeline so both decode x402 requirements identically.
 *
 * - `absent` — no `PAYMENT-REQUIRED` header on the 402.
 * - `parsed` — header present and decoded into the foundation `PaymentRequired` payload.
 * - `error` — header present but the codec rejected it (`DECODE_FAILED`).
 */
export type X402HeaderParse =
  | { kind: 'absent' }
  | { kind: 'parsed'; decoded: PaymentRequired }
  | { kind: 'error'; code: string; message: string };

/** Read + decode the `PAYMENT-REQUIRED` header from a 402 probe response. Pure; performs no I/O and applies no filters. */
export function parseX402HeaderFromProbe(probe: SellerProbeResult): X402HeaderParse {
  const headerValue = readHeader(Object.fromEntries(probe.headers.entries()), HEADERS.PAYMENT_REQUIRED);
  if (headerValue === undefined) return { kind: 'absent' };
  try {
    return { kind: 'parsed', decoded: decodePaymentRequiredHeader(headerValue) };
  } catch (err) {
    return { kind: 'error', code: 'DECODE_FAILED', message: err instanceof Error ? err.message : String(err) };
  }
}

export function reduceX402Inspect(state: InspectPhase, event: InspectEvent): InspectPhase {
  switch (event.type) {
    case 'accepts':
      return { kind: 'accepts', result: event.result };
    case 'no-payment':
      return { kind: 'no-payment', result: event.result };
    case 'errored':
      return { kind: 'error', code: event.code, message: event.message };
    default:
      return state;
  }
}

export interface InspectPipelineDeps {
  probeOptions: SellerProbeOptions;
  url: string;
  schemeFilter?: string;
  networkFilter?: string;
  /**
   * Caller-supplied asset filter — matches the on-chain asset identifier (ERC-20 contract address for EVM, mint pubkey
   * for SVM).
   */
  assetFilter?: string;
  /**
   * Caller-supplied asset-name filter — matches `entry.extra.assetName`, the human-readable symbol the seller
   * advertises (e.g. "USDC"). Present on every scheme including `balance`.
   */
  assetNameFilter?: string;
}

/**
 * One-shot probe → decode flow for `x402 inspect`. Mirrors the probe branch of `runPayPipeline` but stops at the decode
 * step — there is no requirement selection, no signer, no replay. Emits exactly one terminal event via the `emit`
 * callback.
 *
 * The filters `(schemeFilter, networkFilter, assetFilter, assetNameFilter)` narrow the rendered accepts via
 * {@link filterAccepts}. An empty filtered set emits `NO_FILTERED_MATCH_CODE` with the available-pairs hint; an
 * unfiltered empty set is still rendered (the seller chose to advertise no accepts, which is unusual but not the
 * caller's error to report).
 */
export async function runInspectPipeline(
  deps: InspectPipelineDeps,
  emit: (event: InspectEvent) => void,
): Promise<void> {
  let probe: SellerProbeResult;
  try {
    probe = await sellerProbe(deps.url, deps.probeOptions);
  } catch (err) {
    emit({
      type: 'errored',
      code: 'INSPECT_FAILED',
      message: err instanceof Error ? err.message : String(err),
    });
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
    const result: InspectResultNoPayment = {
      outcome: 'no-payment-required',
      url: deps.url,
      method: deps.probeOptions.method,
      status: probe.status,
      contentType: probe.contentType,
      bodySizeBytes: probe.bytes.byteLength,
    };
    emit({ type: 'no-payment', result });
    return;
  }

  const parse = parseX402HeaderFromProbe(probe);
  if (parse.kind === 'absent') {
    emit({
      type: 'errored',
      code: INVALID_402_CODE,
      message: 'Seller returned 402 but did not include a PAYMENT-REQUIRED header.',
    });
    return;
  }
  if (parse.kind === 'error') {
    emit({ type: 'errored', code: parse.code, message: parse.message });
    return;
  }
  const decoded = parse.decoded;

  const filters: AcceptsFilters = {
    ...(deps.schemeFilter !== undefined ? { scheme: deps.schemeFilter } : {}),
    ...(deps.networkFilter !== undefined ? { network: deps.networkFilter } : {}),
    ...(deps.assetFilter !== undefined ? { asset: deps.assetFilter } : {}),
    ...(deps.assetNameFilter !== undefined ? { assetName: deps.assetNameFilter } : {}),
  };
  const filtered = filterAccepts(decoded, filters);
  const anyFilterSet =
    deps.schemeFilter !== undefined ||
    deps.networkFilter !== undefined ||
    deps.assetFilter !== undefined ||
    deps.assetNameFilter !== undefined;
  if (anyFilterSet && filtered.accepts.length === 0) {
    emit({
      type: 'errored',
      code: NO_FILTERED_MATCH_CODE,
      message: buildNoFilteredMatchMessage(decoded, filters),
    });
    return;
  }

  const accepts = fromFoundationRequirements(filtered.accepts);

  const result: InspectResultAccepts = {
    outcome: 'accepts',
    url: deps.url,
    method: deps.probeOptions.method,
    resource: decoded.resource.url,
    x402Version: decoded.x402Version,
    accepts,
    ...(decoded.extensions !== undefined ? { extensions: decoded.extensions } : {}),
  };
  emit({ type: 'accepts', result });
}
