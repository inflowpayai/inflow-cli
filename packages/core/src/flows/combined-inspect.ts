import type { PaymentRequirements } from '@inflowpayai/x402';
import { fromFoundationRequirements } from '@inflowpayai/x402-buyer';
import { sellerProbe, type SellerProbeOptions, type SellerProbeResult } from '@inflowpayai/x402-buyer/probe';
import { type DecodedChallenge, summarizeChallenge } from './mpp-decode.js';
import { parseMppHeaderFromProbe } from './mpp-inspect.js';
import { filterPayableChallenges } from './mpp-shared.js';
import { isSuccessStatus, UNEXPECTED_PROBE_STATUS_CODE } from './x402-shared.js';
import { parseX402HeaderFromProbe } from './x402-inspect.js';

/**
 * Per-protocol view of a single 402 response, for the protocol-agnostic `inflow inspect`. Both sections are derived
 * from **one** `sellerProbe` call — MPP and x402 challenges ride the same 402, so there is exactly one HTTP request.
 *
 * Unlike `mpp pay` (which applies MPP-wins precedence when both protocols are present), inspect is informational and
 * reports both protocols independently. No caller filters are applied — top-level inspect is unfiltered discovery; use
 * `mpp inspect` / `x402 inspect` for filtered or fuller detail.
 */
export type MppSection =
  /** No `WWW-Authenticate: Payment` header on the 402. */
  | { kind: 'absent' }
  /** Header present and at least one supported MPP challenge decoded. */
  | { kind: 'challenges'; realm: string; challenges: readonly DecodedChallenge[] }
  /**
   * Header present and decoded, but advertised no method the InFlow buyer can fulfil. `methods` lists the distinct
   * unsupported payment methods the seller did offer, so the caller can explain why nothing was payable.
   */
  | { kind: 'none-inflow'; methods: readonly string[] }
  /** Header present but the codec rejected it. */
  | { kind: 'error'; code: string; message: string };

export type X402Section =
  /** No `PAYMENT-REQUIRED` header on the 402. */
  | { kind: 'absent' }
  /** Header present and decoded. `accepts` may be empty if the seller advertised none (unusual, but not our error). */
  | {
      kind: 'accepts';
      resource: string;
      x402Version: number;
      accepts: readonly PaymentRequirements[];
      extensions?: Record<string, unknown>;
    }
  /** Header present but the codec rejected it. */
  | { kind: 'error'; code: string; message: string };

/** Result when the seller responded 402: both protocol sections decoded from the same response. */
export interface CombinedInspectResult {
  outcome: 'inspected';
  url: string;
  method: string;
  status: number;
  mpp: MppSection;
  x402: X402Section;
}

/** Result when the seller responded 2xx — nothing to inspect. Symmetric with the per-protocol no-payment branches. */
export interface CombinedInspectNoPayment {
  outcome: 'no-payment-required';
  url: string;
  method: string;
  status: number;
  contentType: string | undefined;
  bodySizeBytes: number;
}

export type CombinedInspectPhase =
  | { kind: 'probing' }
  | { kind: 'inspected'; result: CombinedInspectResult }
  | { kind: 'no-payment'; result: CombinedInspectNoPayment }
  | { kind: 'error'; code: string; message: string };

export type CombinedInspectEvent =
  | { type: 'inspected'; result: CombinedInspectResult }
  | { type: 'no-payment'; result: CombinedInspectNoPayment }
  | { type: 'errored'; code: string; message: string };

export function reduceCombinedInspect(state: CombinedInspectPhase, event: CombinedInspectEvent): CombinedInspectPhase {
  switch (event.type) {
    case 'inspected':
      return { kind: 'inspected', result: event.result };
    case 'no-payment':
      return { kind: 'no-payment', result: event.result };
    case 'errored':
      return { kind: 'error', code: event.code, message: event.message };
    default:
      return state;
  }
}

export interface CombinedInspectPipelineDeps {
  probeOptions: SellerProbeOptions;
  url: string;
}

/** Build the MPP section from a 402 probe — decode header, then classify against the supported-method filter. */
export function buildMppSection(probe: SellerProbeResult): MppSection {
  const parse = parseMppHeaderFromProbe(probe);
  if (parse.kind === 'absent') return { kind: 'absent' };
  if (parse.kind === 'error') return { kind: 'error', code: parse.code, message: parse.message };
  const supportedChallenges = filterPayableChallenges(parse.challenges);
  if (supportedChallenges.length === 0) {
    const methods = [...new Set(parse.challenges.map((c) => c.method))].sort((a, b) => a.localeCompare(b));
    return { kind: 'none-inflow', methods };
  }
  const realm = supportedChallenges[0]?.realm ?? '';
  return { kind: 'challenges', realm, challenges: supportedChallenges.map(summarizeChallenge) };
}

/** Build the x402 section from a 402 probe — decode the `PAYMENT-REQUIRED` header into the buyer-facing accepts. */
export function buildX402Section(probe: SellerProbeResult): X402Section {
  const parse = parseX402HeaderFromProbe(probe);
  if (parse.kind === 'absent') return { kind: 'absent' };
  if (parse.kind === 'error') return { kind: 'error', code: parse.code, message: parse.message };
  const decoded = parse.decoded;
  return {
    kind: 'accepts',
    resource: decoded.resource.url,
    x402Version: decoded.x402Version,
    accepts: fromFoundationRequirements(decoded.accepts),
    ...(decoded.extensions !== undefined ? { extensions: decoded.extensions } : {}),
  };
}

/**
 * One-shot probe → decode flow for the protocol-agnostic `inflow inspect`. Probes once, then decodes both MPP and x402
 * challenges off the same response. Emits exactly one terminal event via `emit`. Read-only — no auth, no payment, no
 * filters.
 */
export async function runCombinedInspectPipeline(
  deps: CombinedInspectPipelineDeps,
  emit: (event: CombinedInspectEvent) => void,
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

  emit({
    type: 'inspected',
    result: {
      outcome: 'inspected',
      url: deps.url,
      method: deps.probeOptions.method,
      status: probe.status,
      mpp: buildMppSection(probe),
      x402: buildX402Section(probe),
    },
  });
}
