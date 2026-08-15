import type { PaymentRequirements } from '@inflowpayai/x402';
import { AepInspectError, type AepOpenApiOperationPolicy, type InspectServiceResult } from '@aep-foundation/agent';
import type { ServiceInspection } from '@offering-protocol/agent';
import { fromFoundationRequirements } from '@inflowpayai/x402-buyer';
import { sellerProbe, type SellerProbeOptions, type SellerProbeResult } from '@inflowpayai/x402-buyer/probe';
import { type DecodedChallenge, summarizeChallenges } from './mpp-decode.js';
import { parseMppHeaderFromProbe } from './mpp-inspect.js';
import { filterPayableChallenges, resolveAcceptPaymentProbeOptions } from './mpp-shared.js';
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

export type AepInspectSource = 'openapi' | 'challenge' | 'anonymous_probe' | 'not_checked';

export type AepSection =
  | { kind: 'absent'; openApiPolicy?: AepOpenApiOperationPolicy; source: 'anonymous_probe' | 'not_checked' }
  | {
      kind: 'discovered';
      inspect: InspectServiceResult;
      source: 'anonymous_probe';
    }
  | {
      kind: 'blocked';
      inspect: InspectServiceResult;
      message: string;
      policy: AepOpenApiOperationPolicy;
      source: 'openapi';
    }
  | { kind: 'openapi'; inspect: InspectServiceResult; policy: AepOpenApiOperationPolicy }
  | {
      kind: 'service';
      inspect: InspectServiceResult;
      openApiPolicy?: AepOpenApiOperationPolicy;
      reason?: string;
      source: 'challenge';
    }
  | {
      kind: 'error';
      code: string;
      message: string;
      openApiPolicy?: AepOpenApiOperationPolicy;
      reason?: string;
      source: 'challenge';
    };

export type OdpSection =
  | { kind: 'absent' }
  | { kind: 'service'; inspect: ServiceInspection }
  | { kind: 'error'; code: string; message: string };

/** Result when the seller responded 402: both protocol sections decoded from the same response. */
export interface CombinedInspectResult {
  outcome: 'inspected';
  url: string;
  method: string;
  status?: number;
  odp: OdpSection;
  aep: AepSection;
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
  odp: OdpSection;
  aep: AepSection;
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
  inspectOdp?: (serviceUrl: string) => Promise<ServiceInspection>;
  inspectAep?: (serviceUrl: string) => Promise<InspectServiceResult>;
  inspectAepPolicy?: (
    inspect: InspectServiceResult,
    input: { method: string; url: string },
  ) => Promise<AepOpenApiOperationPolicy>;
  authenticatedProbe?: (
    inspect: InspectServiceResult,
    input: SellerProbeOptions & { url: string },
  ) => Promise<SellerProbeResult | undefined>;
  probeOptions: SellerProbeOptions;
  url: string;
}

async function buildOdpSection(deps: CombinedInspectPipelineDeps): Promise<OdpSection> {
  if (deps.inspectOdp === undefined) return { kind: 'absent' };
  try {
    return { kind: 'service', inspect: await deps.inspectOdp(deps.url) };
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
        ? error.status
        : undefined;
    if (status === 404 || status === 410) return { kind: 'absent' };
    const code =
      typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'ODP_INSPECT_FAILED';
    return { kind: 'error', code, message: error instanceof Error ? error.message : String(error) };
  }
}

function aepChallenge(probe: SellerProbeResult): { present: boolean; reason?: string } {
  const value = probe.headers.get('www-authenticate');
  if (value === null) return { present: false };
  const match = /(?:^|,)\s*AEP(?:\s+[^,]*)?/i.exec(value);
  const reason = /(?:^|[,\s])reason="([a-z0-9_]+)"/i.exec(value)?.[1];
  return match === null ? { present: false } : { present: true, ...(reason === undefined ? {} : { reason }) };
}

async function buildAepSection(
  probe: SellerProbeResult,
  deps: CombinedInspectPipelineDeps,
  fallback?: { inspect: InspectServiceResult; policy: AepOpenApiOperationPolicy },
): Promise<AepSection> {
  const challenge = aepChallenge(probe);
  if (!challenge.present)
    return fallback === undefined
      ? { kind: 'absent', source: 'anonymous_probe' }
      : fallback.policy.state === 'public'
        ? { kind: 'openapi', inspect: fallback.inspect, policy: fallback.policy }
        : { kind: 'discovered', inspect: fallback.inspect, source: 'anonymous_probe' };
  const reason = challenge.reason === undefined ? {} : { reason: challenge.reason };
  if (deps.inspectAep === undefined) {
    return {
      kind: 'error',
      code: 'AEP_INSPECT_UNAVAILABLE',
      message: 'AEP Inspect is unavailable.',
      ...(fallback === undefined ? {} : { openApiPolicy: fallback.policy }),
      source: 'challenge',
      ...reason,
    };
  }
  try {
    return {
      kind: 'service',
      inspect: fallback?.inspect ?? (await deps.inspectAep(deps.url)),
      ...(fallback === undefined ? {} : { openApiPolicy: fallback.policy }),
      source: 'challenge',
      ...reason,
    };
  } catch (error) {
    const identityMismatch = error instanceof AepInspectError && String(error.code) === 'service_identity_mismatch';
    return {
      kind: 'error',
      code: identityMismatch ? 'AEP_SERVICE_IDENTITY_MISMATCH' : 'AEP_INSPECT_FAILED',
      message: error instanceof Error ? error.message : String(error),
      ...(fallback === undefined ? {} : { openApiPolicy: fallback.policy }),
      source: 'challenge',
      ...reason,
    };
  }
}

