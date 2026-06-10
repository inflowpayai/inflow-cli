import { chmodSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  type AuthStorage,
  type DecodedChallenge,
  type Inflow,
  type MppPayCreated,
  type MppPayPipelineDeps,
  type MppPayResultNoPayment,
  type MppPayResultRejected,
  type MppPayResultSuccess,
  parseHeaderFlags,
  runMppStatus,
  sanitizeDeep,
  type SellerProbeOptions,
} from '@inflowpayai/inflow-core';
import type { MppSupportedResponse, MppTransactionResponse } from '@inflowpayai/mpp';
import { Cli } from 'incur';
import { assertSessionGuard } from '../../utils/assert-session.js';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { CancelView } from './cancel.js';
import { DecodeView, decodeMppValue } from './decode.js';
import {
  buildChallengesFrame,
  buildNoPaymentFrame as buildInspectNoPaymentFrame,
  type MppInspectPhase,
  type MppInspectPipelineDeps,
  InspectView,
  runMppInspectPipeline,
} from './inspect.js';
import { MPP_PAYMENT_NOT_ACCEPTED_CODE, type MppPayPhase, PayView } from './pay.js';
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
import { MppStatusView } from './status.js';
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
    paymentMethod?: string | undefined;
    intent?: string | undefined;
    currency?: string | undefined;
    rail?: string | undefined;
    method: string;
    data?: string | undefined;
    header: string[];
    interval: number;
    maxAttempts: number;
    timeout: number;
    instrumentId?: string | undefined;
    showBody: boolean;
    outputFile?: string | undefined;
    credentialFile?: string | undefined;
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
    credentialFile?: string | undefined;
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
  args: { value: string };
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
    paymentMethod?: string | undefined;
    intent?: string | undefined;
    currency?: string | undefined;
    rail?: string | undefined;
    method: string;
    data?: string | undefined;
    header: string[];
  };
  error: (err: ErrorOptions) => never;
}

const POST_CREATE_INSTRUCTION =
  'Present the approval_url to the user and ask them to approve in the InFlow mobile app or dashboard. Then call `mpp status <transaction_id> --interval 5 --max-attempts 60` to poll until ready. Once ready, replay the request manually with the credential as the `Authorization: Payment <credential>` header.';

const POLLING_INSTRUCTION =
  'Approval polling is happening inline. The yield stream emits each state change; the final frame includes the result once the transaction is ready and replayed.';

function invalidHeaderError(err: unknown): ErrorOptions {
  return {
    code: 'INVALID_HEADER',
    message: err instanceof Error ? err.message : String(err),
  };
}

function decorateCredentialField(
  frame: Record<string, unknown>,
  credential: string,
  credentialFile: string | undefined,
): void {
  if (credentialFile !== undefined && credentialFile.length > 0) {
    const absolute = resolvePath(credentialFile);
    writeFileSync(absolute, Buffer.from(credential, 'utf-8'), { mode: 0o600 });
    // Enforce 0o600 on overwrite — writeFileSync only sets mode on file creation.
    chmodSync(absolute, 0o600);
    frame.credential_saved_to = absolute;
    return;
  }
  frame.credential = credential;
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
): Omit<MppPayPipelineDeps, 'client' | 'apiBaseUrl'> {
  return {
    probeOptions,
    url: c.args.url,
    showBody: c.options.showBody,
    interval: c.options.interval,
    maxAttempts: c.options.maxAttempts,
    timeout: c.options.timeout,
    ...(c.options.instrumentId !== undefined ? { instrumentId: c.options.instrumentId } : {}),
    ...(c.options.paymentMethod !== undefined ? { paymentMethodFilter: c.options.paymentMethod } : {}),
    ...(c.options.intent !== undefined ? { intentFilter: c.options.intent } : {}),
    ...(c.options.currency !== undefined ? { currencyFilter: c.options.currency } : {}),
    ...(c.options.rail !== undefined ? { railFilter: c.options.rail } : {}),
    ...(c.options.outputFile !== undefined ? { outputFile: c.options.outputFile } : {}),
  };
}

function attachBodyFields(
  frame: Record<string, unknown>,
  result: Pick<MppPayResultNoPayment, 'bodySizeBytes' | 'body' | 'bodyBase64' | 'outputSavedTo'>,
): void {
  frame.body_size_bytes = result.bodySizeBytes;
  if (result.body !== undefined) frame.body = result.body;
  if (result.bodyBase64 !== undefined) frame.body_base64 = result.bodyBase64;
  if (result.outputSavedTo !== undefined) frame.output_saved_to = result.outputSavedTo;
}

