import type { IAuthResource } from '../resources/interfaces.js';
import type { AuthStorage } from '../utils/storage.js';
import type { AepStateStorage, PublicDocumentStateStorage } from '../aep/storage.js';

export interface AuthLogoutInput {
  /** Auth resource used to best-effort revoke the refresh token before the local clear. */
  authResource: IAuthResource;
  /** Storage whose tokens, api key, pending device auth, and connection block are cleared. */
  authStorage: AuthStorage;
}

/**
 * Performs an InFlow logout: revoke the refresh token (best-effort) then clear every authenticated artifact from local
 * storage. Mirrors the CLI's `inflow auth logout` semantics exactly.
 *
 * Order is load-bearing. The explicit `clearPendingDeviceAuth` call between `clearAuth` and `deleteConfig` prevents a
 * concurrent `auth status --interval` from completing an in-flight device flow against the just-revoked session: after
 * this call returns, any racing reader sees `pending=null` and stops pursuing the new `device_code`.
 *
 * `revokeToken` failures are swallowed — the local clear is the user-visible signal and the orphan refresh token
 * expires server-side regardless.
 */
export async function runAuthLogout(input: AuthLogoutInput): Promise<void> {
  const auth = input.authStorage.getAuth();
  if (auth?.refresh_token !== undefined) {
    try {
      await input.authResource.revokeToken(auth.refresh_token);
    } catch {
      // revoke is best-effort; the local clear is the user-visible signal
    }
  }
  input.authStorage.clearAuth();
  input.authStorage.clearApiKey();
  input.authStorage.clearPendingDeviceAuth();
  input.authStorage.clearConnection();
  if ('clearAepState' in input.authStorage) {
    (input.authStorage as AuthStorage & AepStateStorage).clearAepState();
  }
  if (!hasDocumentStorage(input.authStorage)) {
    await input.authStorage.deleteConfig();
    return;
  }
  const storage = input.authStorage as AuthStorage & PublicDocumentStateStorage;
  storage.setDiscoveryDocuments(storage.getDiscoveryDocuments());
  storage.setOpenApiDocuments(storage.getOpenApiDocuments());
}

function hasDocumentStorage(storage: AuthStorage): boolean {
  return (
    'getDiscoveryDocuments' in storage &&
    'setDiscoveryDocuments' in storage &&
    'getOpenApiDocuments' in storage &&
    'setOpenApiDocuments' in storage
  );
}
