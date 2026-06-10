import { chmodSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  type AuthStorage,
  type Inflow,
  parseHeaderFlags,
  type PayEvent,
  type PayPipelineDeps,
  type PayResultNoPayment,
  type PayResultReplayRejected,
  type PayResultSuccess,
  pollAsync,
  sanitizeDeep,
  type SellerProbeOptions,
} from '@inflowpayai/inflow-core';
import type { X402BuyerSupportedResponse } from '@inflowpayai/x402';
import type { SignOptions, X402PayloadResponse } from '@inflowpayai/x402-buyer';
import { Cli } from 'incur';
import { assertSessionGuard } from '../../utils/assert-session.js';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { CancelView } from './cancel.js';
import { DecodeView, decodeHeader, type DecodedHeader } from './decode.js';
import {
  buildAcceptsFrame,
  buildNoPaymentFrame as buildInspectNoPaymentFrame,
  type InspectPhase,
  type InspectPipelineDeps,
  InspectView,
  runInspectPipeline,
} from './inspect.js';
import { PAYMENT_NOT_ACCEPTED_CODE, type PayPhase, PayView } from './pay.js';
import {
  cancelArgs,
  decodeArgs,
  inspectArgs,
  inspectOptions,
  payArgs,
  payOptions,
  statusArgs,
  statusOptions,
} from './schema.js';
import { classifyPayloadResponse, X402StatusView } from './status.js';
import { SupportedView } from './supported.js';

type ErrorOptions = {
  code: string;
  message: string;
  retryable?: boolean;
  exitCode?: number;
};

interface PayContext {
  agent: boolean;
  formatExplicit: boolean;
  args: { url: string };
  options: {
    method: string;
    data?: string | undefined;
    header: string[];
    interval: number;
    maxAttempts: number;
    timeout: number;
    paymentId?: string | undefined;
    showBody: boolean;
    outputFile?: string | undefined;
    payloadFile?: string | undefined;
    scheme?: string | undefined;
    network?: string | undefined;
    asset?: string | undefined;
    assetName?: string | undefined;
  };
  error: (err: ErrorOptions) => never;
}

interface StatusCommandContext {
  agent: boolean;
  formatExplicit: boolean;
  args: { transactionId: string };
  options: {
    interval: number;
    maxAttempts: number;
    timeout: number;
    payloadFile?: string | undefined;
  };
  error: (err: ErrorOptions) => never;
}

interface CancelCommandContext {
  agent: boolean;
  formatExplicit: boolean;
  args: { approvalId: string };
  error: (err: ErrorOptions) => never;
}

interface DecodeCommandContext {
  agent: boolean;
  formatExplicit: boolean;
  args: { header: string };
  error: (err: ErrorOptions) => never;
}

interface SupportedCommandContext {
  agent: boolean;
  formatExplicit: boolean;
  error: (err: ErrorOptions) => never;
}

interface InspectCommandContext {
  agent: boolean;
  formatExplicit: boolean;
  args: { url: string };
  options: {
    method: string;
    data?: string | undefined;
    header: string[];
    scheme?: string | undefined;
    network?: string | undefined;
    asset?: string | undefined;
    assetName?: string | undefined;
  };
  error: (err: ErrorOptions) => never;
}

const POST_PAY_INSTRUCTION =
  'Present the approval_url to the user and ask them to approve in the InFlow mobile app or dashboard. Then call `x402 status <transaction_id> --interval 5 --max-attempts 60` to poll until signed. Once the transaction is signed, replay the request manually using the encoded_payload from the status response as the PAYMENT-SIGNATURE header.';

const POLLING_INSTRUCTION =
  'Approval polling is happening inline. The yield stream emits each status change; the final frame includes the encoded_payload when signing completes.';

function buildSignOptions(options: PayContext['options']): SignOptions {
  const out: SignOptions = { timeoutMs: options.timeout * 1000 };
  if (options.interval > 0) out.pollIntervalMs = options.interval * 1000;
  if (options.paymentId !== undefined) out.paymentId = options.paymentId;
  return out;
}

