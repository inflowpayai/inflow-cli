import type { MppSupportedResponse } from '@inflowpayai/mpp';
import type { X402BuyerSupportedResponse } from '@inflowpayai/x402';
import type { IMppResource, IX402Resource } from '../client.js';
import {
  type AuthSnapshotFrame,
  type AuthStatusFrame,
  composeAuthSnapshot,
  type ComposeAuthSnapshotOptions,
  type PollAuthStatusOptions,
  pollAuthStatus,
} from '../auth/poll.js';
import { type AuthStatusProbeResult, probeAuthStatus } from './auth-status.js';
import { InflowConfigurationError, InflowSdkError } from '../errors.js';
import type {
  IAuthResource,
  IBalanceResource,
  IDepositAddressResource,
  IUserResource,
} from '../resources/interfaces.js';
import type { Balance, ConfiguredDepositAddress, DepositAddresses, User } from '../types/index.js';
import type { AuthStorage } from '../utils/storage.js';
import { type AuthLoginInput, type AuthLoginRun, runAuthLogin } from './auth-login.js';
import { type AuthLoginApiKeyInput, type AuthLoginApiKeyRun, runAuthLoginApiKey } from './auth-login-api-key.js';
import { runAuthLogout } from './auth-logout.js';
import { type UserAgentPayload, runUserGet } from './user-get.js';
import { type InspectEvent, type InspectPipelineDeps, runInspectPipeline } from './x402-inspect.js';
import { type PayEvent, type PayPipelineDeps, runPayPipeline } from './x402-pay.js';
import { type X402CancelResult, runX402Cancel } from './x402-cancel.js';
import { type X402StatusRun, runX402Status } from './x402-status.js';
import { runX402Supported } from './x402-supported.js';
import { type MppCancelResult, runMppCancel } from './mpp-cancel.js';
import { type MppInspectEvent, type MppInspectPipelineDeps, runMppInspectPipeline } from './mpp-inspect.js';
import { type MppPayEvent, type MppPayPipelineDeps, runMppPayPipeline } from './mpp-pay.js';
import { type MppStatusRun, runMppStatus } from './mpp-status.js';
import { runMppSupported } from './mpp-supported.js';

/* -------------------------------------------------------------------------- */
/* Request input types                                                        */
/* -------------------------------------------------------------------------- */
/*
 * Inputs the instance-bound methods on the augmented resource handles accept.
 * Each one mirrors a standalone-function input minus the dependencies the
 * Inflow instance supplies (resources, storage, resolved api base URL).
 */

export type AuthLoginRequest = Omit<AuthLoginInput, 'authResource' | 'authStorage'>;
export type AuthLoginApiKeyRequest = Omit<AuthLoginApiKeyInput, 'authStorage' | 'userResource'>;

export interface AuthStatusProbeRequest {
  /** Optional snapshot-composition options forwarded to {@link composeAuthSnapshot}. */
  composeOptions?: ComposeAuthSnapshotOptions;
}

export interface AuthStatusPollRequest extends PollAuthStatusOptions {
  /** Optional snapshot-composition options forwarded to {@link composeAuthSnapshot}. */
  composeOptions?: ComposeAuthSnapshotOptions;
}

/**
 * Input shape for `inflow.x402.pay`. `apiBaseUrl` is optional — the Inflow instance's resolved value is used when
 * absent.
 */
export type X402PayRequest = Omit<PayPipelineDeps, 'client' | 'apiBaseUrl'> & { apiBaseUrl?: string };

export interface X402StatusRequest {
  transactionId: string;
  interval: number;
  maxAttempts: number;
  timeout: number;
}

export interface X402CancelRequest {
  approvalId: string;
}

export type X402InspectRequest = InspectPipelineDeps;

/**
 * Input shape for `inflow.mpp.pay`. `apiBaseUrl` is optional — the Inflow instance's resolved value is used when
 * absent.
 */
export type MppPayRequest = Omit<MppPayPipelineDeps, 'client' | 'apiBaseUrl'> & { apiBaseUrl?: string };

export interface MppStatusRequest {
  transactionId: string;
  interval: number;
  maxAttempts: number;
  timeout: number;
}

export interface MppCancelRequest {
  approvalId: string;
}

export type MppInspectRequest = MppInspectPipelineDeps;

