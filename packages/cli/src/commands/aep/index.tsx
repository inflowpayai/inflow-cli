import { randomUUID } from 'node:crypto';
import {
  AepCommandError,
  AepInspectError,
  AepPendingSignError,
  AepPendingSignResolverError,
  AepServiceReferenceError,
  buildClientAssertionClaims,
  createPlatformIdentityProvider,
  enrollService,
  grantService,
  inspectOpenApiPolicy,
  probeProtectedResource,
  resolveServiceReference,
  revokeService,
  sessionCredentialRecordFromGrantResult,
  statusService,
  type AgentServiceIdentity,
  type AepClientAssertionSigner,
  type InspectServiceResult,
  type AgentCredentialStore,
  type AgentIdentityStore,
  type AepPublicDocumentCache,
  type AgentInspectCache,
} from '@aep-foundation/agent';
import {
  AepFetchError,
  AepStorage,
  approvalUrlFor,
  parseHeaderFlags,
  runAepFetch,
  SecureStorageError,
  type AepStateStorage,
  type AuthStorage,
  type Inflow,
  sanitizeDeep,
} from '@inflowpayai/inflow-core';
import { Cli } from 'incur';
import { render } from 'ink';
import React from 'react';
import { assertSessionGuard } from '../../utils/assert-session.js';
import { persistedAepPublicDocumentCache } from '../../utils/aep-public-document-cache.js';
import { mcpTool } from '../../mcp-metadata.js';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { shellArg } from '../../utils/payment-fetch-command.js';
import {
  enrollOptions,
  fetchArgs,
  fetchOptions,
  grantOptions,
  inspectOptions,
  revokeOptions,
  serviceReferenceArgs,
} from './schema.js';
import {
  EnrollView,
  FetchView,
  GrantUnavailableView,
  GrantView,
  InspectNotAdvertisedView,
  InspectView,
  NotEnrolledView,
  PendingApprovalView,
  RevokeView,
  StatusView,
} from './views.js';

type ErrorOptions = { code: string; message: string; exitCode?: number; retryable?: boolean };
type PendingApprovalRenderer = Pick<ReturnType<typeof render>, 'clear' | 'unmount'>;
type Context = {
  agent: boolean;
  formatExplicit: boolean;
  args: { serviceReference: string };
  options: Record<string, unknown>;
  error(error: ErrorOptions): never;
};

function closePendingApprovalView(view: PendingApprovalRenderer | undefined): void {
  if (view === undefined) return;
  view.clear();
  view.unmount();
}

function paymentRequiredFrame(
  paymentRequired: { protocols: Array<'mpp' | 'x402'> } | undefined,
  finalUrl: string,
): { protocols: Array<'mpp' | 'x402'>; commands: Record<string, string> } | undefined {
  if (paymentRequired === undefined) return undefined;
  const commands = Object.fromEntries(
    paymentRequired.protocols.map((protocol) => [protocol, `${protocol} pay ${shellArg(finalUrl)}`]),
  );
  return { protocols: paymentRequired.protocols, commands };
}

async function present<T>(
  c: Pick<Context, 'agent' | 'formatExplicit'>,
  view: React.ReactElement,
  result: T,
): Promise<T> {
  if (c.agent || c.formatExplicit) {
    return result;
  }
  await renderInkUntilExit(view);
  return result;
}

function stateStorage(storage: AuthStorage): AepStateStorage {
  if ('getAepState' in storage && 'setAepState' in storage && 'clearAepState' in storage) {
    return storage as AuthStorage & AepStateStorage;
  }
  throw new TypeError('AEP storage is unavailable.');
}

async function stores(inflow: Inflow, storage: AuthStorage): Promise<AepStorage> {
  const user = await inflow.user.retrieve();
  return new AepStorage(stateStorage(storage), {
    platformOrigin: new URL(inflow.resolvedApiBaseUrl).origin,
    userId: user.userId,
  });
}

function provider(inflow: Inflow, publicDocumentCache?: AepPublicDocumentCache) {
  return createPlatformIdentityProvider({
    authenticationHeaders: () => inflow.platformAuthenticationHeaders(),
    platformUrl: inflow.resolvedApiBaseUrl,
    ...(publicDocumentCache === undefined ? {} : { publicDocumentCache }),
  });
}

function inspectError(error: unknown): ErrorOptions | undefined {
  if (error instanceof AepServiceReferenceError) {
    return { code: 'AEP_SERVICE_URL_INVALID', exitCode: 2, message: 'The AEP Service reference is invalid.' };
  }
  if (error instanceof AepInspectError) {
    const codes: Record<AepInspectError['code'], string> = {
      aborted: 'AEP_INSPECT_NETWORK_ERROR',
      http_error: 'AEP_INSPECT_HTTP_ERROR',
      invalid_json: 'AEP_INSPECT_JSON_INVALID',
      invalid_media_type: 'AEP_INSPECT_MEDIA_TYPE_INVALID',
      invalid_redirect: 'AEP_INSPECT_REDIRECT_REJECTED',
      response_too_large: 'AEP_INSPECT_RESPONSE_TOO_LARGE',
      validation_failed: 'AEP_INSPECT_DOCUMENT_INVALID',
    };
    return {
      code: codes[error.code],
      message: 'AEP Service Inspect failed.',
      retryable: error.code !== 'validation_failed',
    };
  }
  return undefined;
}

