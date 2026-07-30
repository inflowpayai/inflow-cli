import type { IAuthResource } from '../resources/interfaces.js';
import type { AuthTokens } from '../types/index.js';
import { pollAsync, type PollExitReason } from '../utils/async-poll.js';
import { previewAccessToken } from '../utils/user-display.js';
import type { AuthStorage, ConnectionSettings } from '../utils/storage.js';

export interface PollAuthStatusOptions {
  interval: number;
  maxAttempts: number;
  timeout: number;
}

export interface UpdateBlock {
  current_version: string;
  latest_version: string;
}

/**
 * Optional inputs that let `composeAuthSnapshot` produce the shape the `auth status` surface expects without the caller
 * mutating storage:
 *
 * - `effectiveApiKey` — runtime API key from a flag/env that hasn't yet been persisted. Takes priority over the file's
 *   stored key, matching `InflowResources` precedence.
 * - `verbose` — when false (default) the `credentials_path` field is suppressed from the frame so the human display
 *   doesn't leak the user's home directory into screenshots.
 * - `connection` — optional override of the file's `connection` slot, used during login polling so the in-flight
 *   connection block can be reflected before the file write lands.
 */
export interface ComposeAuthSnapshotOptions {
  update?: UpdateBlock;
  effectiveApiKey?: string;
  verbose?: boolean;
  connection?: ConnectionSettings;
}

export interface AuthenticatedFrame {
  authenticated: true;
  auth_method: 'device_token' | 'api_key';
  access_token?: string;
  token_type?: string;
  credentials_path?: string;
  connection?: ConnectionSettings;
  update?: UpdateBlock;
}

export interface PendingFrame {
  authenticated: false;
  pending: true;
  verification_url: string;
  phrase: string;
  credentials_path?: string;
  connection?: ConnectionSettings;
  update?: UpdateBlock;
}

export interface UnauthenticatedFrame {
  authenticated: false;
  credentials_path?: string;
  connection?: ConnectionSettings;
  update?: UpdateBlock;
}

export interface TerminatedFrame {
  authenticated: false;
  reason: PollExitReason;
  credentials_path?: string;
  connection?: ConnectionSettings;
  update?: UpdateBlock;
}

export type AuthSnapshotFrame = AuthenticatedFrame | PendingFrame | UnauthenticatedFrame;

export type AuthStatusFrame = AuthSnapshotFrame | TerminatedFrame;

/**
 * Drives any in-flight device flow forward, then composes the frame the polling caller should see this tick. Returns a
 * sentinel on the iteration where the device flow completed so the caller can stop polling.
 *
 * Prefer-pending: while `pendingDeviceAuth` is present, the device flow always drives even if storage also holds a
 * stale auth from a previous session. Without this, an unfinished re-auth in storage would let the loop short-circuit
 * on the old tokens and never advance the new flow.
 *
 * When tokens are received, the on-disk record is updated atomically: device tokens go into `auth`, any prior api key
 * is cleared (only one active method at a time), and the connection block from the caller (if provided) is persisted
 * alongside.
 */
async function advancePendingFlow(
  authResource: IAuthResource,
  storage: AuthStorage,
  connection: ConnectionSettings | undefined,
): Promise<void> {
  const pending = storage.getPendingDeviceAuth();
  if (!pending) return;

  const tokens: AuthTokens | null = await authResource.pollDeviceAuth(pending.device_code);
  if (!tokens) return;

  // Capture the prior refresh token BEFORE overwriting storage. The safe-rebind invariant: revoke fires only after new tokens are durable.
  const priorRefreshToken = storage.getAuth()?.refresh_token;
  storage.setAuth(tokens);
  // Single active auth method at a time. A successful device-flow login supersedes any prior API key on the same machine.
  storage.clearApiKey();
  storage.clearPendingDeviceAuth();
  if (connection !== undefined) {
    storage.setConnection(connection);
  }
  if (priorRefreshToken !== undefined) {
    authResource.revokeToken(priorRefreshToken).catch(() => {
      /* old token expires server-side eventually */
    });
  }
}

/**
 * An `effectiveApiKey` from `options` beats `storage.getApiKey()`, and any resolved API key beats stored device tokens
 * — the precedence matches the resource layer, so an `auth_method: 'api_key'` frame can be returned even when device
 * tokens are also present in storage.
 */