function invalidHeaderError(err: unknown): ErrorOptions {
  return {
    code: 'INVALID_HEADER',
    message: err instanceof Error ? err.message : String(err),
  };
}

function decoratePayloadField(frame: Record<string, unknown>, encoded: string, payloadFile: string | undefined): void {
  if (payloadFile !== undefined && payloadFile.length > 0) {
    const absolute = resolvePath(payloadFile);
    writeFileSync(absolute, Buffer.from(encoded, 'utf-8'), { mode: 0o600 });
    // Enforce 0o600 on overwrite — writeFileSync only sets mode on file creation.
    chmodSync(absolute, 0o600);
    frame.payload_saved_to = absolute;
    return;
  }
  frame.encoded_payload = encoded;
}

function probeOptionsFrom(c: PayContext | InspectCommandContext): SellerProbeOptions {
  return {
    method: c.options.method,
    headers: parseHeaderFlags(c.options.header),
    ...(c.options.data !== undefined ? { data: c.options.data } : {}),
  };
}

function buildPayPipelineInput(
  c: PayContext,
  probeOptions: SellerProbeOptions,
): Omit<PayPipelineDeps, 'client' | 'apiBaseUrl'> {
  return {
    probeOptions,
    url: c.args.url,
    signOptions: buildSignOptions(c.options),
    showBody: c.options.showBody,
    ...(c.options.outputFile !== undefined ? { outputFile: c.options.outputFile } : {}),
    ...(c.options.scheme !== undefined ? { schemeFilter: c.options.scheme } : {}),
    ...(c.options.network !== undefined ? { networkFilter: c.options.network } : {}),
    ...(c.options.asset !== undefined ? { assetFilter: c.options.asset } : {}),
    ...(c.options.assetName !== undefined ? { assetNameFilter: c.options.assetName } : {}),
  };
}

function attachBodyFields(
  frame: Record<string, unknown>,
  result: Pick<PayResultNoPayment, 'bodySizeBytes' | 'body' | 'bodyBase64' | 'outputSavedTo'>,
): void {
  frame.body_size_bytes = result.bodySizeBytes;
  if (result.body !== undefined) frame.body = result.body;
  if (result.bodyBase64 !== undefined) frame.body_base64 = result.bodyBase64;
  if (result.outputSavedTo !== undefined) frame.output_saved_to = result.outputSavedTo;
}

function noPaymentFrameFromResult(result: PayResultNoPayment): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    outcome: 'no-payment-required',
    status: result.status,
  };
  if (result.contentType !== undefined) frame.content_type = result.contentType;
  attachBodyFields(frame, result);
  return frame;
}

function initialPayFrame(
  event: Extract<PayEvent, { type: 'prepared' }>,
  interval: number,
  maxAttempts: number,
): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    transaction_id: event.prepared.transactionId,
    approval_id: event.prepared.approvalId,
    approval_url: event.approvalUrl,
    resource: event.decoded.resource.url,
    scheme: event.requirement.scheme,
    network: event.requirement.network,
    instruction: interval > 0 ? POLLING_INSTRUCTION : POST_PAY_INSTRUCTION,
  };
  if (event.requirement.amount !== '') frame.amount = event.requirement.amount;
  if (event.requirement.asset !== '') frame.asset = event.requirement.asset;
  if (interval <= 0) {
    const max = maxAttempts > 0 ? maxAttempts : 60;
    frame._next = {
      command: `x402 status ${event.prepared.transactionId} --interval 5 --max-attempts ${String(max)}`,
      poll_interval_seconds: 5,
      until: 'encoded_payload is present',
    };
  }
  return frame;
}

function paidFrameFromResult(result: PayResultSuccess, payloadFile: string | undefined): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    outcome: 'paid',
    transaction_id: result.transactionId,
    approval_id: result.approvalId,
    scheme: result.scheme,
    network: result.network,
    response_status: result.responseStatus,
  };
  decoratePayloadField(frame, result.encodedPayload, payloadFile);
  if (result.responseContentType !== undefined) frame.response_content_type = result.responseContentType;
  if (result.settled !== undefined) frame.settled = result.settled;
  attachBodyFields(frame, result);
  return frame;
}