function commandError(error: unknown): ErrorOptions {
  const inspect = inspectError(error);
  if (inspect !== undefined) return inspect;
  if (error instanceof CliInputError) {
    return { code: error.code, exitCode: 2, message: error.message };
  }
  if (error instanceof AepCommandError) {
    const code = error.problem?.code;
    if (code === 'requirements_unmet')
      return { code: 'AEP_REQUIREMENTS_UNMET', message: 'The Platform cannot satisfy required Service claims.' };
    if (code === 'authorization_denied')
      return { code: 'AEP_APPROVAL_DENIED', message: 'The InFlow approval was denied.' };
    return { code: typeof code === 'string' ? code : 'AEP_SIGN_FAILED', message: 'The AEP command failed.' };
  }
  if (error instanceof SecureStorageError) {
    const vaultCode =
      error.secureStorageCode === 'vault_locked' || error.secureStorageCode === 'secure_storage_secret_missing'
        ? 'VAULT_LOCKED'
        : error.secureStorageCode === 'vault_not_initialized'
          ? 'VAULT_NOT_INITIALIZED'
          : error.secureStorageCode;
    return {
      code: vaultCode,
      message: error.message,
    };
  }
  return { code: 'AEP_INTERNAL_ERROR', message: 'The AEP command failed unexpectedly.' };
}

async function inspected(
  inflow: Inflow,
  reference: string,
  timeout: number,
  publicDocumentCache?: AepPublicDocumentCache,
): Promise<InspectServiceResult> {
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 300) {
    throw new RangeError('Inspect timeout must be between 1 and 300 seconds.');
  }
  return inflow.aep.inspect({
    serviceUrl: reference,
    signal: AbortSignal.timeout(timeout * 1000),
    ...(publicDocumentCache === undefined ? {} : { publicDocumentCache }),
  });
}

async function existingIdentity(storage: AepStorage, inspect: InspectServiceResult): Promise<AgentServiceIdentity> {
  const identity = await storage.identities().findByServiceDid(inspect.document.service.did);
  if (identity === undefined) throw new MissingIdentityError();
  return identity;
}

class MissingIdentityError extends Error {}
class ApprovalCancelledError extends Error {}
class ApprovalDeniedError extends Error {}
class PendingAepApproval extends Error {
  constructor(
    readonly approvalId: string,
    readonly retryAfterSeconds: number,
  ) {
    super('AEP approval is pending.');
  }
}
class CliInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function approvalStatus(inflow: Inflow, approvalId: string): Promise<string> {
  const response = await fetch(new URL(`/v1/approvals/${approvalId}`, inflow.resolvedApiBaseUrl), {
    headers: await inflow.platformAuthenticationHeaders(),
  });
  if (!response.ok) throw new Error('Approval status request failed.');
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || typeof (body as Record<string, unknown>)['status'] !== 'string') {
    throw new Error('Approval status response is invalid.');
  }
  return (body as Record<string, string>)['status'] as string;
}

async function cancelApproval(inflow: Inflow, approvalId: string): Promise<void> {
  await fetch(new URL(`/v1/approvals/${approvalId}/cancel`, inflow.resolvedApiBaseUrl), {
    headers: await inflow.platformAuthenticationHeaders(),
    method: 'POST',
  }).catch(() => undefined);
}

async function approvalSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new ApprovalCancelledError();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new ApprovalCancelledError());
      },
      { once: true },
    );
  });
}

async function approvedAssertion(
  inflow: Inflow,
  identity: AgentServiceIdentity,
  inspect: InspectServiceResult,
  command: 'enroll' | 'grant',
  platformContext: Record<string, unknown>,
  options: {
    approvalId?: string;
    deferPending?: boolean;
    interval?: number;
    maxAttempts: number;
    signal?: AbortSignal;
    timeout: number;
  },
  publicDocumentCache?: AepPublicDocumentCache,
  onPending?: (approvalId: string) => void,
): Promise<{ assertion: string; context: Record<string, unknown> }> {
  const signer = await provider(inflow, publicDocumentCache).signerFor(identity);
  let approvalId = options.approvalId;
  let interval = options.interval ?? 5;
  if (approvalId === undefined) {
    const initial = buildClientAssertionClaims({
      agentDid: identity.agentDid,
      command,
      jti: randomUUID,
      serviceDid: inspect.document.service.did,
    });
    const result = await signer(initial, {
      command,
      idempotencyKey: randomUUID(),
      platformContext,
      serviceDid: inspect.document.service.did,
      signingAlgorithms: identity.signingAlgorithms,
    });
    if (typeof result === 'string' || result.status === 'completed') {
      return {
        assertion: typeof result === 'string' ? result : result.clientAssertion,
        context: typeof result === 'string' ? {} : (result.platformContext ?? {}),
      };
    }
    const pendingApprovalId = result.platformContext?.['approval_id'];
    if (typeof pendingApprovalId !== 'string') throw new Error('Platform Sign did not return an approval identifier.');
    if (options.deferPending === true) throw new PendingAepApproval(pendingApprovalId, result.retryAfterSeconds);
    approvalId = pendingApprovalId;
    interval = options.interval ?? result.retryAfterSeconds;
  }
  onPending?.(approvalId);
  if (!Number.isFinite(interval) || interval <= 0) throw new RangeError('Approval interval must be positive.');
  const deadline = Date.now() + options.timeout * 1000;
  let attempts = 0;
  while (Date.now() < deadline && (options.maxAttempts === 0 || attempts < options.maxAttempts)) {
    if (options.signal?.aborted === true) throw new ApprovalCancelledError();
    const status = await approvalStatus(inflow, approvalId);
    if (status === 'APPROVED') {
      const finalClaims = buildClientAssertionClaims({
        agentDid: identity.agentDid,
        command,
        jti: randomUUID,
        serviceDid: inspect.document.service.did,
      });
      const completed = await signer(finalClaims, {
        command,
        idempotencyKey: randomUUID(),
        platformContext: { approval_id: approvalId },
        serviceDid: inspect.document.service.did,
        signingAlgorithms: identity.signingAlgorithms,
      });
      if (typeof completed === 'string') return { assertion: completed, context: {} };
      if (completed.status === 'completed')
        return { assertion: completed.clientAssertion, context: completed.platformContext ?? {} };
    }
    if (status === 'DECLINED') throw new ApprovalDeniedError();
    if (status === 'CANCELLED') throw new ApprovalCancelledError();
    attempts += 1;
    await approvalSleep(interval * 1000, options.signal);
  }
  throw new ApprovalTimeoutError();
}