function challengeFields(challenge: DecodedChallenge): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: challenge.id,
    method: challenge.method,
    intent: challenge.intent,
  };
  if (challenge.amount !== undefined) out.amount = challenge.amount;
  if (challenge.currency !== undefined) out.currency = challenge.currency;
  if (challenge.rail !== undefined) out.rail = challenge.rail;
  return out;
}

function noPaymentFrameFromResult(result: MppPayResultNoPayment): Record<string, unknown> {
  const frame: Record<string, unknown> = { outcome: 'no-payment-required', status: result.status };
  if (result.contentType !== undefined) frame.content_type = result.contentType;
  attachBodyFields(frame, result);
  return frame;
}

function createdFrameFromEvent(created: MppPayCreated, interval: number, maxAttempts: number): Record<string, unknown> {
  const pending = created.state === 'pending';
  const frame: Record<string, unknown> = {
    transaction_id: created.transactionId,
    state: created.state,
    challenge: challengeFields(created.challenge),
    instruction: interval > 0 ? POLLING_INSTRUCTION : POST_CREATE_INSTRUCTION,
  };
  if (created.approvalId !== undefined) frame.approval_id = created.approvalId;
  if (created.approvalUrl !== undefined) frame.approval_url = created.approvalUrl;
  if (created.retryAfterSeconds !== undefined) frame.retry_after_seconds = created.retryAfterSeconds;
  if (created.expires !== undefined) frame.expires = created.expires;
  if (pending && interval <= 0) {
    const max = maxAttempts > 0 ? maxAttempts : 60;
    frame._next = {
      command: `mpp status ${created.transactionId} --interval 5 --max-attempts ${String(max)}`,
      poll_interval_seconds: 5,
      until: 'state is ready (credential present)',
    };
  }
  return frame;
}

function paidFrameFromResult(result: MppPayResultSuccess, credentialFile: string | undefined): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    outcome: 'paid',
    transaction_id: result.transactionId,
    challenge_id: result.challengeId,
    intent: result.intent,
    response_status: result.responseStatus,
  };
  decorateCredentialField(frame, result.credential, credentialFile);
  if (result.responseContentType !== undefined) frame.response_content_type = result.responseContentType;
  if (result.settled !== undefined) frame.settled = result.settled;
  attachBodyFields(frame, result);
  return frame;
}

function rejectedFrameFromResult(result: MppPayResultRejected): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    outcome: 'seller-rejected',
    transaction_id: result.transactionId,
    challenge_id: result.challengeId,
    response_status: result.responseStatus,
  };
  if (result.responseContentType !== undefined) frame.response_content_type = result.responseContentType;
  attachBodyFields(frame, result);
  return frame;
}

export function toStatusFrame(response: MppTransactionResponse, credentialFile?: string): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    transaction_id: response.transactionId ?? '',
    state: response.state,
  };
  if (response.state === 'ready' && response.credential !== undefined) {
    decorateCredentialField(frame, response.credential, credentialFile);
    if (response.expires !== undefined) frame.expires = response.expires;
  }
  if (response.state === 'pending') {
    if (response.approvalId !== undefined) frame.approval_id = response.approvalId;
    if (response.retryAfterSeconds !== undefined) frame.retry_after_seconds = response.retryAfterSeconds;
  }
  if (response.problem !== undefined) frame.problem = response.problem;
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
    const client = await inflow.mpp.client();
    let finalPhase: MppPayPhase | null = null;
    await renderInkUntilExit(
      <PayView
        url={c.args.url}
        method={c.options.method}
        deps={{
          ...buildPayPipelineInput(c, probeOptions),
          client,
          apiBaseUrl,
          awaitPayment: true,
        }}
        onComplete={(phase) => {
          finalPhase = phase;
        }}
        onCancel={(approvalId) => inflow.mpp.cancel({ approvalId })}
      />,
    );
    if (finalPhase !== null) {
      const phase = finalPhase as MppPayPhase;
      if (phase.kind === 'seller-rejected') {
        return c.error({
          code: MPP_PAYMENT_NOT_ACCEPTED_CODE,
          message: `Seller rejected the credential with status ${String(phase.result.responseStatus)}. The transaction was ready but the seller did not honour the payment.`,
        });
      }
      if (phase.kind === 'error') {
        return c.error({ code: phase.code, message: phase.message });
      }
    }
    return;
  }

  const run = inflow.mpp.pay({
    ...buildPayPipelineInput(c, probeOptions),
    awaitPayment: c.options.interval > 0,
  });

  for await (const event of run.events) {
    if (event.type === 'short-circuited') {
      yield sanitizeDeep(noPaymentFrameFromResult(event.result));
      return;
    }
    if (event.type === 'created') {
      yield sanitizeDeep(createdFrameFromEvent(event.created, c.options.interval, c.options.maxAttempts));
      continue;
    }
    if (event.type === 'replayed') {
      yield sanitizeDeep(paidFrameFromResult(event.result, c.options.credentialFile));
      return;
    }
    if (event.type === 'rejected') {
      yield sanitizeDeep(rejectedFrameFromResult(event.result));
      return c.error({
        code: MPP_PAYMENT_NOT_ACCEPTED_CODE,
        message: `Seller rejected the credential with status ${String(event.result.responseStatus)}. The transaction was ready but the seller did not honour the payment; see the previous frame for details.`,
      });
    }
    if (event.type === 'errored') {
      return c.error({ code: event.code, message: event.message });
    }
    // 'decoded' is an intermediate phase signal; agent mode doesn't surface it.
  }
}