export function composeAuthSnapshot(storage: AuthStorage, options: ComposeAuthSnapshotOptions = {}): AuthSnapshotFrame {
  const tokens = storage.getAuth();
  // Runtime api key (from a flag/env) wins over the stored one. When composing a status frame mid-invocation this is what matches
  // InflowResources's precedence and avoids "auth status says X but actual calls used Y" confusion.
  const apiKey =
    options.effectiveApiKey !== undefined && options.effectiveApiKey.length > 0
      ? options.effectiveApiKey
      : (storage.getApiKey() ?? undefined);
  const pending = storage.getPendingDeviceAuth();
  const connection = options.connection ?? storage.getConnection() ?? undefined;
  const credentialsPath = options.verbose ? storage.getPath() : undefined;

  // API key path takes precedence over device tokens — mirrors the resource layer (see InflowResources.authenticatedOptions).
  if (apiKey !== undefined && !pending) {
    const frame: AuthenticatedFrame = {
      authenticated: true,
      auth_method: 'api_key',
    };
    if (credentialsPath !== undefined) frame.credentials_path = credentialsPath;
    if (connection !== undefined) frame.connection = connection;
    if (options.update !== undefined) frame.update = options.update;
    return frame;
  }

  if (tokens && !pending) {
    const frame: AuthenticatedFrame = {
      authenticated: true,
      auth_method: 'device_token',
      access_token: previewAccessToken(tokens.access_token),
      token_type: tokens.token_type,
    };
    if (credentialsPath !== undefined) frame.credentials_path = credentialsPath;
    if (connection !== undefined) frame.connection = connection;
    if (options.update !== undefined) frame.update = options.update;
    return frame;
  }

  if (pending) {
    const frame: PendingFrame = {
      authenticated: false,
      pending: true,
      verification_url: pending.verification_url,
      phrase: pending.phrase,
    };
    if (credentialsPath !== undefined) frame.credentials_path = credentialsPath;
    if (connection !== undefined) frame.connection = connection;
    if (options.update !== undefined) frame.update = options.update;
    return frame;
  }

  const frame: UnauthenticatedFrame = { authenticated: false };
  if (credentialsPath !== undefined) frame.credentials_path = credentialsPath;
  if (connection !== undefined) frame.connection = connection;
  if (options.update !== undefined) frame.update = options.update;
  return frame;
}

/**
 * Each tick advances any in-flight device flow against `authResource` and persists the resulting tokens into `storage`
 * before composing the snapshot — the iterator mutates storage as a side effect rather than performing a pure read.
 */
function snapshotKey(frame: AuthSnapshotFrame): string {
  if (frame.authenticated) {
    return `auth|${frame.auth_method}|${frame.access_token ?? ''}|${frame.token_type ?? ''}`;
  }
  if ('pending' in frame) {
    return `pending|${frame.verification_url}|${frame.phrase}`;
  }
  return 'unauth';
}

export async function* pollAuthStatus(
  authResource: IAuthResource,
  storage: AuthStorage,
  options: PollAuthStatusOptions,
  composeOptions: ComposeAuthSnapshotOptions = {},
): AsyncGenerator<AuthStatusFrame> {
  for await (const outcome of pollAsync<AuthSnapshotFrame>({
    fn: async () => {
      await advancePendingFlow(authResource, storage, composeOptions.connection);
      return composeAuthSnapshot(storage, composeOptions);
    },
    isTerminal: (frame) => frame.authenticated,
    isEqual: (a, b) => snapshotKey(a) === snapshotKey(b),
    interval: options.interval,
    maxAttempts: options.maxAttempts,
    timeout: options.timeout,
  })) {
    if (outcome.terminal && outcome.reason !== undefined) {
      const terminal: TerminatedFrame = {
        authenticated: false,
        reason: outcome.reason,
      };
      if (composeOptions.verbose) terminal.credentials_path = storage.getPath();
      if (composeOptions.connection !== undefined) {
        terminal.connection = composeOptions.connection;
      } else {
        const fileConnection = storage.getConnection();
        if (fileConnection !== null) terminal.connection = fileConnection;
      }
      if (composeOptions.update !== undefined) terminal.update = composeOptions.update;
      yield terminal;
      return;
    }
    yield outcome.value;
  }
}
