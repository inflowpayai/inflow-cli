import { MemoryStorage, type AuthStorage } from '@inflowpayai/inflow-core';
import { describe, expect, it } from 'vitest';
import { persistedAepPublicDocumentCache } from '../../../src/utils/aep-public-document-cache.js';

function authStorageOnly(): AuthStorage {
  return {
    clearAll: () => undefined,
    clearApiKey: () => undefined,
    clearAuth: () => undefined,
    clearConnection: () => undefined,
    clearPendingDeviceAuth: () => undefined,
    deleteConfig: () => Promise.resolve(),
    getApiKey: () => null,
    getAuth: () => null,
    getConnection: () => null,
    getPath: () => 'memory',
    getPendingDeviceAuth: () => null,
    isAuthenticated: () => false,
    setApiKey: () => undefined,
    setAuth: () => undefined,
    setConnection: () => undefined,
    setPendingDeviceAuth: () => undefined,
  };
}

describe('persistedAepPublicDocumentCache', () => {
  it('returns a cache for storage with public document methods', () => {
    expect(persistedAepPublicDocumentCache(new MemoryStorage())).toBeDefined();
  });

  it('returns undefined for auth-only storage', () => {
    expect(persistedAepPublicDocumentCache(authStorageOnly())).toBeUndefined();
  });
});