async function buildOpenApiAepSection(deps: CombinedInspectPipelineDeps): Promise<{
  fallback?: { inspect: InspectServiceResult; policy: AepOpenApiOperationPolicy };
  probe?: SellerProbeResult;
  section?: AepSection;
}> {
  if (deps.inspectAep === undefined || deps.inspectAepPolicy === undefined) return {};
  try {
    const inspect = await deps.inspectAep(deps.url);
    const policy = await deps.inspectAepPolicy(inspect, { method: deps.probeOptions.method, url: deps.url });
    if (policy.state === 'fallback') return { fallback: { inspect, policy } };
    if (policy.state === 'required' && deps.authenticatedProbe !== undefined) {
      const probe = await deps.authenticatedProbe(inspect, { url: deps.url, ...deps.probeOptions });
      if (probe !== undefined) {
        return { section: { kind: 'openapi', inspect, policy }, probe };
      }
    }
    if (policy.state === 'required') {
      return {
        section: {
          kind: 'blocked',
          inspect,
          message:
            'AEP authentication is required before payment terms can be inspected. Enroll or grant first, then rerun inspect.',
          policy,
          source: 'openapi',
        },
      };
    }
    return { fallback: { inspect, policy } };
  } catch {
    return {};
  }
}

/** Build the MPP section from a 402 probe — decode header, then classify against the supported-method filter. */
export function buildMppSection(probe: SellerProbeResult): MppSection {
  const authenticate = probe.headers.get('www-authenticate');
  if (authenticate === null || !/(?:^|,)\s*Payment\s+/i.test(authenticate)) return { kind: 'absent' };
  const parse = parseMppHeaderFromProbe(probe);
  if (parse.kind === 'absent') return { kind: 'absent' };
  if (parse.kind === 'error') return { kind: 'error', code: parse.code, message: parse.message };
  const supportedChallenges = filterPayableChallenges(parse.challenges);
  if (supportedChallenges.length === 0) {
    const methods = [...new Set(parse.challenges.map((c) => c.method))].sort((a, b) => a.localeCompare(b));
    return { kind: 'none-inflow', methods };
  }
  const realm = supportedChallenges[0]?.realm ?? '';
  return { kind: 'challenges', realm, challenges: summarizeChallenges(supportedChallenges) };
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
  const odpPromise = buildOdpSection(deps);
  const resolvedProbeOptions = resolveAcceptPaymentProbeOptions(deps.probeOptions);
  const openApiAep = await buildOpenApiAepSection({ ...deps, probeOptions: resolvedProbeOptions });
  if (openApiAep.section !== undefined) {
    if (openApiAep.probe !== undefined) {
      emit({
        type: 'inspected',
        result: {
          outcome: 'inspected',
          url: deps.url,
          method: resolvedProbeOptions.method,
          status: openApiAep.probe.status,
          odp: await odpPromise,
          aep: openApiAep.section,
          mpp: buildMppSection(openApiAep.probe),
          x402: buildX402Section(openApiAep.probe),
        },
      });
      return;
    }
    emit({
      type: 'inspected',
      result: {
        outcome: 'inspected',
        url: deps.url,
        method: resolvedProbeOptions.method,
        odp: await odpPromise,
        aep: openApiAep.section,
        mpp: { kind: 'absent' },
        x402: { kind: 'absent' },
      },
    });
    return;
  }

  let probe: SellerProbeResult;
  try {
    probe = await sellerProbe(deps.url, resolvedProbeOptions);
  } catch (err) {
    emit({ type: 'errored', code: 'INSPECT_FAILED', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const aep = await buildAepSection(probe, deps, openApiAep.fallback);

  if (probe.status !== 402 && !(probe.status === 401 && aep.kind !== 'absent')) {
    if (!isSuccessStatus(probe.status)) {
      emit({
        type: 'errored',
        code: UNEXPECTED_PROBE_STATUS_CODE,
        message: `Seller returned status ${String(probe.status)} during probe; expected 2xx, an AEP authentication challenge, or 402.`,
      });
      return;
    }
    emit({
      type: 'no-payment',
      result: {
        outcome: 'no-payment-required',
        url: deps.url,
        method: resolvedProbeOptions.method,
        status: probe.status,
        contentType: probe.contentType,
        bodySizeBytes: probe.bytes.byteLength,
        odp: await odpPromise,
        aep,
      },
    });
    return;
  }

  emit({
    type: 'inspected',
    result: {
      outcome: 'inspected',
      url: deps.url,
      method: resolvedProbeOptions.method,
      status: probe.status,
      odp: await odpPromise,
      aep,
      mpp: buildMppSection(probe),
      x402: buildX402Section(probe),
    },
  });
}
