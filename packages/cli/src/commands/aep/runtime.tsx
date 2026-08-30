import {
  AepCommandError,
  AepPendingSignResolverError,
  createAepAgent,
  createPlatformIdentityProvider,
  fetchProtectedResource,
  inspectOpenApiPolicy,
  inspectService,
  probeProtectedResource,
  type AepAgentOptions,
  type AepPublicDocumentCache,
  type AgentCredentialStore,
  type AgentIdentityStore,
  type AgentInspectCache,
  type AgentServiceIdentity,
  type InspectServiceResult,
} from '@aep-foundation/agent';
import {
  AepStorage,
  approvalUrlFor,
  createTapFetch,
  createTapRequestTransport,
  PaymentInspectionBlockedError,
  SecureStorageError,
  SellerAuthenticationError,
  type AepStateStorage,
  type AuthStorage,
  type Inflow,
  type SellerRequestInput,
  type SellerRequestTransport,
  type TapOperation,
} from '@inflowpayai/inflow-core';
import type { SellerProbeOptions, SellerProbeResult } from '@inflowpayai/x402-buyer/probe';
import { render } from 'ink';
import React from 'react';
import { persistedAepPublicDocumentCache } from '../../utils/aep-public-document-cache.js';
import type { AuthenticationApprovalDisplay } from '../payment-authentication-approval.js';
import {
  ApprovalCancelledError,
  approvalSleep,
  approvalStatusBeforeDeadline,
  ApprovalTimeoutError,
  cancelApproval,
  remainingApprovalDelay,
} from './approval-polling.js';
import { PendingApprovalView } from './views.js';

type PendingApprovalRenderer = Pick<ReturnType<typeof render>, 'clear' | 'unmount'>;

export type AepRuntimeContext = {
  agent: boolean;
  formatExplicit: boolean;
  error(error: { code: string; message: string; exitCode?: number; retryable?: boolean }): never;
};

export interface AepRuntimeOptions {
  aepReadFetch?: typeof globalThis.fetch;
  aepWriteFetch?: typeof globalThis.fetch;
  approvalDisplay?: AepApprovalDisplay;
  authStorage: AuthStorage;
  context: AepRuntimeContext;
  fetch?: typeof globalThis.fetch;
  inflow: Inflow;
  interval?: number;
  maxRedirects?: number;
  timeout: number;
  trace?: AepRuntimeTrace;
}

interface AepRuntimeTrace {
  markAuthenticated(): void;
}

export interface AepApprovalDisplay {
  clearPendingApproval(): void;
  showPendingApproval(approval: AuthenticationApprovalDisplay): boolean;
}

class MissingIdentityError extends Error {}
class ApprovalDeniedError extends Error {}
class ApprovalServerError extends Error {}
class AuthenticationHeaderCollisionError extends Error {
  constructor(readonly headerName: string) {
    super(`Header ${headerName} is controlled by AEP authentication.`);
  }
}

