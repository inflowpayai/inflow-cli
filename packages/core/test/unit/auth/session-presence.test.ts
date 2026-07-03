import { describe, expect, it } from 'vitest';
import { hasSession } from '../../../src/auth/session-presence.js';
import type { AuthTokens } from '../../../src/types/index.js';
import { MemoryStorage } from '../../../src/utils/storage.js';

const sampleAuth: AuthTokens = {
  access_token: 'a',
  refresh_token: 'r',
  token_type: 'Bearer',
  expires_in: 3600,
};

describe('hasSession', () => {
  it('returns false when neither apiKey nor stored tokens are present', () => {
    expect(hasSession(new MemoryStorage(), () => false)).toBe(false);
  });

  it('returns true when hasApiKey() resolves true regardless of storage state', () => {
    expect(hasSession(new MemoryStorage(), () => true)).toBe(true);
  });

  it('returns true when storage carries valid tokens, even with no api key', () => {
    expect(hasSession(new MemoryStorage(sampleAuth), () => false)).toBe(true);
  });

  it('short-circuits on api key: never calls storage.isAuthenticated when hasApiKey() is true', () => {
    let storageCalls = 0;
    const storage = new MemoryStorage();
    const wrapped = Object.create(storage) as typeof storage;
    wrapped.isAuthenticated = () => {
      storageCalls++;
      return false;
    };
    expect(hasSession(wrapped, () => true)).toBe(true);
    expect(storageCalls).toBe(0);
  });
});
