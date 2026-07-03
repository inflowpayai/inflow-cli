import {
  type AuthenticatedFrame,
  composeAuthSnapshot,
  type ComposeAuthSnapshotOptions,
  type PendingFrame,
  type UnauthenticatedFrame,
} from '../auth/poll.js';
import { InflowApiError } from '../errors.js';
import type { IUserResource } from '../resources/interfaces.js';
import type { User } from '../types/index.js';
import type { AuthStorage } from '../utils/storage.js';

/**
 * Result of {@link probeAuthStatus}. `authenticated` carries the snapshot plus the freshly-fetched user; `invalid` is
 * the 401-rejected envelope the CLI emits when stored credentials are no longer accepted; `error` wraps any other
 * thrown value so the caller can decide how to surface it.
 */
export type AuthStatusProbeResult =
  | { kind: 'pending'; frame: PendingFrame }
  | { kind: 'unauthenticated'; frame: UnauthenticatedFrame }
  | { kind: 'authenticated'; frame: AuthenticatedFrame; user: User }
  | { kind: 'invalid'; frame: Record<string, unknown> }
  | { kind: 'error'; error: unknown };

export interface AuthStatusProbeInput {
  authStorage: AuthStorage;
  userResource: IUserResource;
  composeOptions?: ComposeAuthSnapshotOptions;
}

/**
 * "Probe" variant of the auth-status flow. Composes a snapshot, then for the authenticated branch additionally verifies
 * the credentials against the server by retrieving the user. A 401 from that retrieve produces an `invalid` envelope
 * explaining how to recover (re-login or logout); other thrown values surface as `error`.
 *
 * This is the _agent-mode_ logic — no polling, no rendering, no incur. The CLI's `auth status --probe` command wraps
 * this with its own update-probe + connection-merge plumbing.
 */
export async function probeAuthStatus(input: AuthStatusProbeInput): Promise<AuthStatusProbeResult> {
  const snapshot = composeAuthSnapshot(input.authStorage, input.composeOptions ?? {});

  if (!snapshot.authenticated) {
    if ('pending' in snapshot) {
      return { kind: 'pending', frame: snapshot };
    }
    return { kind: 'unauthenticated', frame: snapshot };
  }

  try {
    const user = await input.userResource.retrieve();
    return { kind: 'authenticated', frame: snapshot, user };
  } catch (error) {
    if (error instanceof InflowApiError && error.status === 401) {
      const rejected: Record<string, unknown> = {
        authenticated: false,
        probed_invalid: true,
        note:
          snapshot.auth_method === 'api_key'
            ? 'API key failed server validation (HTTP 401). Re-authenticate with "inflow auth login --api-key <key>" or clear with "inflow auth logout".'
            : 'Local token failed server validation. Clear with "inflow auth logout" or re-authenticate with "inflow auth login".',
      };
      if (snapshot.connection !== undefined) {
        rejected['connection'] = snapshot.connection;
      }
      return { kind: 'invalid', frame: rejected };
    }
    return { kind: 'error', error };
  }
}