async function* runStatusCommand(
  c: StatusCommandContext,
  inflow: Inflow,
  authStorage: AuthStorage,
): AsyncGenerator<unknown, unknown> {
  assertSessionGuard(c, authStorage, inflow);

  if (!c.agent && !c.formatExplicit) {
    const client = await inflow.mpp.client();
    await renderInkUntilExit(
      <MppStatusView
        transactionId={c.args.transactionId}
        fetchOnce={() => client.getTransaction(c.args.transactionId)}
        interval={c.options.interval}
        maxAttempts={c.options.maxAttempts}
        timeout={c.options.timeout}
        onComplete={() => undefined}
      />,
    );
    return;
  }

  const client = await inflow.mpp.client();
  const fetchOnce = (): Promise<MppTransactionResponse> => client.getTransaction(c.args.transactionId);

  if (c.options.interval <= 0) {
    const snapshot = await fetchOnce();
    yield sanitizeDeep(toStatusFrame(snapshot, c.options.credentialFile));
    return;
  }

  // Reuse the shared `runMppStatus` poller so the agent path and the TTY view classify terminal states identically.
  // (Re-rolling `pollAsync` here previously diverged: it treated every non-`pending` state as terminal, whereas the
  // core flow only terminates on {ready, failed, expired} — so an unexpected state would exit 0 with no credential.)
  const run = runMppStatus({
    fetchOnce,
    interval: c.options.interval,
    maxAttempts: c.options.maxAttempts,
    timeout: c.options.timeout,
  });
  for await (const event of run.events) {
    if (event.type === 'snapshot') {
      yield sanitizeDeep(toStatusFrame(event.response, c.options.credentialFile));
      continue;
    }
    if (event.type === 'ready') {
      yield sanitizeDeep(toStatusFrame(event.response, c.options.credentialFile));
      return;
    }
    if (event.type === 'failed') {
      yield sanitizeDeep(toStatusFrame(event.response, c.options.credentialFile));
      return c.error({
        code: 'PAYMENT_FAILED',
        message: event.response.problem?.detail ?? event.response.problem?.title ?? 'MPP transaction failed.',
      });
    }
    if (event.type === 'expired') {
      yield sanitizeDeep(toStatusFrame(event.response, c.options.credentialFile));
      return c.error({ code: 'PAYMENT_EXPIRED', message: 'MPP transaction expired before it was ready.' });
    }
    if (event.type === 'timedOut') {
      if (event.response !== undefined) {
        yield sanitizeDeep(toStatusFrame(event.response, c.options.credentialFile));
      }
      return c.error({
        code: 'POLLING_TIMEOUT',
        message: 'Polling timed out before the transaction reached a ready state.',
        retryable: true,
      });
    }
    if (event.type === 'crashed') {
      return c.error({ code: 'PAYMENT_FAILED', message: event.message });
    }
  }
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
        cancel={() => inflow.mpp.cancel({ approvalId: c.args.approvalId }).then(() => undefined)}
        onComplete={() => undefined}
      />,
    );
    return { approval_id: c.args.approvalId, cancelled: true, note: 'best-effort; server-side state not verified' };
  }

  return inflow.mpp.cancel({ approvalId: c.args.approvalId });
}