function rejectedFrameFromResult(result: PayResultReplayRejected): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    outcome: 'replay-rejected',
    transaction_id: result.transactionId,
    approval_id: result.approvalId,
    approval_url: result.approvalUrl,
    scheme: result.scheme,
    network: result.network,
    response_status: result.responseStatus,
  };
  if (result.responseContentType !== undefined) frame.response_content_type = result.responseContentType;
  attachBodyFields(frame, result);
  return frame;
}

async function* runPayCommand(
  c: PayContext,
  inflow: Inflow,
  authStorage: AuthStorage,
  apiBaseUrl: string,
): AsyncGenerator<unknown, unknown> {
  assertSessionGuard(c, authStorage, inflow);

  let probeOptions: SellerProbeOptions;
  try {
    probeOptions = probeOptionsFrom(c);
  } catch (err) {
    return c.error(invalidHeaderError(err));
  }

  if (!c.agent && !c.formatExplicit) {
    const client = await inflow.x402.client();
    let finalPhase: PayPhase | null = null;
    await renderInkUntilExit(
      <PayView
        url={c.args.url}
        method={c.options.method}
        deps={{
          client,
          apiBaseUrl,
          probeOptions,
          url: c.args.url,
          signOptions: buildSignOptions(c.options),
          showBody: c.options.showBody,
          ...(c.options.outputFile !== undefined ? { outputFile: c.options.outputFile } : {}),
          ...(c.options.scheme !== undefined ? { schemeFilter: c.options.scheme } : {}),
          ...(c.options.network !== undefined ? { networkFilter: c.options.network } : {}),
          ...(c.options.asset !== undefined ? { assetFilter: c.options.asset } : {}),
          ...(c.options.assetName !== undefined ? { assetNameFilter: c.options.assetName } : {}),
        }}
        onComplete={(phase) => {
          finalPhase = phase;
        }}
        onCancel={(approvalId) => inflow.x402.cancel({ approvalId })}
      />,
    );
    if (finalPhase !== null) {
      const phase = finalPhase as PayPhase;
      if (phase.kind === 'replay-rejected') {
        return c.error({
          code: PAYMENT_NOT_ACCEPTED_CODE,
          message: `Seller rejected the signed payment with status ${String(phase.result.responseStatus)}. The approval was completed but the seller did not honour the payment.`,
        });
      }
      if (phase.kind === 'error') {
        return c.error({ code: phase.code, message: phase.message });
      }
    }
    return;
  }

  const run = inflow.x402.pay({
    ...buildPayPipelineInput(c, probeOptions),
    awaitPayment: c.options.interval > 0,
  });

  for await (const event of run.events) {
    if (event.type === 'short-circuited') {
      yield sanitizeDeep(noPaymentFrameFromResult(event.result));
      return;
    }
    if (event.type === 'prepared') {
      yield sanitizeDeep(initialPayFrame(event, c.options.interval, c.options.maxAttempts));
      continue;
    }
    if (event.type === 'replayed') {
      yield sanitizeDeep(paidFrameFromResult(event.result, c.options.payloadFile));
      return;
    }
    if (event.type === 'rejected') {
      yield sanitizeDeep(rejectedFrameFromResult(event.result));
      return c.error({
        code: PAYMENT_NOT_ACCEPTED_CODE,
        message: `Seller rejected the signed payment with status ${String(event.result.responseStatus)}. The approval was completed but the seller did not honour the payment; see approval_url in the previous frame for details.`,
      });
    }
    if (event.type === 'errored') {
      return c.error({ code: event.code, message: event.message });
    }
    // 'probed' / 'decoded' / 'matched' / 'awaited' are intermediate phase signals; agent mode doesn't surface them.
  }
}

