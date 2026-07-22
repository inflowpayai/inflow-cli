import { InflowApiError } from '../errors.js';
import type { IUserResource } from '../resources/interfaces.js';
import type { User } from '../types/index.js';
import type { AuthStorage, ConnectionSettings } from '../utils/storage.js';

/**
 * State machine for the API-key login flow. Mirrors the device-flow phase shape so consumers can switch on `kind`
 * uniformly across both login paths.
 */
export type AuthLoginApiKeyPhase =
  { kind: 'validating' } | { kind: 'saved'; user: User } | { kind: 'failed'; message: string };

export type AuthLoginApiKeyEvent = { type: 'validated'; user: User } | { type: 'failed'; message: string };

export function reduceAuthLoginApiKey(_state: AuthLoginApiKeyPhase, event: AuthLoginApiKeyEvent): AuthLoginApiKeyPhase {
  switch (event.type) {
    case 'validated':
      return { kind: 'saved', user: event.user };
    case 'failed':
      return { kind: 'failed', message: event.message };
  }
}

export interface AuthLoginApiKeyInput {
  /** The API key being installed. Used both for probe-validation (via the user resource) and for persistence. */
  apiKey: string;
  /** Storage written to on success (auth tokens cleared; api key + connection saved). */
  authStorage: AuthStorage;
  /**
   * User resource used for validation. Caller is responsible for constructing it with the API key already in its
   * configured credentials — `runAuthLoginApiKey` does not thread the key into the resource itself.
   */
  userResource: IUserResource;
  /** Effective connection settings persisted alongside the credentials on success. */
  connection: ConnectionSettings;
}

export interface AuthLoginApiKeyRun {
  /** Event stream from validation through the terminal frame. */
  events: AsyncIterable<AuthLoginApiKeyEvent>;
}

/**
 * Validate an API key by probing the user endpoint, then persist it. Mirrors the device-flow runner pattern: returns an
 * async-iterable that yields exactly one terminal event (`validated` or `failed`). Storage writes happen _only_ after
 * the probe succeeds, in the order: clear prior tokens → clear pending device flow → write key → write connection.
 *
 * Error classification: a server-side 401 is surfaced as a user-facing message ("API key was rejected...") rather than
 * the raw fetch error; any other thrown value collapses into a `failed` event carrying its `.message`.
 */
export function runAuthLoginApiKey(input: AuthLoginApiKeyInput): AuthLoginApiKeyRun {
  async function* generate(): AsyncGenerator<AuthLoginApiKeyEvent> {
    try {
      const user = await input.userResource.retrieve();
      input.authStorage.clearAuth();
      input.authStorage.clearPendingDeviceAuth();
      input.authStorage.setApiKey(input.apiKey);
      input.authStorage.setConnection(input.connection);
      yield { type: 'validated', user };
    } catch (error) {
      const message =
        error instanceof InflowApiError && error.status === 401
          ? 'API key was rejected by the server (HTTP 401). Check the key value and try again.'
          : error instanceof Error
            ? error.message
            : String(error);
      yield { type: 'failed', message };
    }
  }

  return { events: generate() };
}
