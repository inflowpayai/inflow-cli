import type { IUserResource } from '../resources/interfaces.js';
import type { User } from '../types/index.js';

/** User profile projection without server audit timestamps. */
export type UserAgentPayload = Omit<User, 'created' | 'updated'>;

export function projectUserPayload(user: User): UserAgentPayload {
  const { created: _created, updated: _updated, ...rest } = user;
  return rest;
}

/** Renderer-friendly row used by the TTY profile view. `value` is `null` when the underlying field is null or empty. */
export interface ProfileRow {
  label: string;
  value: string | null;
}

/**
 * Join `firstName` + `lastName` into a single display string. Returns whichever half is present when only one is set,
 * or `null` when neither is.
 */
export function joinName(first: string | null, last: string | null): string | null {
  if (first !== null && last !== null) return `${first} ${last}`;
  if (first !== null) return first;
  if (last !== null) return last;
  return null;
}

/**
 * Compose the row list the TTY profile view renders. Every candidate row is emitted regardless of value — empty fields
 * are surfaced in the renderer as a dim em dash so users see which fields exist on the profile but currently have no
 * value.
 *
 * Defensive coercion: the {@link User} type declares each candidate field as `string | null`, but if the server omits
 * the field entirely the runtime value is `undefined`. Without the typeof check, undefined would slip past `!== null`
 * in the renderer and produce a visually blank row instead of the em dash.
 */
export function buildProfileRows(user: User): ProfileRow[] {
  const candidates: Array<readonly [string, string | null]> = [
    ['User ID', user.userId],
    ['Email', user.email],
    ['Username', user.username],
    ['Full Name', joinName(user.firstName, user.lastName)],
    ['Mobile', user.mobile],
    ['Locale', user.locale],
    ['Timezone', user.timezone],
  ];
  return candidates.map(([label, value]) => ({
    label,
    value: typeof value === 'string' && value.length > 0 ? value : null,
  }));
}

export interface UserGetInput {
  userResource: IUserResource;
}

/**
 * Retrieves the authenticated user and applies the agent-mode projection. Equivalent to `projectUserPayload(await
 * input.userResource.retrieve())`; provided so SDK consumers don't have to know which fields the CLI hides from its
 * agent output.
 */
export async function runUserGet(input: UserGetInput): Promise<UserAgentPayload> {
  const user = await input.userResource.retrieve();
  return projectUserPayload(user);
}
