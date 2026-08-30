import { inspectOpenApiPolicy } from '@aep-foundation/agent';
import type { SellerProbeOptions, SellerProbeResult } from '@inflowpayai/x402-buyer/probe';
import {
  type CombinedInspectNoPayment,
  type CombinedInspectPhase,
  type CombinedInspectPipelineDeps,
  type CombinedInspectResult,
  type AepSection,
  type AuthStorage,
  type Inflow,
  type IOdpResource,
  createTapFetch,
  parseHeaderFlags,
  runCombinedInspectPipeline,
  sanitizeDeep,
} from '@inflowpayai/inflow-core';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { mcpTool } from '../../mcp-metadata.js';
import { persistedAepPublicDocumentCache } from '../../utils/aep-public-document-cache.js';
import { storedAepCredentialAuthenticationHeaders } from '../aep/runtime.js';
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

interface InspectCommandDefinition {
  description: string;
  mcp: ReturnType<typeof mcpTool>;
  args: typeof inspectArgs;
  options: typeof inspectOptions;
  outputPolicy: 'agent-only';
  examples: {
    args: { url: string };
    options?: { method: string; data: string };
    description: string;
  }[];
  run: (c: InspectCommandContext) => Promise<Record<string, unknown> | undefined>;
}

function parseHeaderFlagsOrFail(c: InspectCommandContext, flags: string[]): Record<string, string> {
  try {
    return parseHeaderFlags(flags);
  } catch (err) {
    c.error({ code: 'INVALID_HEADER', message: err instanceof Error ? err.message : String(err) });
  }
}

interface FrameWarning {
  protocol: 'odp' | 'aep' | 'mpp' | 'x402' | 'none';
  code: string;
  message: string;
  /** For `NO_INFLOW_MATCH`: the unsupported MPP methods the seller advertised. */
  methods?: readonly string[];
}

type OpenApiPolicy = Awaited<ReturnType<typeof inspectOpenApiPolicy>>;

function openApiPolicyFrame(policy: OpenApiPolicy): Record<string, unknown> {
  const operation = policy.matchedOperation;
  return {
    accepted_methods: policy.methods,
    freshness: policy.freshness,
    ...(operation === undefined
      ? {}
      : { matched_operation: { method: operation.method, path_template: operation.pathTemplate } }),
    ...(policy.strictSlashSuggestion === undefined ? {} : { strict_slash_suggestion: policy.strictSlashSuggestion }),
    state: policy.state,
  };
}

function aepFrame(section: AepSection, warnings: FrameWarning[]): Record<string, unknown> {
  if (section.kind === 'service') {
    const inspect = section.inspect;
    return {
      required: true,
      source: 'challenge',
      ...(section.reason === undefined ? {} : { challenge: { reason: section.reason } }),
      ...(section.openApiPolicy === undefined ? {} : { openapi: openApiPolicyFrame(section.openApiPolicy) }),
      inspect: {
        document: inspect.document,
        service_url: String(inspect.finalUrl ?? inspect.inspectUrl).replace('/.well-known/aep', ''),
      },
    };
  }
  if (section.kind === 'discovered') {
    const inspect = section.inspect;
    return {
      required: false,
      source: section.source,
      inspect: {
        document: inspect.document,
        service_url: String(inspect.finalUrl ?? inspect.inspectUrl).replace('/.well-known/aep', ''),
      },
    };
  }
  if (section.kind === 'openapi') {
    const inspect = section.inspect;
    return {
      required: section.policy.state === 'required',
      source: 'openapi',
      openapi: openApiPolicyFrame(section.policy),
      inspect: {
        document: inspect.document,
        service_url: String(inspect.finalUrl ?? inspect.inspectUrl).replace('/.well-known/aep', ''),
      },
    };
  }
  if (section.kind === 'blocked') {
    const inspect = section.inspect;
    warnings.push({ protocol: 'aep', code: 'AEP_PAYMENT_INSPECT_BLOCKED', message: section.message });
    return {
      required: true,
      source: 'openapi',
      blocked: true,
      message: section.message,
      openapi: openApiPolicyFrame(section.policy),
      inspect: {
        document: inspect.document,
        service_url: String(inspect.finalUrl ?? inspect.inspectUrl).replace('/.well-known/aep', ''),
      },
    };
  }
  if (section.kind === 'absent') {
    return {
      required: false,
      source: section.source,
      ...(section.openApiPolicy === undefined ? {} : { openapi: openApiPolicyFrame(section.openApiPolicy) }),
    };
  }
  warnings.push({ protocol: 'aep', code: section.code, message: section.message });
  return {
    required: true,
    source: section.source,
    ...(section.reason === undefined ? {} : { challenge: { reason: section.reason } }),
    ...(section.openApiPolicy === undefined ? {} : { openapi: openApiPolicyFrame(section.openApiPolicy) }),
    error: { code: section.code, message: section.message },
  };
}

/**
 * Project the combined result into the agent frame: `{ url, detected, mpp[], x402[] }` with fixed-shape arrays (empty
 * when a protocol is absent). Section-level problems (a present-but-undecodable header, or an MPP header with no
 * supported challenge method) are surfaced in an optional `warnings` array rather than failing the whole command.
 */
