import {
  type CombinedInspectNoPayment,
  type CombinedInspectPhase,
  type CombinedInspectPipelineDeps,
  type CombinedInspectResult,
  parseHeaderFlags,
  runCombinedInspectPipeline,
  sanitizeDeep,
  type SellerProbeOptions,
} from '@inflowpayai/inflow-core';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { challengeToFrame } from '../mpp/inspect.js';
import { acceptToFrame } from '../x402/inspect.js';
import { CombinedInspectView, detectedProtocols } from './combined-inspect-view.js';
import { inspectArgs, inspectOptions } from './schema.js';

interface InspectCommandContext {
  agent: boolean;
  formatExplicit: boolean;
  args: { url: string };
  options: {
    method: string;
    data?: string | undefined;
    header: string[];
  };
  error: (options: { code: string; message: string; retryable?: boolean; exitCode?: number }) => never;
}

function parseHeaderFlagsOrFail(c: InspectCommandContext, flags: string[]): Record<string, string> {
  try {
    return parseHeaderFlags(flags);
  } catch (err) {
    c.error({ code: 'INVALID_HEADER', message: err instanceof Error ? err.message : String(err) });
  }
}

interface FrameWarning {
  protocol: 'mpp' | 'x402' | 'none';
  code: string;
  message: string;
  /** For `NO_INFLOW_MATCH`: the non-`inflow` MPP methods the seller advertised (e.g. `["tempo"]`). */
  methods?: readonly string[];
}

/**
 * Project the combined result into the agent frame: `{ url, detected, mpp[], x402[] }` with fixed-shape arrays (empty
 * when a protocol is absent). Section-level problems (a present-but-undecodable header, or an MPP header with no
 * inflow-payable challenge) are surfaced in an optional `warnings` array rather than failing the whole command.
 */
export function buildCombinedFrame(result: CombinedInspectResult): Record<string, unknown> {
  const warnings: FrameWarning[] = [];

  const mppRows = result.mpp.kind === 'challenges' ? result.mpp.challenges.map(challengeToFrame) : [];
  if (result.mpp.kind === 'none-inflow') {
    const offered = result.mpp.methods.length > 0 ? result.mpp.methods.join(', ') : '(unknown)';
    warnings.push({
      protocol: 'mpp',
      code: 'NO_INFLOW_MATCH',
      message: `WWW-Authenticate: Payment present, but no challenge uses the \`inflow\` method (only one the InFlow buyer can pay). Method(s) advertised: ${offered}.`,
      methods: result.mpp.methods,
    });
  } else if (result.mpp.kind === 'error') {
    warnings.push({ protocol: 'mpp', code: result.mpp.code, message: result.mpp.message });
  }

  const x402Rows = result.x402.kind === 'accepts' ? result.x402.accepts.map(acceptToFrame) : [];
  if (result.x402.kind === 'error') {
    warnings.push({ protocol: 'x402', code: result.x402.code, message: result.x402.message });
  }

  if (result.mpp.kind === 'absent' && result.x402.kind === 'absent') {
    warnings.push({
      protocol: 'none',
      code: 'NO_PAYMENT_CHALLENGE',
      message: 'Seller returned 402 but carried neither a WWW-Authenticate: Payment nor a PAYMENT-REQUIRED header.',
    });
  }

  const frame: Record<string, unknown> = {
    outcome: 'inspected',
    url: result.url,
    method: result.method,
    detected: detectedProtocols(result.mpp, result.x402),
    mpp: mppRows,
    x402: x402Rows,
  };
  if (result.x402.kind === 'accepts') {
    frame.x402_resource = result.x402.resource;
    frame.x402_version = result.x402.x402Version;
    if (result.x402.extensions !== undefined) frame.x402_extensions = result.x402.extensions;
  }
  if (warnings.length > 0) frame.warnings = warnings;
  return frame;
}

export function buildNoPaymentFrame(result: CombinedInspectNoPayment): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    outcome: 'no-payment-required',
    url: result.url,
    method: result.method,
    status: result.status,
    body_size_bytes: result.bodySizeBytes,
  };
  if (result.contentType !== undefined) frame.content_type = result.contentType;
  return frame;
}

export async function runCombinedInspectCommand(
  c: InspectCommandContext,
): Promise<Record<string, unknown> | undefined> {
  const probeHeaders = parseHeaderFlagsOrFail(c, c.options.header);
  const probeOptions: SellerProbeOptions = {
    method: c.options.method,
    headers: probeHeaders,
    ...(c.options.data !== undefined ? { data: c.options.data } : {}),
  };
  const deps: CombinedInspectPipelineDeps = { probeOptions, url: c.args.url };

  if (!c.agent && !c.formatExplicit) {
    let finalPhase: CombinedInspectPhase | null = null;
    await renderInkUntilExit(
      <CombinedInspectView
        url={c.args.url}
        method={c.options.method}
        deps={deps}
        onComplete={(phase) => {
          finalPhase = phase;
        }}
      />,
    );
    if (finalPhase !== null) {
      const phase = finalPhase as CombinedInspectPhase;
      if (phase.kind === 'error') {
        c.error({ code: phase.code, message: phase.message });
      }
    }
    return undefined;
  }

  let finalEvent: { kind: string; payload: unknown } | null = null;
  await runCombinedInspectPipeline(deps, (event) => {
    if (event.type === 'errored') {
      finalEvent = { kind: 'error', payload: event };
      return;
    }
    if (event.type === 'inspected') {
      finalEvent = { kind: 'inspected', payload: event.result };
      return;
    }
    if (event.type === 'no-payment') {
      finalEvent = { kind: 'no-payment', payload: event.result };
    }
  });

  if (finalEvent === null) {
    return c.error({ code: 'INSPECT_FAILED', message: 'Inspect pipeline produced no result.' });
  }
  const { kind, payload } = finalEvent as { kind: string; payload: unknown };
  if (kind === 'error') {
    const err = payload as { code: string; message: string };
    return c.error({ code: err.code, message: err.message });
  }
  if (kind === 'inspected') {
    return sanitizeDeep(buildCombinedFrame(payload as CombinedInspectResult));
  }
  return sanitizeDeep(buildNoPaymentFrame(payload as CombinedInspectNoPayment));
}

export function createInspectCommand() {
  return {
    description:
      "Detect a URL's payment protocol(s) and show MPP and x402 challenges together. Read-only probe - no auth, no payment. Read `detected` to choose a pay rail (MPP wins when both are present).",
    args: inspectArgs,
    options: inspectOptions,
    outputPolicy: 'agent-only' as const,
    examples: [
      {
        args: { url: 'https://api.foo.dev/dataset.csv' },
        description: 'Probe a URL and show every MPP and x402 challenge it advertises.',
      },
      {
        args: { url: 'https://api.foo.dev/widgets' },
        options: { method: 'POST', data: '{"sku":"widget-1"}' },
        description: 'Probe a POST-only paywalled endpoint.',
      },
    ],
    async run(c: InspectCommandContext) {
      return runCombinedInspectCommand(c);
    },
  };
}

export { inspectArgs, inspectOptions };
export type { InspectCommandContext };