class ApprovalTimeoutError extends Error {}
class ApprovalServerError extends Error {}

type OpenApiPolicy = Awaited<ReturnType<typeof inspectOpenApiPolicy>>;

function openApiPolicyFrame(policy: OpenApiPolicy): Record<string, unknown> {
  return {
    accepted_methods: policy.methods,
    freshness: policy.freshness,
    ...(policy.matchedOperation === undefined
      ? {}
      : {
          matched_operation: {
            method: policy.matchedOperation.method,
            path_template: policy.matchedOperation.pathTemplate,
          },
        }),
    ...(policy.strictSlashSuggestion === undefined ? {} : { strict_slash_suggestion: policy.strictSlashSuggestion }),
    state: policy.state,
  };
}

function pendingEnrollFrame(
  approval: { approvalId: string; retryAfterSeconds: number },
  inflow: Inflow,
  serviceDid: string,
): Record<string, unknown> {
  const interval = approval.retryAfterSeconds;
  return sanitizeDeep({
    approval_id: approval.approvalId,
    approval_url: approvalUrlFor(inflow.resolvedApiBaseUrl, approval.approvalId),
    instruction:
      'Present the approval_url to the user and ask them to approve in the InFlow mobile app or dashboard. Then call AEP enroll again with the approval id.',
    service_did: serviceDid,
    state: 'pending',
    retry_after_seconds: interval,
    _next: {
      poll_interval_seconds: interval,
      until: 'enrollment completes',
    },
  });
}

function pendingGrantFrame(
  approval: { approvalId: string; retryAfterSeconds: number },
  inflow: Inflow,
  serviceDid: string,
  grantType: string,
): Record<string, unknown> {
  const interval = approval.retryAfterSeconds;
  return sanitizeDeep({
    approval_id: approval.approvalId,
    approval_url: approvalUrlFor(inflow.resolvedApiBaseUrl, approval.approvalId),
    grant_type: grantType,
    instruction:
      'Present the approval_url to the user and ask them to approve in the InFlow mobile app or dashboard. Then call AEP grant again with the approval id.',
    service_did: serviceDid,
    state: 'pending',
    retry_after_seconds: interval,
    _next: {
      poll_interval_seconds: interval,
      until: 'credential grant completes',
    },
  });
}

interface FetchContext extends Omit<Context, 'args'> {
  args: { resourceUrl: string };
}

function lazyStores(
  inflow: Inflow,
  authStorage: AuthStorage,
): {
  credentials: AgentCredentialStore;
  identities: AgentIdentityStore;
  inspectCache: AgentInspectCache;
} {
  let pending: Promise<AepStorage> | undefined;
  const get = (): Promise<AepStorage> => (pending ??= stores(inflow, authStorage));
  return {
    credentials: {
      deleteCredential: async (serviceDid, credentialId) =>
        (await get()).credentials().deleteCredential(serviceDid, credentialId),
      findCredential: async (serviceDid, credentialId) =>
        (await get()).credentials().findCredential(serviceDid, credentialId),
      findUsableCredential: async (serviceDid, now) =>
        (await get()).credentials().findUsableCredential(serviceDid, now),
      listCredentials: async (serviceDid) => (await get()).credentials().listCredentials(serviceDid),
      saveCredential: async (record) => (await get()).credentials().saveCredential(record),
    },
    identities: {
      findByServiceDid: async (serviceDid) => (await get()).identities().findByServiceDid(serviceDid),
      saveIdentity: async (identity) => (await get()).identities().saveIdentity(identity),
    },
    inspectCache: {
      delete: async (serviceUrl) => (await get()).inspectCache().delete(serviceUrl),
      get: async (serviceUrl) => (await get()).inspectCache().get(serviceUrl),
      set: async (serviceUrl, result) => (await get()).inspectCache().set(serviceUrl, result),
    },
  };
}