function closePendingApprovalView(view: PendingApprovalRenderer | undefined): void {
  if (view === undefined) return;
  view.clear();
  view.unmount();
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

function platformProvider(inflow: Inflow, publicDocumentCache?: AepPublicDocumentCache) {
  return createPlatformIdentityProvider({
    authenticationHeaders: () => inflow.platformAuthenticationHeaders(),
    platformUrl: inflow.resolvedApiBaseUrl,
    ...(publicDocumentCache === undefined ? {} : { publicDocumentCache }),
  });
}

function lazyStores(
  inflow: Inflow,
  authStorage: AuthStorage,
  trace?: AepRuntimeTrace,
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
      findCredential: async (serviceDid, credentialId) => {
        const record = await (await get()).credentials().findCredential(serviceDid, credentialId);
        if (record !== undefined) trace?.markAuthenticated();
        return record;
      },
      findUsableCredential: async (serviceDid, now) => {
        const record = await (await get()).credentials().findUsableCredential(serviceDid, now);
        if (record !== undefined) trace?.markAuthenticated();
        return record;
      },
      listCredentials: async (serviceDid) => {
        const records = await (await get()).credentials().listCredentials(serviceDid);
        if (records.length > 0) trace?.markAuthenticated();
        return records;
      },
      saveCredential: async (record) => {
        trace?.markAuthenticated();
        return (await get()).credentials().saveCredential(record);
      },
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

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function requestHeaders(headers: Record<string, string>, body: string | undefined): Record<string, string> {
  if (body === undefined || hasHeader(headers, 'Content-Type')) return headers;
  return { ...headers, 'Content-Type': 'application/json' };
}

function assertAepHeaderAvailable(input: SellerRequestInput): void {
  if (hasHeader(input.headers, 'AEP-Authorization')) throw new AuthenticationHeaderCollisionError('AEP-Authorization');
  if (
    input.additionalAuthenticationHeaders !== undefined &&
    hasHeader(input.additionalAuthenticationHeaders, 'AEP-Authorization')
  ) {
    throw new AuthenticationHeaderCollisionError('AEP-Authorization');
  }
}

function assertProbeAepHeaderAvailable(options: SellerProbeOptions): void {
  if (hasHeader(options.headers, 'AEP-Authorization'))
    throw new AuthenticationHeaderCollisionError('AEP-Authorization');
}

async function responseToSellerResult(response: Response): Promise<{
  bytes: Uint8Array;
  contentType: string | undefined;
  headers: Headers;
  status: number;
}> {
  const contentType = response.headers.get('content-type') ?? undefined;
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType,
    headers: response.headers,
    status: response.status,
  };
}

export function createCliAepAgentOptions(options: AepRuntimeOptions): AepAgentOptions {
  const publicDocumentCache = persistedAepPublicDocumentCache(options.authStorage);
  const platform = platformProvider(options.inflow, publicDocumentCache);
  const storage = lazyStores(options.inflow, options.authStorage, options.trace);
  let waitingView: PendingApprovalRenderer | undefined;
  return {
    credentialStore: storage.credentials,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.aepReadFetch === undefined ? {} : { readFetch: options.aepReadFetch }),
    ...(options.aepWriteFetch === undefined ? {} : { writeFetch: options.aepWriteFetch }),
    /* v8 ignore start -- Platform identity provider wiring is covered by AEP command tests with the command-level mock. */
    identityProvider: {
      getOrCreateIdentity: async (input) => {
        const recovered = await platform.findIdentityByServiceDid(input.serviceDid);
        if (recovered === undefined) throw new MissingIdentityError();
        return recovered;
      },
      signerFor: async (identity: AgentServiceIdentity) => {
        const signer = await platform.signerFor(identity);
        return (claims, context) => {
          options.trace?.markAuthenticated();
          return signer(claims, context);
        };
      },
    },
    /* v8 ignore stop */
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
      options.trace?.markAuthenticated();
      const approvalId = input.pending.platformContext?.['approval_id'];
      if (typeof approvalId !== 'string') {
        throw new AepPendingSignResolverError('Platform Sign omitted the approval identifier.', 'server_error');
      }
      const controller = new AbortController();
      const approvalUrl = approvalUrlFor(options.inflow.resolvedApiBaseUrl, approvalId);
      let displayHandled = false;
      /* v8 ignore start -- Ink rendering is exercised through command TTY tests; resolver unit tests run agent-mode. */
      if (!options.context.agent && !options.context.formatExplicit) {
        const approval = {
          approvalId,
          approvalUrl,
          cancel: async () => {
            await cancelApproval(options.inflow, approvalId);
            controller.abort();
          },
        };
        displayHandled = options.approvalDisplay?.showPendingApproval(approval) === true;
        if (!displayHandled) {
          waitingView = render(
            <PendingApprovalView approvalId={approvalId} approvalUrl={approvalUrl} onCancel={approval.cancel} />,
            { exitOnCtrlC: false },
          );
        }
      }
      /* v8 ignore stop */
      try {
        const interval = options.interval ?? input.pending.retryAfterSeconds;
        if (!Number.isFinite(interval) || interval <= 0) {
          throw new AepPendingSignResolverError('Approval interval must be positive.', 'server_error');
        }
        const deadline = Date.now() + options.timeout * 1000;
        while (Date.now() < deadline) {
          if (input.signal?.aborted === true || controller.signal.aborted) throw new ApprovalCancelledError();
          let status: string;
          try {
            status = await approvalStatusBeforeDeadline(options.inflow, approvalId, deadline, [
              input.signal,
              controller.signal,
            ]);
          } catch (error) {
            if (error instanceof ApprovalCancelledError || error instanceof ApprovalTimeoutError) throw error;
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
          await approvalSleep(remainingApprovalDelay(deadline, interval * 1000), [input.signal, controller.signal]);
        }
        throw new ApprovalTimeoutError();
      } finally {
        if (displayHandled) options.approvalDisplay?.clearPendingApproval();
        closePendingApprovalView(waitingView);
      }
    },
  };
}