/* -------------------------------------------------------------------------- */
/* FlowRun: async-iterable wrapper for callback-style pipelines               */
/* -------------------------------------------------------------------------- */

/**
 * Async-iterable handle returned by the stateful x402 flows (`pay`, `inspect`). The underlying pipeline uses an
 * `emit(event)` callback for instantaneous dispatch into a host reducer; the public surface wraps that into an `events`
 * async-iterable so consumers can `for await` the events without owning a callback.
 */
export interface FlowRun<E> {
  events: AsyncIterable<E>;
}

/**
 * Lazy-start adapter: turns a callback-style `run(emit)` pipeline into a {@link FlowRun}. The underlying `run` is not
 * invoked until the caller first awaits the iterator, so constructing a `FlowRun` is side-effect free until something
 * subscribes. The internal buffer is unbounded; consumers are expected to pull frames promptly. Empty `emit` calls
 * (i.e. `emit(undefined as never)`) are NOT supported — events must be defined values.
 */
function wrapEmittingPipeline<E>(run: (emit: (event: E) => void) => Promise<void>): FlowRun<E> {
  const buffer: E[] = [];
  let started = false;
  let done = false;
  let error: unknown;
  let wake: (() => void) | null = null;
  let finished: Promise<void> | null = null;

  function emit(event: E): void {
    buffer.push(event);
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    finished = run(emit)
      .catch((err) => {
        error = err;
      })
      .finally(() => {
        done = true;
        if (wake) {
          const w = wake;
          wake = null;
          w();
        }
      });
  }

  async function* iterate(): AsyncGenerator<E> {
    start();
    while (true) {
      while (buffer.length > 0) {
        yield buffer.shift() as E;
      }
      if (done) {
        if (finished !== null) await finished;
        if (error !== undefined) {
          if (error instanceof Error) throw error;
          const message = typeof error === 'string' ? error : (JSON.stringify(error) ?? 'Unknown error');
          throw new InflowSdkError(message, { cause: error });
        }
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return { events: iterate() };
}

function requireStorage(storage: AuthStorage | undefined, methodName: string): AuthStorage {
  if (storage === undefined) {
    throw new InflowConfigurationError(`Inflow.${methodName} requires authStorage on the Inflow constructor.`);
  }
  return storage;
}

/* -------------------------------------------------------------------------- */
/* Augmented resource interfaces                                              */
/* -------------------------------------------------------------------------- */

/**
 * Augmented auth handle. Extends {@link IAuthResource}'s protocol primitives with the high-level operations the CLI's
 * `inflow auth ...` commands run.
 */
export interface IAuth extends IAuthResource {
  /**
   * Compose an auth snapshot from storage. Sync; no network call. Use when you need to display the current auth state
   * (the verbose `auth status` frame, for example) without doing a server-side probe.
   */
  snapshot(options?: ComposeAuthSnapshotOptions): AuthSnapshotFrame;
  /** Drive the device-flow login lifecycle. Returns an async-iterable of events plus a `cancel()` handle. */
  login(input: AuthLoginRequest): AuthLoginRun;
  /** Validate-and-persist for the API-key login path. Returns an async-iterable of events. */
  loginApiKey(input: AuthLoginApiKeyRequest): AuthLoginApiKeyRun;
  /** Revoke the refresh token (best-effort) then clear every artifact from local storage. */
  logout(): Promise<void>;
  /** Compose an auth snapshot, then verify it against the server with a user.retrieve probe. */
  probeStatus(input?: AuthStatusProbeRequest): Promise<AuthStatusProbeResult>;
  /** Poll the auth status until a terminal frame; yields each non-redundant snapshot. */
  pollStatus(input: AuthStatusPollRequest): AsyncIterable<AuthStatusFrame>;
}

/** Augmented user handle. Adds an agent-mode projected `get()` alongside the raw `.retrieve()`. */
export interface IUser extends IUserResource {
  /** Retrieve the user and apply the agent-mode projection (drops `created` and `updated`). */
  get(): Promise<UserAgentPayload>;
}

/** Balances handle. No augmentation — the resource's `.list()` is already the right shape. */
export type IBalances = IBalanceResource;

/** Deposit-addresses handle. No augmentation — the resource's `.list()` is already the right shape. */
export type IDepositAddresses = IDepositAddressResource;

/**
 * Augmented x402 handle. Extends the lazy-client wrapper with the high-level x402 operations the CLI's `inflow x402
 * ...` commands run.
 */
export interface IX402 extends IX402Resource {
  /** One-shot probe + decode of an x402-protected URL. Returns an async-iterable of events. */
  inspect(input: X402InspectRequest): FlowRun<InspectEvent>;
  /** Buyer-side capability cache (scheme × network) the client can sign. */
  supported(): Promise<X402BuyerSupportedResponse>;
  /**
   * Full x402 payment lifecycle (probe → decode → match → sign → replay). Returns an async-iterable of events plus a
   * settled or error terminal frame. `apiBaseUrl` defaults to the Inflow instance's resolved value.
   */
  pay(input: X402PayRequest): FlowRun<PayEvent>;
  /** Poll the signing state of an in-flight x402 transaction. */
  status(input: X402StatusRequest): X402StatusRun;
  /** Best-effort cancel of an in-flight x402 approval. */
  cancel(input: X402CancelRequest): Promise<X402CancelResult>;
}

/**
 * Augmented MPP handle. Extends the lazy-client wrapper with the high-level MPP operations the CLI's `inflow mpp ...`
 * commands run. `decode` is intentionally absent — it is a pure codec function ({@link decodeMppValue}) the CLI calls
 * directly, with no client.
 */
export interface IMpp extends IMppResource {
  /** One-shot probe + decode of an MPP-protected URL's `WWW-Authenticate: Payment` challenge(s). */
  inspect(input: MppInspectRequest): FlowRun<MppInspectEvent>;
  /** Buyer capability (`GET /v1/transactions/mpp-supported`): methods → intents → rails → currencies. */
  supported(): Promise<MppSupportedResponse>;
  /**
   * Full MPP payment lifecycle (probe → parse → select → create → poll → replay). Returns an async-iterable of events.
   * `apiBaseUrl` defaults to the Inflow instance's resolved value.
   */
  pay(input: MppPayRequest): FlowRun<MppPayEvent>;
  /** Poll the buyer-side state of an in-flight MPP transaction. */
  status(input: MppStatusRequest): MppStatusRun;
  /** Best-effort cancel of an in-flight MPP approval (delegated to `@inflowpayai/mpp-buyer`). */
  cancel(input: MppCancelRequest): Promise<MppCancelResult>;
}

/* -------------------------------------------------------------------------- */
/* Factories used by the Inflow constructor                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build an {@link IAuth} handle by binding the raw resource + storage + companion user resource. The auth-side methods
 * that need storage throw {@link InflowConfigurationError} at call time when `authStorage` is undefined.
 */
export function augmentAuth(
  authResource: IAuthResource,
  userResource: IUserResource,
  authStorage: AuthStorage | undefined,
): IAuth {
  return {
    initiateDeviceAuth: (clientName) => authResource.initiateDeviceAuth(clientName),
    pollDeviceAuth: (deviceCode) => authResource.pollDeviceAuth(deviceCode),
    refreshToken: (refreshToken) => authResource.refreshToken(refreshToken),
    revokeToken: (token) => authResource.revokeToken(token),
    snapshot(options) {
      return composeAuthSnapshot(requireStorage(authStorage, 'auth.snapshot'), options);
    },
    login(input) {
      return runAuthLogin({
        ...input,
        authResource,
        authStorage: requireStorage(authStorage, 'auth.login'),
      });
    },
    loginApiKey(input) {
      return runAuthLoginApiKey({
        ...input,
        authStorage: requireStorage(authStorage, 'auth.loginApiKey'),
        userResource,
      });
    },
    async logout() {
      return runAuthLogout({
        authResource,
        authStorage: requireStorage(authStorage, 'auth.logout'),
      });
    },
    async probeStatus(input = {}) {
      return probeAuthStatus({
        ...input,
        authStorage: requireStorage(authStorage, 'auth.probeStatus'),
        userResource,
      });
    },
    pollStatus(input) {
      const storage = requireStorage(authStorage, 'auth.pollStatus');
      const composeOptions = input.composeOptions ?? {};
      const options: PollAuthStatusOptions = {
        interval: input.interval,
        maxAttempts: input.maxAttempts,
        timeout: input.timeout,
      };
      return pollAuthStatus(authResource, storage, options, composeOptions);
    },
  };
}

/** Build an {@link IUser} handle that delegates to the raw resource and adds the agent-mode projection. */
export function augmentUser(userResource: IUserResource): IUser {
  return {
    retrieve: (options) => userResource.retrieve(options),
    async get() {
      return runUserGet({ userResource });
    },
  };
}

/**
 * Build an {@link IX402} handle by extending the raw lazy-client wrapper with the high-level operations. Mutates
 * `x402Resource` in place rather than returning a wrapper, so any caller-visible state on the underlying resource
 * (notably its internal cached buyer-client promise) remains addressable on the returned handle. Construction site of
 * the `inflow.x402` handle on the Inflow instance — the public surface is the {@link IX402} interface, consumers should
 * reach for `new Inflow({...}).x402`, not this factory.
 *
 * @internal
 */
export function augmentX402(x402Resource: IX402Resource, resolvedApiBaseUrl: string): IX402 {
  const augmented = x402Resource as IX402Resource & Partial<IX402>;
  augmented.inspect = (input) => wrapEmittingPipeline<InspectEvent>((emit) => runInspectPipeline(input, emit));
  augmented.supported = async () => runX402Supported({ x402: x402Resource });
  augmented.pay = (input) =>
    wrapEmittingPipeline<PayEvent>(async (emit) => {
      const client = await x402Resource.client();
      return runPayPipeline(
        {
          ...input,
          client,
          apiBaseUrl: input.apiBaseUrl ?? resolvedApiBaseUrl,
        },
        emit,
      );
    });
  augmented.status = (input) =>
    runX402Status({
      fetchOnce: async () => {
        const client = await x402Resource.client();
        return client.getX402Payload(input.transactionId);
      },
      interval: input.interval,
      maxAttempts: input.maxAttempts,
      timeout: input.timeout,
    });
  augmented.cancel = async (input) => runX402Cancel({ x402: x402Resource, approvalId: input.approvalId });
  return augmented as IX402;
}

/**
 * Build an {@link IMpp} handle by extending the raw lazy-client wrapper with the high-level MPP operations. Mutates
 * `mppResource` in place (mirroring {@link augmentX402}) so the underlying cached client / method remain addressable on
 * the returned handle. Construction site of the `inflow.mpp` handle on the Inflow instance.
 *
 * @internal
 */
export function augmentMpp(mppResource: IMppResource, resolvedApiBaseUrl: string): IMpp {
  const augmented = mppResource as IMppResource & Partial<IMpp>;
  augmented.inspect = (input) => wrapEmittingPipeline<MppInspectEvent>((emit) => runMppInspectPipeline(input, emit));
  augmented.supported = async () => runMppSupported({ mpp: mppResource });
  augmented.pay = (input) =>
    wrapEmittingPipeline<MppPayEvent>(async (emit) => {
      const client = await mppResource.client();
      return runMppPayPipeline(
        {
          ...input,
          client,
          apiBaseUrl: input.apiBaseUrl ?? resolvedApiBaseUrl,
        },
        emit,
      );
    });
  augmented.status = (input) =>
    runMppStatus({
      fetchOnce: async () => {
        const client = await mppResource.client();
        return client.getTransaction(input.transactionId);
      },
      interval: input.interval,
      maxAttempts: input.maxAttempts,
      timeout: input.timeout,
    });
  augmented.cancel = async (input) => runMppCancel({ mpp: mppResource, approvalId: input.approvalId });
  return augmented as IMpp;
}

// Re-export internal types touched by IAuth/IUser/IX402 so consumers writing functions that accept these interfaces
// have everything they need from a single import.
export type {
  AuthLoginRun,
  AuthLoginApiKeyRun,
  AuthSnapshotFrame,
  AuthStatusFrame,
  AuthStatusProbeResult,
  Balance,
  ComposeAuthSnapshotOptions,
  ConfiguredDepositAddress,
  DepositAddresses,
  InspectEvent,
  PayEvent,
  PollAuthStatusOptions,
  User,
  UserAgentPayload,
  X402BuyerSupportedResponse,
  X402CancelResult,
  X402StatusRun,
  IBalanceResource,
  IDepositAddressResource,
  MppSupportedResponse,
  MppCancelResult,
  MppInspectEvent,
  MppPayEvent,
  MppStatusRun,
};