async function runFetch(c: FetchContext, inflow: Inflow, authStorage: AuthStorage): Promise<Record<string, unknown>> {
  const options = c.options as {
    credentialId?: string;
    data?: string;
    grantType?: string;
    header: string[];
    interval?: number;
    maxRedirects: number;
    maxResponseBytes: number;
    method: string;
    outputFile?: string;
    showBody: boolean;
    timeout: number;
  };
  if (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout > 900)
    return c.error({
      code: 'AEP_FETCH_TIMEOUT_INVALID',
      exitCode: 2,
      message: 'Timeout must be between 1 and 900 seconds.',
    });
  let headers: Record<string, string>;
  try {
    headers = parseHeaderFlags(options.header);
  } catch (error) {
    return c.error({
      code: 'INVALID_HEADER',
      exitCode: 2,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const controller = new AbortController();
  let waitingView: PendingApprovalRenderer | undefined;
  const publicDocumentCache = persistedAepPublicDocumentCache(authStorage);
  const platform = provider(inflow, publicDocumentCache);
  const storage = lazyStores(inflow, authStorage);
  try {
    const result = await runAepFetch({
      agentOptions: {
        credentialStore: storage.credentials,
        identityProvider: {
          getOrCreateIdentity: async (input) => {
            const recovered = await platform.findIdentityByServiceDid(input.serviceDid);
            if (recovered === undefined) throw new MissingIdentityError();
            return recovered;
          },
          signerFor: (identity) => platform.signerFor(identity),
        },
        identityStore: storage.identities,
        inspectCache: storage.inspectCache,
        ...(publicDocumentCache === undefined ? {} : { publicDocumentCache }),
        platformContextProvider: ({ command, grantType, requestedScopes }) =>
          command === 'grant' && grantType !== undefined
            ? {
                grant_type: grantType,
                ...(requestedScopes === undefined || requestedScopes.length === 0
                  ? {}
                  : { requested_scopes: [...requestedScopes] }),
              }
            : undefined,
        pendingSignResolver: async (input) => {
          const approvalId = input.pending.platformContext?.['approval_id'];
          if (typeof approvalId !== 'string')
            throw new AepPendingSignResolverError('Platform Sign omitted the approval identifier.', 'server_error');
          if (!c.agent && !c.formatExplicit) {
            waitingView = render(
              <PendingApprovalView
                approvalId={approvalId}
                approvalUrl={approvalUrlFor(inflow.resolvedApiBaseUrl, approvalId)}
                onCancel={() => {
                  controller.abort();
                  return cancelApproval(inflow, approvalId);
                }}
              />,
              { exitOnCtrlC: false },
            );
          }
          const interval = options.interval ?? input.pending.retryAfterSeconds;
          if (!Number.isFinite(interval) || interval <= 0)
            throw new AepPendingSignResolverError('Approval interval must be positive.', 'server_error');
          const deadline = Date.now() + options.timeout * 1000;
          while (Date.now() < deadline) {
            if (input.signal?.aborted === true) throw new ApprovalCancelledError();
            let status: string;
            try {
              status = await approvalStatus(inflow, approvalId);
            } catch (error) {
              throw new ApprovalServerError(error instanceof Error ? error.message : String(error));
            }
            if (status === 'APPROVED') {
              const completed = await input.continueSign();
              if (completed.status === 'completed') return completed;
            } else if (status === 'DECLINED') {
              throw new ApprovalDeniedError();
            } else if (status === 'CANCELLED') {
              controller.abort();
              throw new ApprovalCancelledError();
            }
            await approvalSleep(interval * 1000, input.signal);
          }
          throw new ApprovalTimeoutError();
        },
      },
      ...(options.data === undefined ? {} : { body: options.data }),
      ...(options.credentialId === undefined ? {} : { credentialId: options.credentialId }),
      ...(options.grantType === undefined ? {} : { grantType: options.grantType }),
      headers,
      maxRedirects: options.maxRedirects,
      maxResponseBytes: options.maxResponseBytes,
      method: options.method,
      ...(options.outputFile === undefined ? {} : { outputFile: options.outputFile }),
      showBody: options.showBody,
      signal: controller.signal,
      timeoutMs: options.timeout * 1000,
      url: c.args.resourceUrl,
    });
    closePendingApprovalView(waitingView);
    waitingView = undefined;
    const paymentRequired = paymentRequiredFrame(result.paymentRequired, result.finalUrl);
    const frame = sanitizeDeep({
      authentication: {
        outcome: result.authentication.outcome,
        method: result.authentication.method,
        ...(result.authentication.outcome === 'authenticated' && result.authentication.operation !== undefined
          ? { operation: result.authentication.operation }
          : {}),
        ...(result.authentication.outcome === 'authenticated' && result.authentication.credentialId !== undefined
          ? { credential_id: result.authentication.credentialId }
          : {}),
        ...(result.authentication.outcome === 'authenticated' && result.authentication.grantType !== undefined
          ? { grant_type: result.authentication.grantType }
          : {}),
      },
      ...(result.body !== undefined ? { body: result.body } : {}),
      ...(result.bodyBase64 !== undefined ? { body_base64: result.bodyBase64 } : {}),
      ...(result.contentType === undefined ? {} : { content_type: result.contentType }),
      final_url: result.finalUrl,
      ...(result.outputSavedTo === undefined ? {} : { output_saved_to: result.outputSavedTo }),
      ...(paymentRequired === undefined ? {} : { payment_required: paymentRequired }),
      redirects: { occurred: result.redirected },
      requested_url: result.requestedUrl,
      response_size_bytes: result.responseSizeBytes,
      ...(result.serviceDid === undefined ? {} : { service_did: result.serviceDid }),
      status: result.status,
    });
    return present(
      c,
      <FetchView
        authentication={result.authentication.method ?? 'Not required'}
        {...(result.body === undefined ? {} : { body: result.body })}
        {...(result.contentType === undefined ? {} : { contentType: result.contentType })}
        finalUrl={result.finalUrl}
        onComplete={() => undefined}
        {...(paymentRequired === undefined
          ? {}
          : {
              paymentRequired: {
                protocols: paymentRequired.protocols,
                commands: Object.values(paymentRequired.commands),
              },
            })}
        responseSizeBytes={result.responseSizeBytes}
        status={result.status}
      />,
      frame,
    );
  } catch (error) {
    closePendingApprovalView(waitingView);
    if (
      error instanceof MissingIdentityError ||
      (error instanceof AepCommandError &&
        (error.problem?.code === 'not_recognized' || error.problem?.code === 'agent_identity_not_found'))
    )
      return c.error({
        code: 'AEP_NOT_ENROLLED',
        message: 'Not enrolled with this Service. Use `inflow aep enroll <service>` first.',
      });
    if (error instanceof ApprovalDeniedError)
      return c.error({ code: 'AEP_APPROVAL_DENIED', message: 'The InFlow approval was declined.' });
    if (error instanceof ApprovalCancelledError || controller.signal.aborted)
      return c.error({ code: 'APPROVAL_CANCELLED', message: 'The AEP approval was cancelled.' });
    if (error instanceof ApprovalTimeoutError)
      return c.error({ code: 'AEP_APPROVAL_TIMEOUT', message: 'The InFlow approval timed out.' });
    if (error instanceof ApprovalServerError)
      return c.error({
        code: 'AEP_APPROVAL_SERVER_ERROR',
        message: 'The InFlow approval status request failed.',
        retryable: true,
      });
    if (error instanceof AepFetchError) return c.error({ code: error.code, message: error.message });
    return c.error(commandError(error));
  }
}

async function directAssertion(
  inflow: Inflow,
  identity: AgentServiceIdentity,
  inspect: InspectServiceResult,
  command: 'revoke' | 'status',
  publicDocumentCache?: AepPublicDocumentCache,
): Promise<string> {
  const signer: AepClientAssertionSigner = await provider(inflow, publicDocumentCache).signerFor(identity);
  const claims = buildClientAssertionClaims({
    agentDid: identity.agentDid,
    command,
    jti: randomUUID,
    serviceDid: inspect.document.service.did,
  });
  const result = await signer(claims, {
    command,
    idempotencyKey: randomUUID(),
    serviceDid: inspect.document.service.did,
    signingAlgorithms: identity.signingAlgorithms,
  });
  if (typeof result === 'string') return result;
  if (result.status === 'completed') return result.clientAssertion;
  throw new AepPendingSignError(result);
}

async function runInspect(c: Context, inflow: Inflow, authStorage?: AuthStorage): Promise<Record<string, unknown>> {
  let serviceUrl: URL;
  try {
    serviceUrl = resolveServiceReference(c.args.serviceReference);
  } catch (error) {
    return c.error(commandError(error));
  }
  try {
    const options = c.options as { data?: string; header?: string[]; method?: string; timeout: number };
    const timeout = options.timeout;
    const cache = authStorage === undefined ? undefined : persistedAepPublicDocumentCache(authStorage);
    const result = await inspected(inflow, c.args.serviceReference, timeout, cache);
    let resourceAuthentication = 'Not checked';
    let openApiPolicy: OpenApiPolicy | undefined;
    let resourceAuthenticationFrame: Record<string, unknown> = { result: 'not-checked', source: 'not_checked' };
    if (!c.args.serviceReference.startsWith('did:')) {
      let headers: Record<string, string>;
      try {
        headers = parseHeaderFlags(options.header ?? []);
      } catch (error) {
        throw new CliInputError('INVALID_HEADER', error instanceof Error ? error.message : String(error));
      }
      const resourceUrl = /^[a-z][a-z0-9+.-]*:/i.test(c.args.serviceReference)
        ? c.args.serviceReference
        : `https://${c.args.serviceReference}`;
      try {
        openApiPolicy = await inspectOpenApiPolicy({
          inspect: result,
          method: options.method ?? 'GET',
          ...(cache === undefined ? {} : { publicDocumentCache: cache }),
          signal: AbortSignal.timeout(timeout * 1000),
          url: resourceUrl,
        });
      } catch {
        openApiPolicy = undefined;
      }
      if (openApiPolicy?.state === 'required' || openApiPolicy?.state === 'public') {
        resourceAuthentication = openApiPolicy.state === 'required' ? 'AEP authenticatable' : 'Not required';
        resourceAuthenticationFrame = {
          openapi: openApiPolicyFrame(openApiPolicy),
          result: openApiPolicy.state === 'required' ? 'aep-authenticatable' : 'not-required',
          source: 'openapi',
        };
      } else {
        const probe = await probeProtectedResource({
          ...(options.data === undefined ? {} : { body: options.data }),
          headers,
          method: options.method ?? 'GET',
          signal: AbortSignal.timeout(timeout * 1000),
          url: resourceUrl,
        });
        resourceAuthentication =
          probe.classification === 'success'
            ? 'Not required'
            : probe.classification === 'aep-challenge'
              ? 'AEP authenticatable'
              : probe.classification === 'unrelated-authentication'
                ? 'Other authentication required'
                : 'Not required';
        resourceAuthenticationFrame = {
          ...(openApiPolicy === undefined ? {} : { openapi: openApiPolicyFrame(openApiPolicy) }),
          result: resourceAuthentication.toLowerCase().replaceAll(' ', '-'),
          source: 'anonymous_probe',
          status: probe.response.status,
        };
      }
    }
    const frame = sanitizeDeep({
      document: result.document,
      resolved: {
        enroll: String(result.commandUrl('enroll')),
        grant: String(result.commandUrl('grant')),
        revoke: String(result.commandUrl('revoke')),
        service_url: String(result.finalUrl ?? result.inspectUrl).replace('/.well-known/aep', ''),
        status: String(result.commandUrl('status')),
      },
      response: {
        ...(result.cacheControl === undefined ? {} : { cache_control: result.cacheControl }),
        ...(result.etag === undefined ? {} : { etag: result.etag }),
      },
      resource_authentication: resourceAuthenticationFrame,
      schema_version: 1,
    });
    return present(
      c,
      <InspectView
        document={result.document}
        onComplete={() => undefined}
        {...(openApiPolicy === undefined ? {} : { openApiPolicy })}
        resourceAuthentication={resourceAuthentication}
        serviceUrl={String(result.finalUrl ?? result.inspectUrl).replace('/.well-known/aep', '')}
      />,
      frame,
    );
  } catch (error) {
    if (error instanceof AepInspectError && error.code === 'http_error' && error.status === 404) {
      const frame = sanitizeDeep({
        outcome: 'not-advertised',
        schema_version: 1,
        service_url: String(serviceUrl),
        status: 404,
      });
      return present(
        c,
        <InspectNotAdvertisedView onComplete={() => undefined} serviceUrl={String(serviceUrl)} />,
        frame,
      );
    }
    return c.error(commandError(error));
  }
}

async function runEnroll(c: Context, inflow: Inflow, authStorage: AuthStorage): Promise<Record<string, unknown>> {
  assertSessionGuard(c, authStorage, inflow);
  let waitingView: PendingApprovalRenderer | undefined;
  const approvalController = new AbortController();
  try {
    const options = c.options as { approvalId?: string; interval?: number; maxAttempts: number; timeout: number };
    if (options.interval !== undefined && options.interval <= 0)
      throw new CliInputError('AEP_INTERNAL_ERROR', 'Approval interval must be positive.');
    if (options.timeout <= 0 || options.timeout > 900)
      throw new CliInputError('AEP_INTERNAL_ERROR', 'Approval timeout must be between 1 and 900 seconds.');
    const publicDocumentCache = persistedAepPublicDocumentCache(authStorage);
    const aepStorage = await stores(inflow, authStorage);
    const inspect = await inspected(inflow, c.args.serviceReference, 30, publicDocumentCache);
    const identityStore = aepStorage.identities();
    const identityProvider = provider(inflow, publicDocumentCache);
    await aepStorage.credentials().listCredentials(inspect.document.service.did);
    let identity = await identityStore.findByServiceDid(inspect.document.service.did);
    if (identity === undefined) {
      identity = await identityProvider.getOrCreateIdentity({
        inspect: inspect.document,
        serviceDid: inspect.document.service.did,
        serviceUrl: String(inspect.finalUrl ?? inspect.inspectUrl),
      });
      await identityStore.saveIdentity(identity);
    }
    let recoveredStaleIdentity = false;
    for (;;) {
      try {
        const assertion = await directAssertion(inflow, identity, inspect, 'status', publicDocumentCache);
        const status = await statusService({
          agentDid: identity.agentDid,
          clientAssertion: assertion,
          inspect,
          serviceUrl: c.args.serviceReference,
        });
        return present(
          c,
          <EnrollView
            onComplete={() => undefined}
            serviceDid={inspect.document.service.did}
            status={status.body.status}
          />,
          sanitizeDeep(status.body),
        );
      } catch (error) {
        if (!(error instanceof AepCommandError)) throw error;
        if (error.problem?.code === 'not_recognized') break;
        if (error.problem?.code !== 'agent_identity_not_found' || recoveredStaleIdentity) throw error;
        identity = await identityProvider.getOrCreateIdentity({
          inspect: inspect.document,
          serviceDid: inspect.document.service.did,
          serviceUrl: String(inspect.finalUrl ?? inspect.inspectUrl),
        });
        await identityStore.saveIdentity(identity);
        recoveredStaleIdentity = true;
      }
    }
    const claims = {
      optional: inspect.document.claims?.optional ?? [],
      preferred: inspect.document.claims?.preferred ?? [],
      required: inspect.document.claims?.required ?? [],
    };
    let signed: { assertion: string; context: Record<string, unknown> };
    try {
      signed = await approvedAssertion(
        inflow,
        identity,
        inspect,
        'enroll',
        { claims },
        {
          ...options,
          deferPending:
            (c.agent || c.formatExplicit) && options.approvalId === undefined && options.interval === undefined,
          signal: approvalController.signal,
        },
        publicDocumentCache,
        (approvalId) => {
          if (!c.agent && !c.formatExplicit) {
            waitingView = render(
              <PendingApprovalView
                approvalId={approvalId}
                approvalUrl={approvalUrlFor(inflow.resolvedApiBaseUrl, approvalId)}
                onCancel={() => {
                  approvalController.abort();
                  return cancelApproval(inflow, approvalId);
                }}
              />,
              { exitOnCtrlC: false },
            );
          }
        },
      );
    } catch (error) {
      if (error instanceof PendingAepApproval) {
        return present(
          c,
          <PendingApprovalView
            approvalId={error.approvalId}
            approvalUrl={approvalUrlFor(inflow.resolvedApiBaseUrl, error.approvalId)}
            onCancel={() => cancelApproval(inflow, error.approvalId)}
          />,
          pendingEnrollFrame(
            { approvalId: error.approvalId, retryAfterSeconds: error.retryAfterSeconds },
            inflow,
            inspect.document.service.did,
          ),
        );
      }
      throw error;
    }
    closePendingApprovalView(waitingView);
    waitingView = undefined;
    const approvedClaims = signed.context['approved_claims'];
    const response = await enrollService({
      agentDid: identity.agentDid,
      claims:
        typeof approvedClaims === 'object' && approvedClaims !== null
          ? (approvedClaims as Record<string, unknown>)
          : {},
      clientAssertion: signed.assertion,
      idempotencyKey: randomUUID(),
      inspect,
      serviceUrl: c.args.serviceReference,
    });
    return present(
      c,
      <EnrollView
        onComplete={() => undefined}
        serviceDid={inspect.document.service.did}
        status={response.body.status}
      />,
      sanitizeDeep(response.body),
    );
  } catch (error) {
    closePendingApprovalView(waitingView);
    if (error instanceof ApprovalCancelledError)
      return c.error({ code: 'APPROVAL_CANCELLED', message: 'The AEP approval was cancelled.' });
    if (error instanceof ApprovalDeniedError)
      return c.error({ code: 'AEP_APPROVAL_DENIED', message: 'The InFlow approval was declined.' });
    if (error instanceof ApprovalTimeoutError)
      return c.error({ code: 'AEP_APPROVAL_TIMEOUT', message: 'The InFlow approval timed out.' });
    return c.error(commandError(error));
  }
}

async function runStatus(c: Context, inflow: Inflow, authStorage: AuthStorage): Promise<Record<string, unknown>> {
  assertSessionGuard(c, authStorage, inflow);
  try {
    const aepStorage = await stores(inflow, authStorage);
    const publicDocumentCache = persistedAepPublicDocumentCache(authStorage);
    const inspect = await inspected(inflow, c.args.serviceReference, 30, publicDocumentCache);
    const identity = await aepStorage.identities().findByServiceDid(inspect.document.service.did);
    if (identity === undefined) {
      const frame = { enrolled: false, local: { grants: [] }, service: null };
      return present(
        c,
        <NotEnrolledView onComplete={() => undefined} serviceDid={inspect.document.service.did} />,
        frame,
      );
    }
    const assertion = await directAssertion(inflow, identity, inspect, 'status', publicDocumentCache);
    const response = await statusService({
      agentDid: identity.agentDid,
      clientAssertion: assertion,
      inspect,
      serviceUrl: c.args.serviceReference,
    });
    const grants = await aepStorage.credentials().listCredentials(inspect.document.service.did);
    const localGrants = grants
      .map((grant) => ({
        credential_id: grant.credentialId,
        ...(grant.expiresAt === undefined ? {} : { expires_at: grant.expiresAt }),
        grant_type: grant.grantType,
        scopes: Array.isArray(grant.credential['scopes']) ? grant.credential['scopes'] : [],
        status: 'active' as const,
        usable: true,
      }))
      .sort((left, right) =>
        `${left.grant_type}:${left.credential_id}`.localeCompare(`${right.grant_type}:${right.credential_id}`),
      );
    const availableGrantTypes = inspect.document.commands.grant_types ?? [];
    const frame = sanitizeDeep({
      local: { authentication: 'aep-jwt', available_grant_types: availableGrantTypes, grants: localGrants },
      service: response.body,
    });
    return present(
      c,
      <StatusView
        availableGrantTypes={availableGrantTypes}
        grants={localGrants}
        onComplete={() => undefined}
        service={response.body}
        serviceDid={inspect.document.service.did}
      />,
      frame,
    );
  } catch (error) {
    if (
      error instanceof AepCommandError &&
      (error.problem?.code === 'agent_identity_not_found' || error.problem?.code === 'not_recognized')
    )
      return c.error({
        code: 'AEP_NOT_ENROLLED',
        message:
          'The Service does not recognize the locally stored Agent identity. Use `inflow aep enroll <service>` to enroll again.',
      });
    return c.error(commandError(error));
  }
}

async function runGrant(c: Context, inflow: Inflow, authStorage: AuthStorage): Promise<Record<string, unknown>> {
  assertSessionGuard(c, authStorage, inflow);
  let waitingView: PendingApprovalRenderer | undefined;
  const approvalController = new AbortController();
  try {
    const options = c.options as {
      approvalId?: string;
      grantType?: string;
      interval?: number;
      scope: string[];
      timeout?: number;
    };
    const timeout = options.timeout ?? 900;
    if (options.interval !== undefined && options.interval <= 0)
      throw new CliInputError('AEP_INTERNAL_ERROR', 'Approval interval must be positive.');
    if (timeout <= 0 || timeout > 900)
      throw new CliInputError('AEP_INTERNAL_ERROR', 'Approval timeout must be between 1 and 900 seconds.');
    const aepStorage = await stores(inflow, authStorage);
    const publicDocumentCache = persistedAepPublicDocumentCache(authStorage);
    const inspect = await inspected(inflow, c.args.serviceReference, 30, publicDocumentCache);
    const advertisedGrantTypes = inspect.document.commands.grant_types ?? [];
    if (options.grantType === undefined && advertisedGrantTypes.length === 0) {
      const frame = { authentication: 'aep-jwt', grant_available: false, granted: false };
      return present(c, <GrantUnavailableView onComplete={() => undefined} />, frame);
    }
    const grantType = options.grantType ?? advertisedGrantTypes[0];
    if (grantType === undefined || !advertisedGrantTypes.includes(grantType))
      throw new CliInputError(
        'AEP_GRANT_TYPE_UNSUPPORTED',
        'The requested grant type is not advertised by this Service.',
      );
    const identityStore = aepStorage.identities();
    const identity = await identityStore.findByServiceDid(inspect.document.service.did);
    if (identity === undefined) {
      return present(c, <NotEnrolledView onComplete={() => undefined} serviceDid={inspect.document.service.did} />, {
        enrolled: false,
        granted: false,
        service_did: inspect.document.service.did,
      });
    }
    try {
      const statusAssertion = await directAssertion(inflow, identity, inspect, 'status', publicDocumentCache);
      await statusService({
        agentDid: identity.agentDid,
        clientAssertion: statusAssertion,
        inspect,
        serviceUrl: c.args.serviceReference,
      });
    } catch (error) {
      if (!(error instanceof AepCommandError) || error.problem?.code !== 'not_recognized') throw error;
      return present(c, <NotEnrolledView onComplete={() => undefined} serviceDid={inspect.document.service.did} />, {
        enrolled: false,
        granted: false,
        service_did: inspect.document.service.did,
      });
    }
    const scopes = [...new Set(options.scope)];
    let signed: { assertion: string; context: Record<string, unknown> };
    try {
      signed = await approvedAssertion(
        inflow,
        identity,
        inspect,
        'grant',
        { grant_type: grantType, ...(scopes.length === 0 ? {} : { requested_scopes: scopes }) },
        {
          ...(options.interval === undefined ? {} : { interval: options.interval }),
          ...(options.approvalId === undefined ? {} : { approvalId: options.approvalId }),
          deferPending:
            (c.agent || c.formatExplicit) && options.approvalId === undefined && options.interval === undefined,
          maxAttempts: 0,
          signal: approvalController.signal,
          timeout,
        },
        publicDocumentCache,
        (approvalId) => {
          if (!c.agent && !c.formatExplicit) {
            waitingView = render(
              <PendingApprovalView
                approvalId={approvalId}
                approvalUrl={approvalUrlFor(inflow.resolvedApiBaseUrl, approvalId)}
                onCancel={() => {
                  approvalController.abort();
                  return cancelApproval(inflow, approvalId);
                }}
              />,
              { exitOnCtrlC: false },
            );
          }
        },
      );
    } catch (error) {
      if (error instanceof PendingAepApproval) {
        return present(
          c,
          <PendingApprovalView
            approvalId={error.approvalId}
            approvalUrl={approvalUrlFor(inflow.resolvedApiBaseUrl, error.approvalId)}
            onCancel={() => cancelApproval(inflow, error.approvalId)}
          />,
          pendingGrantFrame(
            { approvalId: error.approvalId, retryAfterSeconds: error.retryAfterSeconds },
            inflow,
            inspect.document.service.did,
            grantType,
          ),
        );
      }
      throw error;
    }
    closePendingApprovalView(waitingView);
    waitingView = undefined;
    const response = await grantService({
      agentDid: identity.agentDid,
      clientAssertion: signed.assertion,
      grantType,
      idempotencyKey: randomUUID(),
      inspect,
      requestedScopes: scopes,
      serviceUrl: c.args.serviceReference,
    });
    const record = sessionCredentialRecordFromGrantResult(response, {
      grantType,
      inspect,
      serviceUrl: c.args.serviceReference,
    });
    await aepStorage.credentials().saveCredential(record);
    const frame = sanitizeDeep({
      credential_id: record.credentialId,
      expires_at: record.expiresAt,
      grant_type: record.grantType,
      granted: true,
      service_did: inspect.document.service.did,
      scopes: Array.isArray(record.credential['scopes']) ? record.credential['scopes'] : [],
    });
    return present(
      c,
      <GrantView
        credentialId={record.credentialId}
        {...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt })}
        grantType={record.grantType}
        onComplete={() => undefined}
        scopes={Array.isArray(record.credential['scopes']) ? record.credential['scopes'] : []}
        serviceDid={inspect.document.service.did}
      />,
      frame,
    );
  } catch (error) {
    closePendingApprovalView(waitingView);
    if (error instanceof ApprovalCancelledError)
      return c.error({ code: 'APPROVAL_CANCELLED', message: 'The AEP approval was cancelled.' });
    if (error instanceof ApprovalDeniedError)
      return c.error({ code: 'AEP_APPROVAL_DENIED', message: 'The InFlow approval was declined.' });
    if (error instanceof ApprovalTimeoutError)
      return c.error({ code: 'AEP_APPROVAL_TIMEOUT', message: 'The InFlow approval timed out.' });
    return c.error(commandError(error));
  }
}

async function runRevoke(c: Context, inflow: Inflow, authStorage: AuthStorage): Promise<Record<string, unknown>> {
  assertSessionGuard(c, authStorage, inflow);
  try {
    const options = c.options as { credentialId?: string; grantType?: string };
    if (options.credentialId !== undefined && options.grantType !== undefined)
      throw new CliInputError('AEP_INTERNAL_ERROR', 'Use either credential id or grant type, not both.');
    const aepStorage = await stores(inflow, authStorage);
    const publicDocumentCache = persistedAepPublicDocumentCache(authStorage);
    const inspect = await inspected(inflow, c.args.serviceReference, 30, publicDocumentCache);
    const identity = await existingIdentity(aepStorage, inspect);
    const assertion = await directAssertion(inflow, identity, inspect, 'revoke', publicDocumentCache);
    const base = {
      agentDid: identity.agentDid,
      clientAssertion: assertion,
      idempotencyKey: randomUUID(),
      inspect,
      serviceUrl: c.args.serviceReference,
    };
    const selector =
      options.credentialId === undefined && options.grantType === undefined
        ? { allGrantTypes: true as const }
        : options.credentialId === undefined
          ? { grantType: options.grantType as string }
          : { credentialId: options.credentialId };
    if ('allGrantTypes' in selector) await revokeService({ ...base, allGrantTypes: true });
    else if ('credentialId' in selector) await revokeService({ ...base, credentialId: selector.credentialId });
    else await revokeService({ ...base, grantType: selector.grantType });
    aepStorage.deleteCredentials(inspect.document.service.did, selector);
    const frame = sanitizeDeep({
      revoked: true,
      ...('allGrantTypes' in selector
        ? { all_grant_types: true }
        : 'credentialId' in selector
          ? { credential_id: selector.credentialId }
          : { grant_type: selector.grantType }),
    });
    const selectorLabel =
      'allGrantTypes' in selector
        ? 'all grant types'
        : 'credentialId' in selector
          ? `credential ${selector.credentialId}`
          : `grant type ${selector.grantType}`;
    return present(c, <RevokeView onComplete={() => undefined} selector={selectorLabel} />, frame);
  } catch (error) {
    if (error instanceof MissingIdentityError)
      return c.error({ code: 'AEP_IDENTITY_NOT_FOUND', message: 'No local AEP identity exists for this Service.' });
    return c.error(commandError(error));
  }
}

export function createAepCli(inflow: Inflow, authStorage: AuthStorage) {
  const cli = Cli.create('aep', { description: 'Agent Enrollment Protocol Service commands.' });
  cli.command('inspect', {
    args: serviceReferenceArgs,
    description: 'Inspect an AEP Service without authentication.',
    mcp: mcpTool('aep_inspect'),
    options: inspectOptions,
    outputPolicy: 'agent-only' as const,
    run: (c) => runInspect(c, inflow, authStorage),
  });
  cli.command('enroll', {
    args: serviceReferenceArgs,
    description: 'Enroll with an AEP Service.',
    mcp: mcpTool('aep_enroll'),
    options: enrollOptions,
    outputPolicy: 'agent-only' as const,
    run: (c) => runEnroll(c, inflow, authStorage),
  });
  cli.command('fetch', {
    args: fetchArgs,
    description: 'Fetch a resource with AEP authentication when challenged.',
    mcp: mcpTool('aep_fetch'),
    options: fetchOptions,
    outputPolicy: 'agent-only' as const,
    run: (c) => runFetch(c, inflow, authStorage),
  });
  cli.command('status', {
    args: serviceReferenceArgs,
    description: 'Get AEP Service lifecycle status.',
    mcp: mcpTool('aep_status'),
    outputPolicy: 'agent-only' as const,
    run: (c) => runStatus(c, inflow, authStorage),
  });
  cli.command('grant', {
    args: serviceReferenceArgs,
    description: 'Request and store a Service credential.',
    mcp: mcpTool('aep_grant'),
    options: grantOptions,
    outputPolicy: 'agent-only' as const,
    run: (c) => runGrant(c, inflow, authStorage),
  });
  cli.command('revoke', {
    args: serviceReferenceArgs,
    description: 'Revoke Service credentials.',
    mcp: mcpTool('aep_revoke'),
    options: revokeOptions,
    outputPolicy: 'agent-only' as const,
    run: (c) => runRevoke(c, inflow, authStorage),
  });
  return cli;
}

export const __testing = { commandError, inspected, runEnroll, runFetch, runGrant, runInspect, runRevoke, runStatus };