async function runDecodeCommand(c: DecodeCommandContext): Promise<Record<string, unknown> | undefined> {
  let result: ReturnType<typeof decodeMppValue>;
  try {
    result = decodeMppValue(c.args.value);
  } catch (err) {
    return c.error({ code: 'DECODE_FAILED', message: err instanceof Error ? err.message : String(err) });
  }

  if (!c.agent && !c.formatExplicit) {
    await renderInkUntilExit(<DecodeView result={result} />);
    return undefined;
  }
  return sanitizeDeep(result as unknown as Record<string, unknown>);
}

async function runSupportedCommand(
  c: SupportedCommandContext,
  inflow: Inflow,
  authStorage: AuthStorage,
): Promise<MppSupportedResponse | undefined> {
  assertSessionGuard(c, authStorage, inflow);

  if (!c.agent && !c.formatExplicit) {
    await renderInkUntilExit(<SupportedView load={() => inflow.mpp.supported()} onComplete={() => undefined} />);
    return undefined;
  }
  const response = await inflow.mpp.supported();
  return sanitizeDeep(response);
}

async function runInspectCommand(c: InspectCommandContext): Promise<Record<string, unknown> | undefined> {
  let probeOptions: SellerProbeOptions;
  try {
    probeOptions = probeOptionsFrom(c);
  } catch (err) {
    return c.error(invalidHeaderError(err));
  }

  const deps: MppInspectPipelineDeps = {
    probeOptions,
    url: c.args.url,
    ...(c.options.paymentMethod !== undefined ? { paymentMethodFilter: c.options.paymentMethod } : {}),
    ...(c.options.intent !== undefined ? { intentFilter: c.options.intent } : {}),
    ...(c.options.currency !== undefined ? { currencyFilter: c.options.currency } : {}),
    ...(c.options.rail !== undefined ? { railFilter: c.options.rail } : {}),
  };

  if (!c.agent && !c.formatExplicit) {
    let finalPhase: MppInspectPhase | null = null;
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
      const phase = finalPhase as MppInspectPhase;
      if (phase.kind === 'error') {
        return c.error({ code: phase.code, message: phase.message });
      }
    }
    return undefined;
  }

  let finalEvent: { kind: string; payload: unknown } | null = null;
  await runMppInspectPipeline(deps, (event) => {
    if (event.type === 'errored') {
      finalEvent = { kind: 'error', payload: event };
      return;
    }
    if (event.type === 'challenges') {
      finalEvent = { kind: 'challenges', payload: event.result };
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
  if (kind === 'challenges') {
    return sanitizeDeep(buildChallengesFrame(payload as Parameters<typeof buildChallengesFrame>[0]));
  }
  return sanitizeDeep(buildInspectNoPaymentFrame(payload as Parameters<typeof buildInspectNoPaymentFrame>[0]));
}

export function createMppCli(inflow: Inflow, authStorage: AuthStorage, apiBaseUrl: string) {
  const cli = Cli.create('mpp', {
    description: 'MPP payment commands (pay, inspect, status, cancel, decode, supported).',
  });

  cli.command('pay', {
    description: 'Pay an MPP-protected resource and return the seller response.',
    args: payArgs,
    options: payOptions,
    outputPolicy: 'agent-only' as const,
    async *run(c) {
      return yield* runPayCommand(c, inflow, authStorage, apiBaseUrl);
    },
  });

  cli.command('status', {
    description: 'Poll the buyer-side state of an in-flight MPP transaction.',
    args: statusArgs,
    options: statusOptions,
    outputPolicy: 'agent-only' as const,
    async *run(c) {
      return yield* runStatusCommand(c, inflow, authStorage);
    },
  });

  cli.command('cancel', {
    description: 'Best-effort cancel of an MPP approval.',
    args: cancelArgs,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runCancelCommand(c, inflow, authStorage);
    },
  });

  cli.command('decode', {
    description: 'Decode a raw WWW-Authenticate: Payment header, or a base64url credential / receipt.',
    args: decodeArgs,
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runDecodeCommand(c);
    },
  });

  cli.command('supported', {
    description: 'List the methods the buyer can pay with - by intent, settlement rail, and currency.',
    outputPolicy: 'agent-only' as const,
    async run(c) {
      return runSupportedCommand(c, inflow, authStorage);
    },
  });

  cli.command('inspect', {
    description: "Show the seller's MPP challenge(s) for a URL. Read-only probe - no auth, no payment.",
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
  createdFrameFromEvent,
  noPaymentFrameFromResult,
  paidFrameFromResult,
  rejectedFrameFromResult,
  toStatusFrame,
};