async function* runStatusCommand(
  c: StatusCommandContext,
  inflow: Inflow,
  authStorage: AuthStorage,
): AsyncGenerator<unknown, unknown> {
  assertSessionGuard(c, authStorage, inflow);

  if (!c.agent && !c.formatExplicit) {
    const client = await inflow.x402.client();
    await renderInkUntilExit(
      <X402StatusView
        transactionId={c.args.transactionId}
        fetchOnce={() => client.getX402Payload(c.args.transactionId)}
        interval={c.options.interval}
        maxAttempts={c.options.maxAttempts}
        timeout={c.options.timeout}
        onComplete={() => undefined}
      />,
    );
    return;
  }

  const client = await inflow.x402.client();
  const fetchOnce = (): Promise<X402PayloadResponse> => client.getX402Payload(c.args.transactionId);

  if (c.options.interval <= 0) {
    const snapshot = await fetchOnce();
    yield sanitizeDeep(toStatusFrame(c.args.transactionId, snapshot, c.options.payloadFile));
    return;
  }

  const generator = pollAsync<X402PayloadResponse>({
    fn: fetchOnce,
    isTerminal: (response) => classifyPayloadResponse(response) !== 'pending',
    isEqual: (a, b) =>
      a.status === b.status &&
      (a.encodedPayload !== undefined) === (b.encodedPayload !== undefined) &&
      (a.paymentPayload !== undefined) === (b.paymentPayload !== undefined),
    interval: c.options.interval,
    maxAttempts: c.options.maxAttempts,
    timeout: c.options.timeout,
  });
  for await (const outcome of generator) {
    yield sanitizeDeep(toStatusFrame(c.args.transactionId, outcome.value, c.options.payloadFile));
    if (!outcome.terminal) continue;
    if (outcome.reason !== undefined) {
      return c.error({
        code: 'POLLING_TIMEOUT',
        message:
          outcome.reason === 'timeout'
            ? 'Polling timed out before the transaction reached a signed state.'
            : 'Reached the configured maximum poll attempts before signed state.',
        retryable: true,
      });
    }
    if (classifyPayloadResponse(outcome.value) === 'failed') {
      return c.error({
        code: 'APPROVAL_FAILED',
        message: `Transaction ${c.args.transactionId} terminated as ${outcome.value.status} with no payload.`,
      });
    }
    return;
  }
}

export function toStatusFrame(
  transactionId: string,
  response: X402PayloadResponse,
  payloadFile?: string,
): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    transaction_id: transactionId,
    status: response.status,
  };
  if (response.encodedPayload !== undefined) {
    decoratePayloadField(frame, response.encodedPayload, payloadFile);
  }
  if (response.paymentPayload !== undefined) frame.payment_payload = response.paymentPayload;
  return frame;
}

async function runCancelCommand(
  c: CancelCommandContext,
  inflow: Inflow,
  authStorage: AuthStorage,
): Promise<{ approval_id: string; cancelled: true; note: string }> {
  assertSessionGuard(c, authStorage, inflow);

  if (!c.agent && !c.formatExplicit) {
    await renderInkUntilExit(
      <CancelView
        approvalId={c.args.approvalId}
        cancel={() => inflow.x402.cancel({ approvalId: c.args.approvalId }).then(() => undefined)}
        onComplete={() => undefined}
      />,
    );
    return {
      approval_id: c.args.approvalId,
      cancelled: true,
      note: 'best-effort; server-side state not verified',
    };
  }

  return inflow.x402.cancel({ approvalId: c.args.approvalId });
}