export function buildCombinedFrame(result: CombinedInspectResult): Record<string, unknown> {
  const warnings: FrameWarning[] = [];

  let odp: Record<string, unknown> = { available: false };
  if (result.odp.kind === 'service') {
    odp = {
      available: true,
      inspect: {
        document: result.odp.inspect.document,
        service_origin: result.odp.inspect.serviceOrigin,
      },
    };
  } else if (result.odp.kind === 'error') {
    odp = { available: false, error: { code: result.odp.code, message: result.odp.message } };
    warnings.push({ protocol: 'odp', code: result.odp.code, message: result.odp.message });
  }

  const aep = aepFrame(result.aep, warnings);

  const mppRows = result.mpp.kind === 'challenges' ? result.mpp.challenges.map(challengeToFrame) : [];
  if (result.mpp.kind === 'none-inflow') {
    const offered = result.mpp.methods.length > 0 ? result.mpp.methods.join(', ') : '(unknown)';
    warnings.push({
      protocol: 'mpp',
      code: 'NO_INFLOW_MATCH',
      message: `WWW-Authenticate: Payment present, but no challenge uses a method the InFlow buyer can pay. Method(s) advertised: ${offered}.`,
      methods: result.mpp.methods,
    });
  } else if (result.mpp.kind === 'error') {
    warnings.push({ protocol: 'mpp', code: result.mpp.code, message: result.mpp.message });
  }

  const x402Rows = result.x402.kind === 'accepts' ? result.x402.accepts.map(acceptToFrame) : [];
  if (result.x402.kind === 'error') {
    warnings.push({ protocol: 'x402', code: result.x402.code, message: result.x402.message });
  }

  if (result.aep.kind === 'absent' && result.mpp.kind === 'absent' && result.x402.kind === 'absent') {
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
    detected: detectedProtocols(result.odp, result.aep, result.mpp, result.x402),
    odp,
    aep,
    mpp: mppRows,
    x402: x402Rows,
  };
  if (result.status !== undefined) frame['status'] = result.status;
  if (result.x402.kind === 'accepts') {
    frame['x402_resource'] = result.x402.resource;
    frame['x402_version'] = result.x402.x402Version;
    if (result.x402.extensions !== undefined) frame['x402_extensions'] = result.x402.extensions;
  }
  if (warnings.length > 0) frame['warnings'] = warnings;
  return frame;
}

export function buildNoPaymentFrame(result: CombinedInspectNoPayment): Record<string, unknown> {
  const warnings: FrameWarning[] = [];
  const frame: Record<string, unknown> = {
    outcome: 'no-payment-required',
    url: result.url,
    method: result.method,
    status: result.status,
    body_size_bytes: result.bodySizeBytes,
    detected: detectedProtocols(result.odp, result.aep, { kind: 'absent' }, { kind: 'absent' }),
    odp:
      result.odp.kind === 'service'
        ? {
            available: true,
            inspect: { document: result.odp.inspect.document, service_origin: result.odp.inspect.serviceOrigin },
          }
        : result.odp.kind === 'error'
          ? { available: false, error: { code: result.odp.code, message: result.odp.message } }
          : { available: false },
    aep: aepFrame(result.aep, warnings),
  };
  if (result.contentType !== undefined) frame['content_type'] = result.contentType;
  if (warnings.length > 0) frame['warnings'] = warnings;
  return frame;
}