export function createAepAwareFetch(options: AepRuntimeOptions): typeof globalThis.fetch {
  const agent = createAepAgent(createCliAepAgentOptions(options));
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.headers.has('AEP-Authorization')) {
      throw new AuthenticationHeaderCollisionError('AEP-Authorization');
    }
    if (input instanceof Request && input.body !== null && init?.body === undefined) {
      throw new TypeError('AEP-aware ODP requests require a replayable body in RequestInit.');
    }
    return fetchProtectedResource({
      agent,
      ...(init?.body === undefined ? {} : { body: init.body }),
      carrier: 'dedicated',
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      headers: request.headers,
      maxRedirects: options.maxRedirects ?? 5,
      method: request.method,
      signal: request.signal,
      timeoutMs: options.timeout * 1000,
      url: request.url,
    });
  };
}

export async function aepCachePartition(authStorage: AuthStorage, inflow: Inflow): Promise<string | undefined> {
  let state: ReturnType<AepStateStorage['getAepState']>;
  try {
    state = stateStorage(authStorage).getAepState();
  } catch {
    return undefined;
  }
  if (state === null) return undefined;
  let user: Awaited<ReturnType<Inflow['user']['retrieve']>>;
  try {
    user = await inflow.user.retrieve();
  } catch {
    return undefined;
  }
  if (state.owner.platformOrigin !== new URL(inflow.resolvedApiBaseUrl).origin || state.owner.userId !== user.userId) {
    return undefined;
  }
  return `aep:${JSON.stringify([state.owner.platformOrigin, state.owner.userId])}`;
}

