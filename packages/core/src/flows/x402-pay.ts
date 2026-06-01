import { writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { HEADERS, type PaymentRequirements, readHeader } from '@inflowpayai/x402';
import {
  type EncodedPayment,
  type InflowClient as X402InflowClient,
  type PreparedPayment,
  type SignOptions,
  X402AdapterRoutingError,
  X402ApprovalCancelledError,
  X402ApprovalFailedError,
  X402ApprovalTimeoutError,
  X402PaymentIdFormatError,
} from '@inflowpayai/x402-buyer';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { approvalUrlFor } from '../x402/dashboard-url.js';
import {
  describeBody,
  replayWithPayment,
  sellerProbe,
  type SellerProbeOptions,
  type SellerProbeResult,
} from '@inflowpayai/x402-buyer/probe';
import { userFacingApiError } from './api-error.js';
import { type DecodedHeader } from './x402-decode.js';
import {
  type AcceptsFilters,
  buildNoFilteredMatchMessage,
  filterAccepts,
  INVALID_402_CODE,
  isSuccessStatus,
  NO_FILTERED_MATCH_CODE,
  NO_INFLOW_MATCH_CODE,
  NO_INFLOW_MATCH_MESSAGE,
  UNEXPECTED_PROBE_STATUS_CODE,
} from './x402-shared.js';

interface PayResultBase {
  url: string;
  method: string;
}

export interface PayResultNoPayment extends PayResultBase {
  outcome: 'no-payment-required';
  status: number;
  contentType: string | undefined;
  bodySizeBytes: number;
  body?: string;
  bodyBase64?: string;
  outputSavedTo?: string;
}

export interface PaySettledMeta {
  network?: string;
  transaction?: string;
}

export interface PayResultSuccess extends PayResultBase {
  outcome: 'paid';
  transactionId: string;
  approvalId: string;
  approvalUrl: string;
  scheme: string;
  network: string;
  encodedPayload: string;
  responseStatus: number;
  responseContentType: string | undefined;
  bodySizeBytes: number;
  settled?: PaySettledMeta;
  body?: string;
  bodyBase64?: string;
  /** Absolute path the body bytes were written to when `outputFile` was set. */
  outputSavedTo?: string;
}

/**
 * Returned when the seller's reply to the replayed (PAYMENT-SIGNATURE-bearing) request is NOT in the 2xx range — most
 * often a second 402 indicating the seller still wants payment (e.g., the on-chain transaction had not yet confirmed
 * when the replay landed, or the signature did not match the requirement). Same metadata as {@link PayResultSuccess}
 * except `encodedPayload` is omitted (the buyer sent a payload but the seller rejected it; surfacing the encoded
 * payload to the user is not useful in this state).
 */
export interface PayResultReplayRejected extends PayResultBase {
  outcome: 'replay-rejected';
  transactionId: string;
  approvalId: string;
  approvalUrl: string;
  scheme: string;
  network: string;
  responseStatus: number;
  responseContentType: string | undefined;
  bodySizeBytes: number;
  body?: string;
  bodyBase64?: string;
  outputSavedTo?: string;
}

export type PayPhase =
  | { kind: 'probing' }
  | { kind: 'no-payment'; probe: SellerProbeResult }
  | { kind: 'matching'; decoded: DecodedHeader }
  | { kind: 'preparing'; decoded: DecodedHeader; requirement: PaymentRequirements }
  | {
      kind: 'awaiting-approval';
      decoded: DecodedHeader;
      requirement: PaymentRequirements;
      prepared: PreparedPayment;
      approvalUrl: string;
    }
  | {
      kind: 'replaying';
      encoded: EncodedPayment;
      approvalUrl: string;
      scheme: string;
      network: string;
    }
  | { kind: 'success'; result: PayResultSuccess }
  | { kind: 'replay-rejected'; result: PayResultReplayRejected }
  | { kind: 'no-payment-final'; result: PayResultNoPayment }
  | { kind: 'error'; code: string; message: string };

export type PayEvent =
  | { type: 'probed'; probe: SellerProbeResult }
  | { type: 'decoded'; decoded: DecodedHeader }
  | { type: 'matched'; decoded: DecodedHeader; requirement: PaymentRequirements }
  | {
      type: 'prepared';
      decoded: DecodedHeader;
      requirement: PaymentRequirements;
      prepared: PreparedPayment;
      approvalUrl: string;
    }
  | {
      type: 'awaited';
      encoded: EncodedPayment;
      approvalUrl: string;
      scheme: string;
      network: string;
    }
  | { type: 'replayed'; result: PayResultSuccess }
  | { type: 'rejected'; result: PayResultReplayRejected }
  | { type: 'short-circuited'; result: PayResultNoPayment }
  | { type: 'errored'; code: string; message: string };

export function reducePay(state: PayPhase, event: PayEvent): PayPhase {
  switch (event.type) {
    case 'probed':
      return { kind: 'no-payment', probe: event.probe };
    case 'decoded':
      return { kind: 'matching', decoded: event.decoded };
    case 'matched':
      return { kind: 'preparing', decoded: event.decoded, requirement: event.requirement };
    case 'prepared':
      return {
        kind: 'awaiting-approval',
        decoded: event.decoded,
        requirement: event.requirement,
        prepared: event.prepared,
        approvalUrl: event.approvalUrl,
      };
    case 'awaited':
      return {
        kind: 'replaying',
        encoded: event.encoded,
        approvalUrl: event.approvalUrl,
        scheme: event.scheme,
        network: event.network,
      };
    case 'replayed':
      return { kind: 'success', result: event.result };
    case 'rejected':
      return { kind: 'replay-rejected', result: event.result };
    case 'short-circuited':
      return { kind: 'no-payment-final', result: event.result };
    case 'errored':
      return { kind: 'error', code: event.code, message: event.message };
    default:
      return state;
  }
}

export interface PayPipelineDeps {
  client: X402InflowClient;
  apiBaseUrl: string;
  probeOptions: SellerProbeOptions;
  url: string;
  signOptions: SignOptions;
  showBody: boolean;
  /**
   * Optional file path. When set, body bytes are written here and the result carries `outputSavedTo: <absolute path>`
   * instead of the inline `body` / `bodyBase64`.
   */
  outputFile?: string;
  /**
   * Caller-supplied scheme filter (e.g. "balance", "exact"). When set, only seller `accepts[]` entries whose `scheme`
   * matches exactly are considered. An empty filtered set yields {@link NO_FILTERED_MATCH_CODE}.
   */
  schemeFilter?: string;
  /** Caller-supplied network filter (e.g. "inflow:1", "eip155:84532"). Same semantics as `schemeFilter`. */
  networkFilter?: string;
  /**
   * Caller-supplied asset filter — matches the on-chain asset identifier (ERC-20 contract address for EVM, mint pubkey
   * for SVM). Same semantics as `schemeFilter`.
   */
  assetFilter?: string;
  /**
   * Caller-supplied asset-name filter — matches `entry.extra.assetName`, the human-readable symbol the seller
   * advertises (e.g. "USDC"). Present on every scheme including `balance`. Same semantics as `schemeFilter`.
   */
  assetNameFilter?: string;
  /**
   * When `false`, the pipeline returns after emitting `prepared` — no `awaitPayload` poll, no replay, no terminal
   * `replayed` / `rejected` event. Use for the two-process agent pattern where the caller stops here, hands the
   * approval URL to the user, and resumes signing state via `x402 status`. Defaults to `true` (full lifecycle).
   */
  awaitPayment?: boolean;
}

/**
 * Map a buyer-side x402 SDK error into the agent-mode `{ code, message }` envelope the CLI emits. Recognised classes
 * collapse to their canonical code strings; anything else falls through to a generic `PAYMENT_FAILED` with the raw
 * message.
 */
export function mapSdkError(err: unknown): { code: string; message: string } {
  if (err instanceof X402PaymentIdFormatError) {
    return { code: 'INVALID_PAYMENT_ID', message: err.message };
  }
  if (err instanceof X402ApprovalCancelledError) {
    return { code: 'APPROVAL_CANCELLED', message: err.message };
  }
  if (err instanceof X402ApprovalFailedError) {
    return { code: 'APPROVAL_FAILED', message: err.message };
  }
  if (err instanceof X402ApprovalTimeoutError) {
    return { code: 'APPROVAL_TIMEOUT', message: err.message };
  }
  if (err instanceof X402AdapterRoutingError) {
    return { code: NO_INFLOW_MATCH_CODE, message: NO_INFLOW_MATCH_MESSAGE };
  }
  // An InFlow API rejection surfaces the server's own code + human message (endpoint / status / request id stripped);
  // anything else falls back to a generic PAYMENT_FAILED with the raw message.
  return userFacingApiError(err, 'PAYMENT_FAILED');
}

/**
 * Best-effort decode of the `PAYMENT-RESPONSE` header on the replayed response. Returns the network + on-chain
 * transaction hash if present; returns `undefined` when the header is absent or unparseable.
 */
export function buildSettledMeta(headers: Headers): PaySettledMeta | undefined {
  const responseHeader = readHeader(Object.fromEntries(headers.entries()), HEADERS.PAYMENT_RESPONSE);
  if (responseHeader === undefined) return undefined;
  try {
    const decoded = decodePaymentResponseHeader(responseHeader);
    const meta: PaySettledMeta = {};
    if (decoded.network !== undefined) meta.network = decoded.network;
    if (decoded.transaction !== undefined) meta.transaction = decoded.transaction;
    return Object.keys(meta).length > 0 ? meta : undefined;
  } catch {
    return undefined;
  }
}

export interface BodyAttachment {
  bodySizeBytes: number;
  body?: string;
  bodyBase64?: string;
  outputSavedTo?: string;
}

/**
 * Decide how to surface the response body, given the user's flags.
 *
 * `outputFile` (when non-empty) → write bytes to disk, return `outputSavedTo: <absolute path>` (no inline body /
 * base64); the file is the deliverable. `showBody=true` (default) → return `body` (UTF-8) or `bodyBase64` (binary)
 * inline alongside the size. `showBody=false` → size only.
 *
 * `outputFile` wins over `showBody` when both are set: an explicit save path indicates the user wants the file
 * artifact, not duplicated bytes in the JSON.
 */
export async function buildBodyAttachment(
  bytes: Uint8Array,
  showBody: boolean,
  outputFile: string | undefined,
): Promise<BodyAttachment> {
  const described = describeBody(bytes);
  const out: BodyAttachment = { bodySizeBytes: described.size };
  if (outputFile !== undefined && outputFile.length > 0) {
    const absolute = resolvePath(outputFile);
    await writeFile(absolute, Buffer.from(bytes));
    out.outputSavedTo = absolute;
    return out;
  }
  if (!showBody) return out;
  if (described.text !== undefined) {
    out.body = described.text;
  } else {
    out.bodyBase64 = described.base64;
  }
  return out;
}

function buildSigningContext(decoded: PaymentRequired): {
  resource: PaymentRequired['resource'];
  x402Version: number;
  extensions?: Record<string, unknown>;
} {
  return {
    resource: decoded.resource,
    x402Version: decoded.x402Version,
    ...(decoded.extensions !== undefined ? { extensions: decoded.extensions } : {}),
  };
}

function cloneDecoded(input: PaymentRequired): DecodedHeader {
  const decoded: DecodedHeader = {
    x402Version: input.x402Version,
    resource: input.resource,
    accepts: input.accepts,
  };
  if (input.extensions !== undefined) decoded.extensions = input.extensions;
  if (input.error !== undefined) decoded.error = input.error;
  return decoded;
}

/**
 * Drives the full `x402 pay` pipeline: probe → decode → match → prepare → await approval → replay. Emits an event for
 * each phase transition (and exactly one terminal event) via the `emit` callback. Caller dispatches each event into a
 * {@link reducePay} reducer to drive the UI.
 *
 * The body-attachment policy ({@link buildBodyAttachment}) is applied to both the no-payment-required short circuit and
 * the final settled response so the agent payload is uniform.
 */
export async function runPayPipeline(deps: PayPipelineDeps, emit: (event: PayEvent) => void): Promise<void> {
  try {
    const probe = await sellerProbe(deps.url, deps.probeOptions);
    if (probe.status !== 402) {
      // Probe came back non-402. Only 2xx means "seller served the resource without requiring payment"; anything else
      // (3xx, 4xx other than 402, 5xx) is a transport-layer surprise that the user needs to see as a failure rather
      // than a green checkmark.
      if (!isSuccessStatus(probe.status)) {
        emit({
          type: 'errored',
          code: UNEXPECTED_PROBE_STATUS_CODE,
          message: `Seller returned status ${String(probe.status)} during probe; expected 2xx (no payment) or 402 (payment required).`,
        });
        return;
      }
      const attachment = await buildBodyAttachment(probe.bytes, deps.showBody, deps.outputFile);
      const noPaymentResult: PayResultNoPayment = {
        outcome: 'no-payment-required',
        url: deps.url,
        method: deps.probeOptions.method,
        status: probe.status,
        contentType: probe.contentType,
        ...attachment,
      };
      emit({ type: 'short-circuited', result: noPaymentResult });
      return;
    }

    const headerValue = readHeader(Object.fromEntries(probe.headers.entries()), HEADERS.PAYMENT_REQUIRED);
    if (headerValue === undefined) {
      emit({
        type: 'errored',
        code: INVALID_402_CODE,
        message: 'Seller returned 402 but did not include a PAYMENT-REQUIRED header.',
      });
      return;
    }

    let decoded: PaymentRequired;
    try {
      decoded = decodePaymentRequiredHeader(headerValue);
    } catch (err) {
      emit({
        type: 'errored',
        code: 'DECODE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    emit({ type: 'decoded', decoded: cloneDecoded(decoded) });

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
    const requirement = await deps.client.selectInflowRequirement(filtered);
    if (requirement === null) {
      emit({
        type: 'errored',
        code: NO_INFLOW_MATCH_CODE,
        message: NO_INFLOW_MATCH_MESSAGE,
      });
      return;
    }
    emit({ type: 'matched', decoded: cloneDecoded(decoded), requirement });

    let prepared: PreparedPayment;
    try {
      const signingContext = buildSigningContext(decoded);
      prepared = await deps.client.prepareInflowPayment(requirement, signingContext, deps.signOptions);
    } catch (err) {
      const mapped = mapSdkError(err);
      emit({ type: 'errored', code: mapped.code, message: mapped.message });
      return;
    }
    const approvalUrl = approvalUrlFor(deps.apiBaseUrl, prepared.approvalId);
    emit({ type: 'prepared', decoded: cloneDecoded(decoded), requirement, prepared, approvalUrl });

    if (deps.awaitPayment === false) {
      return;
    }

    let encoded: EncodedPayment;
    try {
      encoded = await prepared.awaitPayload();
    } catch (err) {
      const mapped = mapSdkError(err);
      emit({ type: 'errored', code: mapped.code, message: mapped.message });
      return;
    }
    emit({
      type: 'awaited',
      encoded,
      approvalUrl,
      scheme: requirement.scheme,
      network: requirement.network,
    });

    const replay = await replayWithPayment(deps.url, {
      method: deps.probeOptions.method,
      headers: deps.probeOptions.headers,
      ...(deps.probeOptions.data !== undefined ? { data: deps.probeOptions.data } : {}),
      paymentSignature: encoded.encodedPayload,
    });
    const attachment = await buildBodyAttachment(replay.bytes, deps.showBody, deps.outputFile);

    if (!isSuccessStatus(replay.status)) {
      const rejected: PayResultReplayRejected = {
        outcome: 'replay-rejected',
        url: deps.url,
        method: deps.probeOptions.method,
        transactionId: prepared.transactionId,
        approvalId: prepared.approvalId,
        approvalUrl,
        scheme: requirement.scheme,
        network: requirement.network,
        responseStatus: replay.status,
        responseContentType: replay.contentType,
        ...attachment,
      };
      emit({ type: 'rejected', result: rejected });
      return;
    }

    const settled = buildSettledMeta(replay.headers);
    const success: PayResultSuccess = {
      outcome: 'paid',
      url: deps.url,
      method: deps.probeOptions.method,
      transactionId: prepared.transactionId,
      approvalId: prepared.approvalId,
      approvalUrl,
      scheme: requirement.scheme,
      network: requirement.network,
      encodedPayload: encoded.encodedPayload,
      responseStatus: replay.status,
      responseContentType: replay.contentType,
      ...(settled !== undefined ? { settled } : {}),
      ...attachment,
    };
    emit({ type: 'replayed', result: success });
  } catch (err) {
    const mapped = mapSdkError(err);
    emit({ type: 'errored', code: mapped.code, message: mapped.message });
  }
}
