import { InflowApiError } from '../errors.js';
import type { IAuthResource } from '../resources/interfaces.js';
import type { AuthTokens, DeviceAuthRequest } from '../types/index.js';
import { pollAsync } from '../utils/async-poll.js';
import type { AuthStorage, ConnectionSettings } from '../utils/storage.js';

/**
 * State machine for the device-flow login lifecycle. Mirrors the visible UI states the CLI's `auth login` command
 * surfaces, but is pure data — no React, no Ink. Any consumer can subscribe to the `runAuthLogin` event stream and
 * project the resulting `AuthLoginPhase` into its own renderer (Ink, a web UI, an MCP transport).
 */
export type AuthLoginPhase =
  | { kind: 'init' }
  | { kind: 'awaiting'; req: DeviceAuthRequest }
  | { kind: 'success' }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'failed'; message: string };

/**
 * Events emitted by {@link runAuthLogin} as the device flow progresses. Feeding them into {@link reduceAuthLogin}
 * produces the corresponding {@link AuthLoginPhase}.
 */
export type AuthLoginEvent =
  | { type: 'initiated'; req: DeviceAuthRequest }
  | { type: 'initiateFailed'; message: string }
  | { type: 'tokensReceived' }
  | { type: 'pollExpired' }
  | { type: 'pollTimedOut'; reason: 'max_attempts' | 'timeout' }
  | { type: 'pollDenied' }
  | { type: 'pollFailed'; message: string };

/**
 * Pure reducer. Given the current {@link AuthLoginPhase} and an incoming {@link AuthLoginEvent}, returns the next phase.
 * The current state is ignored (the event determines the next phase unambiguously) but the signature follows the
 * canonical reducer shape so React's `useReducer` and similar host loops can consume it directly.
 */
export function reduceAuthLogin(_state: AuthLoginPhase, event: AuthLoginEvent): AuthLoginPhase {
  switch (event.type) {
    case 'initiated':
      return { kind: 'awaiting', req: event.req };
    case 'initiateFailed':
      return { kind: 'failed', message: event.message };
    case 'tokensReceived':
      return { kind: 'success' };
    case 'pollExpired':
    case 'pollTimedOut':
      return { kind: 'expired' };
    case 'pollDenied':
      return { kind: 'denied' };
    case 'pollFailed':
      return { kind: 'failed', message: event.message };
  }
}

export interface AuthLoginInput {
  /** Auth resource used to initiate the device flow, poll for tokens, and revoke any prior refresh token. */
  authResource: IAuthResource;
  /** Storage that receives the new tokens (and has any prior API key cleared) on success. */
  authStorage: AuthStorage;
  /** Display name persisted as the device's `connection_label` (e.g. "InFlow on hostname"). */
  clientName?: string;
  /** Effective connection settings persisted alongside the tokens on success. */
  connection: ConnectionSettings;
  /** When set, the prior refresh token is best-effort revoked once the new tokens are durable. */
  priorRefreshToken?: string;
  /**
   * Wall-clock delay before the first poll tick. Defaults to 1000 ms — gives the user enough time to read the
   * verification URL frame before the spinner starts moving.
   */
  firstPollDelayMs?: number;
  /** Interval between subsequent polls, in ms. Defaults to 2000 ms. */
  pollIntervalMs?: number;
  /** Hard cap on poll attempts (`0` for unlimited, default `0`). Emits `pollTimedOut` when exhausted. */
  pollMaxAttempts?: number;
  /**
   * Polling deadline in seconds. Defaults to `req.expires_in` (the device code's server-side expiry). Pass a smaller
   * value to bound polling time client-side; pass `0` to defer entirely to the server expiry.
   */
  pollTimeoutSeconds?: number;
}

/** Handle returned by {@link runAuthLogin}. Iterate `events` to drive a UI reducer; `cancel()` aborts the flow. */
export interface AuthLoginRun {
  /** Event stream from `initiated` through whichever terminal frame the flow ended on. */
  events: AsyncIterable<AuthLoginEvent>;
  /**
   * Cancel the flow. Stops the polling loop; the iterator finishes on the current tick without emitting further events.
   * Already-persisted tokens (if any) are not rolled back.
   */
  cancel(): void;
}