export async function runCombinedInspectCommand(
  c: InspectCommandContext,
  inflow?: Inflow,
  authStorage?: AuthStorage,
  odpResource?: Pick<IOdpResource, 'inspect'>,
): Promise<Record<string, unknown> | undefined> {
  const aepFetch =
    inflow === undefined
      ? undefined
      : createTapFetch({ capabilities: inflow.capabilities, operation: 'aep.inspect', tap: inflow.tap });
  const probeFetch =
    inflow === undefined
      ? undefined
      : createTapFetch({ capabilities: inflow.capabilities, operation: 'odp.browse', tap: inflow.tap });
  const probeHeaders = parseHeaderFlagsOrFail(c, c.options.header);
  const probeOptions: SellerProbeOptions = {
    method: c.options.method,
    headers: probeHeaders,
    ...(c.options.data !== undefined ? { data: c.options.data } : {}),
  };
  const deps: CombinedInspectPipelineDeps = {
    ...(inflow === undefined
      ? {}
      : {
          inspectOdp: (serviceUrl: string) =>
            (odpResource ?? inflow.odp).inspect({ serviceUrl, signal: AbortSignal.timeout(30_000) }),
        }),
    probeOptions,
    ...(probeFetch === undefined
      ? {}
      : {
          probe: async (url: string, options: SellerProbeOptions): Promise<SellerProbeResult> => {
            const headers = new Headers(options.headers);
            if (options.data !== undefined && !headers.has('Content-Type')) {
              headers.set('Content-Type', 'application/json');
            }
            const response = await probeFetch(url, {
              ...(options.data === undefined ? {} : { body: options.data }),
              headers,
              method: options.method,
            });
            return {
              bytes: new Uint8Array(await response.arrayBuffer()),
              contentType: response.headers.get('content-type') ?? undefined,
              headers: response.headers,
              status: response.status,
            };
          },
        }),
    url: c.args.url,
    ...(inflow === undefined
      ? {}
      : {
          inspectAep: (serviceUrl: string) => {
            const publicDocumentCache =
              authStorage === undefined ? undefined : persistedAepPublicDocumentCache(authStorage);
            return inflow.aep.inspect({
              ...(aepFetch === undefined ? {} : { fetch: aepFetch }),
              serviceUrl,
              signal: AbortSignal.timeout(30_000),
              ...(publicDocumentCache === undefined ? {} : { publicDocumentCache }),
            });
          },
          inspectAepPolicy: (inspect, input) => {
            const publicDocumentCache =
              authStorage === undefined ? undefined : persistedAepPublicDocumentCache(authStorage);
            return inspectOpenApiPolicy({
              ...(aepFetch === undefined ? {} : { fetch: aepFetch }),
              inspect,
              method: input.method,
              ...(publicDocumentCache === undefined ? {} : { publicDocumentCache }),
              signal: AbortSignal.timeout(30_000),
              url: input.url,
            });
          },
          authenticatedProbe: async (inspect, input) => {
            if (authStorage === undefined) return undefined;
            try {
              const headers = await storedAepCredentialAuthenticationHeaders(
                {
                  authStorage,
                  context: c,
                  inflow,
                  timeout: 30,
                },
                inspect,
              );
              if (headers === undefined) return undefined;
              if (aepFetch === undefined) return undefined;
              const requestHeaders = new Headers({ ...input.headers, ...headers });
              if (input.data !== undefined && !requestHeaders.has('Content-Type')) {
                requestHeaders.set('Content-Type', 'application/json');
              }
              const response = await aepFetch(input.url, {
                ...(input.data === undefined ? {} : { body: input.data }),
                headers: requestHeaders,
                method: input.method,
              });
              return {
                bytes: new Uint8Array(await response.arrayBuffer()),
                contentType: response.headers.get('content-type') ?? undefined,
                headers: response.headers,
                status: response.status,
              };
            } catch {
              return undefined;
            }
          },
        }),
  };

  if (!c.agent && !c.formatExplicit) {
    const captured: { finalPhase: CombinedInspectPhase | null } = { finalPhase: null };
    await renderInkUntilExit(
      <CombinedInspectView
        url={c.args.url}
        method={c.options.method}
        deps={deps}
        onComplete={(phase) => {
          captured.finalPhase = phase;
        }}
      />,
    );
    if (captured.finalPhase !== null) {
      const phase = captured.finalPhase;
      if (phase.kind === 'error') {
        c.error({ code: phase.code, message: phase.message });
      }
    }
    return undefined;
  }

  const captured: { finalEvent: { kind: string; payload: unknown } | null } = { finalEvent: null };
  await runCombinedInspectPipeline(deps, (event) => {
    if (event.type === 'errored') {
      captured.finalEvent = { kind: 'error', payload: event };
      return;
    }
    if (event.type === 'inspected') {
      captured.finalEvent = { kind: 'inspected', payload: event.result };
      return;
    }
    captured.finalEvent = { kind: 'no-payment', payload: event.result };
  });

  if (captured.finalEvent === null) {
    return c.error({ code: 'INSPECT_FAILED', message: 'Inspect pipeline produced no result.' });
  }
  const { kind, payload } = captured.finalEvent;
  if (kind === 'error') {
    const err = payload as { code: string; message: string };
    return c.error({ code: err.code, message: err.message });
  }
  if (kind === 'inspected') {
    return sanitizeDeep(buildCombinedFrame(payload as CombinedInspectResult));
  }
  return sanitizeDeep(buildNoPaymentFrame(payload as CombinedInspectNoPayment));
}

export function createInspectCommand(
  inflow: Inflow,
  authStorage?: AuthStorage,
  odpResource?: Pick<IOdpResource, 'inspect'>,
): InspectCommandDefinition {
  return {
    description: 'Inspect a URL for agent discovery, enrollment, and payment capabilities',
    mcp: mcpTool('inspect'),
    args: inspectArgs,
    options: inspectOptions,
    outputPolicy: 'agent-only' as const,
    examples: [
      {
        args: { url: 'https://api.foo.dev/dataset.csv' },
        description: 'Probe a URL and show its ODP, AEP, MPP, and x402 capabilities and requirements.',
      },
      {
        args: { url: 'https://api.foo.dev/widgets' },
        options: { method: 'POST', data: '{"sku":"widget-1"}' },
        description: 'Probe a POST-only paywalled endpoint.',
      },
    ],
    async run(c: InspectCommandContext) {
      return runCombinedInspectCommand(c, inflow, authStorage, odpResource);
    },
  };
}

export { inspectArgs, inspectOptions };
export type { InspectCommandContext };
