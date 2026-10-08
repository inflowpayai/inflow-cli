import { InflowAuthenticationError } from './errors.js';
import type { IAuthResource } from './resources/interfaces.js';
import type { AuthStorage } from './utils/storage.js';

export interface GetAccessTokenOptions {
  forceRefresh?: boolean;
}

export type AccessTokenProvider = (options?: GetAccessTokenOptions) => Promise<string>;

const EXPIRY_BUFFER_MS = 60_000;

export function createAccessTokenProvider(authResource: IAuthResource, authStorage: AuthStorage): AccessTokenProvider {
  const inFlightRefresh = new Map<string, Promise<string>>();

  return async ({ forceRefresh = false } = {}) => {
    const auth = authStorage.getAuthSession();
    if (!auth) {
      throw new InflowAuthenticationError('Not authenticated. Run "inflow auth login" first.');
    }

    const isExpired = auth.expiresAt !== undefined && Date.now() >= auth.expiresAt - EXPIRY_BUFFER_MS;

    if (!forceRefresh && !isExpired) {
      return authStorage.getAuthToken(auth.id, 'access');
    }

    let refresh = inFlightRefresh.get(auth.id);
    if (refresh === undefined) {
      refresh = authResource
        .refreshToken(authStorage.getAuthToken(auth.id, 'refresh'))
        .then((refreshed) => {
          return authStorage.setAuth(refreshed, auth.id);
        })
        .finally(() => {
          inFlightRefresh.delete(auth.id);
        });
      inFlightRefresh.set(auth.id, refresh);
    }
    return authStorage.getAuthToken(await refresh, 'access');
  };
}