export function createAepAwareSellerTransport(options: AepRuntimeOptions): SellerRequestTransport {
  const trace = {
    authenticated: false,
    markAuthenticated(): void {
      this.authenticated = true;
    },
  };
  const agent = createAepAgent(createCliAepAgentOptions({ ...options, trace }));
  return {
    request: async (input) => {
      try {
        assertAepHeaderAvailable(input);
      } catch (error) {
        const mapped = mapAepRuntimeErrorToSellerAuthentication(error);
        if (mapped !== undefined) throw mapped;
        throw error;
      }
      trace.authenticated = false;
      const headers = requestHeaders(input.headers, input.data);
      const probe = await probeProtectedResource({
        ...(input.data === undefined ? {} : { body: input.data }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        headers,
        method: input.method,
        url: input.url,
      });
      if (probe.classification !== 'aep-challenge') {
        if (input.additionalAuthenticationHeaders !== undefined && probe.response.status === 402) {
          const retry = await (options.fetch ?? globalThis.fetch)(input.url, {
            ...(input.data === undefined ? {} : { body: input.data }),
            headers: { ...headers, ...input.additionalAuthenticationHeaders },
            method: input.method,
          });
          return responseToSellerResult(retry);
        }
        return responseToSellerResult(probe.response);
      }
      let response: Response;
      try {
        response = await fetchProtectedResource({
          agent,
          carrier: 'dedicated',
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(input.additionalAuthenticationHeaders === undefined
            ? {}
            : { additionalAuthenticationHeaders: input.additionalAuthenticationHeaders }),
          ...(input.data === undefined ? {} : { body: input.data }),
          headers,
          ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
          method: input.method,
          timeoutMs: options.timeout * 1000,
          url: input.url,
        });
      } catch (error) {
        const mapped = mapAepRuntimeErrorToSellerAuthentication(error);
        if (mapped !== undefined) throw mapped;
        throw error;
      }
      return responseToSellerResult(response);
    },
  };
}

export function createTapAepAwareSellerTransport(
  options: AepRuntimeOptions & { inspectionOperation: TapOperation; paymentOperation: TapOperation },
): SellerRequestTransport {
  let activeRequest: SellerRequestInput | undefined;
  const evidence = { tapEvidenceId: undefined as string | undefined };
  const currentTapEvidenceId = () => evidence.tapEvidenceId;
  const tapTransport = createTapRequestTransport({
    capabilities: options.inflow.capabilities,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    followRedirects: false,
    tap: options.inflow.tap,
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body =
      typeof init?.body === 'string'
        ? init.body
        : request.body === null
          ? undefined
          : new Uint8Array(await request.clone().arrayBuffer());
    const operation =
      activeRequest?.transactionId === undefined ? options.inspectionOperation : options.paymentOperation;
    const result = await tapTransport.request({
      ...(body === undefined ? {} : { body }),
      headers: request.headers,
      method: request.method,
      operation,
      signal: request.signal,
      ...(activeRequest?.transactionId === undefined ? {} : { transactionId: activeRequest.transactionId }),
      url: request.url,
    });
    if (
      activeRequest !== undefined &&
      request.method === activeRequest.method &&
      request.url === new URL(activeRequest.url).toString()
    ) {
      evidence.tapEvidenceId = result.tapEvidenceId;
    }
    return result.response;
  };
  const transport = createAepAwareSellerTransport({
    ...options,
    aepReadFetch: createTapFetch({
      capabilities: options.inflow.capabilities,
      operation: 'aep.inspect',
      tap: options.inflow.tap,
    }),
    aepWriteFetch: createTapFetch({
      capabilities: options.inflow.capabilities,
      operation: 'aep.mutate',
      tap: options.inflow.tap,
    }),
    fetch,
  });
  return {
    request: async (input) => {
      activeRequest = input;
      evidence.tapEvidenceId = undefined;
      try {
        const result = await transport.request(input);
        const tapEvidenceId = currentTapEvidenceId();
        return tapEvidenceId === undefined ? result : { ...result, tapEvidenceId };
      } finally {
        activeRequest = undefined;
      }
    },
  };
}

export function createAepAwareInspectProbe(
  options: AepRuntimeOptions,
): (url: string, probeOptions: SellerProbeOptions) => Promise<SellerProbeResult> {
  const publicDocumentCache = persistedAepPublicDocumentCache(options.authStorage);
  const aepFetch = options.aepReadFetch ?? options.fetch ?? globalThis.fetch;
  const resourceFetch = options.fetch ?? globalThis.fetch;
  return async (url, probeOptions) => {
    assertProbeAepHeaderAvailable(probeOptions);
    const headers = requestHeaders(probeOptions.headers, probeOptions.data);
    const blockedMessage =
      'AEP authentication is required before payment terms can be inspected. Run the matching pay command to complete AEP first.';
    const authenticatedProbe = async (
      inspect: InspectServiceResult,
      source: 'openapi' | 'challenge',
      reason?: string,
    ): Promise<SellerProbeResult> => {
      let authenticationHeaders: Record<string, string> | undefined;
      try {
        authenticationHeaders = await storedAepCredentialAuthenticationHeaders(options, inspect);
      } catch {
        authenticationHeaders = undefined;
      }
      const serviceUrl = String(inspect.finalUrl ?? inspect.inspectUrl).replace('/.well-known/aep', '');
      if (authenticationHeaders === undefined) {
        throw new PaymentInspectionBlockedError({
          method: probeOptions.method,
          url,
          message: reason === undefined ? blockedMessage : `${blockedMessage} Reason: ${reason}`,
          source,
          serviceDid: inspect.document.service.did,
          serviceUrl,
        });
      }
      const response = await resourceFetch(url, {
        ...(probeOptions.data === undefined ? {} : { body: probeOptions.data }),
        headers: { ...headers, ...authenticationHeaders },
        method: probeOptions.method,
      });
      if (response.status === 401) {
        throw new PaymentInspectionBlockedError({
          method: probeOptions.method,
          url,
          message:
            'The stored AEP credential was rejected by this Service. Run `inflow aep grant <service>` to request a new credential.',
          source,
          serviceDid: inspect.document.service.did,
          serviceUrl,
        });
      }
      return responseToSellerResult(response);
    };

    try {
      const inspected = await inspectService({
        fetch: aepFetch,
        ...(publicDocumentCache === undefined ? {} : { publicDocumentCache }),
        serviceUrl: new URL(url).origin,
      });
      const policy = await inspectOpenApiPolicy({
        fetch: aepFetch,
        inspect: inspected,
        method: probeOptions.method,
        ...(publicDocumentCache === undefined ? {} : { publicDocumentCache }),
        url,
      });
      if (policy.state === 'required') return authenticatedProbe(inspected, 'openapi');
    } catch {
      // Fall back to the anonymous resource probe. Not every payment seller is an AEP Service.
    }

    const probe = await probeProtectedResource({
      ...(probeOptions.data === undefined ? {} : { body: probeOptions.data }),
      fetch: resourceFetch,
      headers,
      method: probeOptions.method,
      url,
    });
    if (probe.classification !== 'aep-challenge' || probe.challenge === undefined) {
      return responseToSellerResult(probe.response);
    }
    const inspected = await inspectService({
      fetch: aepFetch,
      ...(publicDocumentCache === undefined ? {} : { publicDocumentCache }),
      serviceUrl: probe.challenge.inspect,
    });
    if (inspected.document.service.did !== probe.challenge.serviceDid) {
      throw new Error('AEP challenge Service DID did not match Inspect.');
    }
    return authenticatedProbe(inspected, 'challenge', probe.challenge.reason);
  };
}

export function mapAepRuntimeErrorToSellerAuthentication(error: unknown): SellerAuthenticationError | undefined {
  const mapped = mapAepRuntimeError(error);
  return mapped === undefined
    ? undefined
    : new SellerAuthenticationError(mapped.code, mapped.message, mapped.retryable);
}

export async function storedAepCredentialAuthenticationHeaders(
  options: AepRuntimeOptions,
  inspect: InspectServiceResult,
): Promise<Record<string, string> | undefined> {
  const serviceDid = inspect.document.service.did;
  const storage = await stores(options.inflow, options.authStorage);
  const methods = new Set(inspect.document.authentication?.methods ?? []);
  const credentials = await storage.credentials().listCredentials(serviceDid);
  const credential = credentials
    .filter((candidate) => methods.has(candidate.grantType))
    .sort(
      (left, right) =>
        right.issuedAt.localeCompare(left.issuedAt) || right.credentialId.localeCompare(left.credentialId),
    )[0];
  if (credential === undefined) return undefined;
  const serviceUrl = String(inspect.finalUrl ?? inspect.inspectUrl).replace('/.well-known/aep', '');
  const agent = createAepAgent(createCliAepAgentOptions(options));
  return agent.serviceSession({ serviceUrl }).authenticationHeaders({
    carrier: 'dedicated',
    credentialId: credential.credentialId,
    preferCredential: true,
  });
}

export function mapAepRuntimeError(error: unknown): { code: string; message: string; retryable?: boolean } | undefined {
  if (error instanceof SecureStorageError) {
    const code =
      error.secureStorageCode === 'vault_locked' || error.secureStorageCode === 'secure_storage_secret_missing'
        ? 'VAULT_LOCKED'
        : error.secureStorageCode === 'vault_not_initialized'
          ? 'VAULT_NOT_INITIALIZED'
          : error.secureStorageCode;
    return { code, message: error.message };
  }
  if (error instanceof MissingIdentityError) {
    return {
      code: 'AEP_NOT_ENROLLED',
      message: 'Not enrolled with this Service. Use `inflow aep enroll <service>` first.',
    };
  }
  if (
    error instanceof AepCommandError &&
    (error.problem?.code === 'not_recognized' || error.problem?.code === 'agent_identity_not_found')
  ) {
    return {
      code: 'AEP_NOT_ENROLLED',
      message: 'Not enrolled with this Service. Use `inflow aep enroll <service>` first.',
    };
  }
  if (error instanceof ApprovalDeniedError) {
    return { code: 'AEP_APPROVAL_DENIED', message: 'The InFlow approval was declined.' };
  }
  if (error instanceof ApprovalCancelledError) {
    return { code: 'APPROVAL_CANCELLED', message: 'The AEP approval was cancelled.' };
  }
  if (error instanceof ApprovalTimeoutError) {
    return { code: 'AEP_APPROVAL_TIMEOUT', message: 'The InFlow approval timed out.' };
  }
  if (error instanceof ApprovalServerError) {
    return {
      code: 'AEP_APPROVAL_SERVER_ERROR',
      message: 'The InFlow approval status request failed.',
      retryable: true,
    };
  }
  if (error instanceof AuthenticationHeaderCollisionError) {
    return {
      code: 'AEP_AUTHENTICATION_HEADER_COLLISION',
      message: `${error.headerName} is reserved for AEP credentials. Remove that header from the request.`,
    };
  }
  return undefined;
}