const DEFAULT_FIRST_POLL_DELAY_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Drives the InFlow device-flow login. Returns an {@link AuthLoginRun} handle whose `events` async-iterable yields each
 * {@link AuthLoginEvent} as the flow progresses. The iterator terminates after the first terminal event
 * (`tokensReceived`, `pollExpired`, `pollDenied`, or `pollFailed`).
 *
 * Side effects on success:
 *
 * - `authStorage.setAuth(tokens)` — persists the new credentials.
 * - `authStorage.clearApiKey()` — device-flow login wins authoritatively over any prior API key on the same machine.
 * - `authStorage.setConnection(input.connection)` — pins the connection block alongside the credentials.
 * - `authStorage.clearPendingDeviceAuth()` — drops the in-flight device-auth record now that the flow has resolved, so a
 *   later `auth status` reports the saved tokens instead of a stale pending frame.
 * - `authResource.revokeToken(input.priorRefreshToken)` — best-effort; failures are swallowed (the orphan refresh expires
 *   server-side).
 *
 * Errors mid-flow are classified by the OAuth `error` code where possible (`expired_token` → `pollExpired`,
 * `access_denied` → `pollDenied`); everything else collapses to `pollFailed` with the underlying error's message.
 */
export function runAuthLogin(input: AuthLoginInput): AuthLoginRun {
  const firstPollDelayMs = input.firstPollDelayMs ?? DEFAULT_FIRST_POLL_DELAY_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let cancelled = false;
  let cancelSleep: (() => void) | null = null;

  function cancel(): void {
    cancelled = true;
    cancelSleep?.();
  }

  async function sleepCancellable(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      cancelSleep = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    cancelSleep = null;
  }

  async function* generate(): AsyncGenerator<AuthLoginEvent> {
    let req: DeviceAuthRequest;
    try {
      req = await input.authResource.initiateDeviceAuth(input.clientName);
    } catch (error) {
      yield { type: 'initiateFailed', message: error instanceof Error ? error.message : String(error) };
      return;
    }
    if (cancelled) return;
    yield { type: 'initiated', req };

    await sleepCancellable(firstPollDelayMs);
    if (cancelled) return;

    try {
      const effectiveTimeout =
        input.pollTimeoutSeconds !== undefined && input.pollTimeoutSeconds > 0
          ? input.pollTimeoutSeconds
          : req.expires_in;
      for await (const outcome of pollAsync<AuthTokens | null>({
        fn: () => input.authResource.pollDeviceAuth(req.device_code),
        isTerminal: (tokens) => tokens !== null,
        interval: pollIntervalMs / 1_000,
        maxAttempts: input.pollMaxAttempts ?? 0,
        timeout: effectiveTimeout,
      })) {
        if (cancelled) return;
        if (outcome.terminal && outcome.reason !== undefined) {
          yield { type: 'pollTimedOut', reason: outcome.reason };
          return;
        }
        if (outcome.value !== null) {
          input.authStorage.setAuth(outcome.value);
          input.authStorage.clearApiKey();
          input.authStorage.setConnection(input.connection);
          input.authStorage.clearPendingDeviceAuth();
          if (input.priorRefreshToken !== undefined) {
            input.authResource.revokeToken(input.priorRefreshToken).catch(() => {
              // swallow; orphan refresh expires server-side
            });
          }
          yield { type: 'tokensReceived' };
          return;
        }
      }
    } catch (error) {
      if (cancelled) return;
      if (error instanceof InflowApiError && error.code === 'expired_token') {
        yield { type: 'pollExpired' };
        return;
      }
      if (error instanceof InflowApiError && error.code === 'access_denied') {
        yield { type: 'pollDenied' };
        return;
      }
      yield {
        type: 'pollFailed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    events: generate(),
    cancel,
  };
}