async function runDecodeCommand(c: DecodeCommandContext): Promise<DecodedHeader | undefined> {
  let decoded: DecodedHeader;
  try {
    decoded = decodeHeader(c.args.header);
  } catch (err) {
    return c.error({
      code: 'DECODE_FAILED',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (!c.agent && !c.formatExplicit) {
    await renderInkUntilExit(<DecodeView decoded={decoded} />);
    return undefined;
  }
  return sanitizeDeep(decoded);
}

async function runSupportedCommand(
  c: SupportedCommandContext,
  inflow: Inflow,
  authStorage: AuthStorage,
): Promise<X402BuyerSupportedResponse | undefined> {
  assertSessionGuard(c, authStorage, inflow);

  if (!c.agent && !c.formatExplicit) {
    await renderInkUntilExit(<SupportedView load={() => inflow.x402.supported()} onComplete={() => undefined} />);
    return undefined;
  }
  const response = await inflow.x402.supported();
  return sanitizeDeep(response);
}

async function runInspectCommand(c: InspectCommandContext): Promise<Record<string, unknown> | undefined> {
  let probeOptions: SellerProbeOptions;
  try {
    probeOptions = probeOptionsFrom(c);
  } catch (err) {
    return c.error(invalidHeaderError(err));
  }
  const deps: InspectPipelineDeps = {
    probeOptions,
    url: c.args.url,
    ...(c.options.scheme !== undefined ? { schemeFilter: c.options.scheme } : {}),
    ...(c.options.network !== undefined ? { networkFilter: c.options.network } : {}),
    ...(c.options.asset !== undefined ? { assetFilter: c.options.asset } : {}),
    ...(c.options.assetName !== undefined ? { assetNameFilter: c.options.assetName } : {}),
  };

  if (!c.agent && !c.formatExplicit) {
    let finalPhase: InspectPhase | null = null;
    await renderInkUntilExit(
      <InspectView
        url={c.args.url}
        method={c.options.method}
        deps={deps}
        onComplete={(phase) => {
          finalPhase = phase;
        }}
      />,
    );
    if (finalPhase !== null) {
      const phase = finalPhase as InspectPhase;
      if (phase.kind === 'error') {
        return c.error({ code: phase.code, message: phase.message });
      }
    }
    return undefined;
  }

  let finalEvent: { kind: string; payload: unknown } | null = null;
  await runInspectPipeline(deps, (event) => {
    if (event.type === 'errored') {
      finalEvent = { kind: 'error', payload: event };
      return;
    }
    if (event.type === 'accepts') {
      finalEvent = { kind: 'accepts', payload: event.result };
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
  if (kind === 'accepts') {
    return sanitizeDeep(buildAcceptsFrame(payload as Parameters<typeof buildAcceptsFrame>[0]));
  }
  return sanitizeDeep(buildInspectNoPaymentFrame(payload as Parameters<typeof buildInspectNoPaymentFrame>[0]));
}

export function createX402Cli(inflow: Inflow, authStorage: AuthStorage, apiBaseUrl: string) {
  const cli = Cli.create('x402', {
    description: 'x402 payment commands (pay, inspect, status, cancel, decode, supported).',
  });

  cli.command('pay', {
    description: 'Pay an x402-protected resource and return the seller response.',
    args: payArgs,
    options: payOptions,
    outputPolicy: 'agent-only' as const,
    async *run(c) {
      return yield* runPayCommand(c, inflow, authStorage, apiBaseUrl);
    },
  });

  cli.command('status', {
    description: 'Poll the signing state of an in-flight x402 transaction.',
    args: statusArgs,
    options: statusOptions,
    outputPolicy: 'agent-only' as const,
    async *run(c) {
      return yield* runStatusCommand(c, inflow, authStorage);
    },
  });

  cli.command('cancel', {
    description: 'Best-effort cancel of an x402 approval.',
    args: cancelArgs,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runCancelCommand(c, inflow, authStorage);
    },
  });

  cli.command('decode', {
    description: 'Decode a raw PAYMENT-REQUIRED header value.',
    args: decodeArgs,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runDecodeCommand(c);
    },
  });

  cli.command('supported', {
    description: 'List the buyer-side capability cache (scheme x network).',
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runSupportedCommand(c, inflow, authStorage);
    },
  });

  cli.command('inspect', {
    description: "Show the seller's PAYMENT-REQUIRED accepts for a URL. Read-only probe - no auth, no payment.",
    args: inspectArgs,
    options: inspectOptions,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runInspectCommand(c);
    },
  });

  return cli;
}

export const __testing = {
  runPayCommand,
  runStatusCommand,
  runCancelCommand,
  runDecodeCommand,
  runSupportedCommand,
  runInspectCommand,
  initialPayFrame,
  noPaymentFrameFromResult,
  paidFrameFromResult,
  rejectedFrameFromResult,
  toStatusFrame,
};
