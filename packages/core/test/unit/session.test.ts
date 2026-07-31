import { describe, expect, it, vi } from 'vitest';
import { InflowAuthenticationError } from '../../src/errors.js';
import type { IAuthResource } from '../../src/resources/interfaces.js';
import { createAccessTokenProvider } from '../../src/session.js';
import type { AuthTokens } from '../../src/types/index.js';
import { MemoryStorage } from '../../src/utils/storage.js';

function makeAuthResource(refresh: () => Promise<AuthTokens>): {
  resource: IAuthResource;
  refreshSpy: ReturnType<typeof vi.fn>;
} {
  const refreshSpy = vi.fn(refresh);
  const resource: IAuthResource = {
    initiateDeviceAuth: vi.fn(),
    pollDeviceAuth: vi.fn(),
    refreshToken: refreshSpy,
    revokeToken: vi.fn(),
  };
  return { resource, refreshSpy };
}

const initialTokens: AuthTokens = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  token_type: 'Bearer',
  expires_in: 3600,
};

describe('createAccessTokenProvider', () => {
  it('throws InflowAuthenticationError when storage is empty', async () => {
    const storage = new MemoryStorage();
    const { resource } = makeAuthResource(() => Promise.resolve(initialTokens));
    const provide = createAccessTokenProvider(resource, storage);
    await expect(provide()).rejects.toBeInstanceOf(InflowAuthenticationError);
  });

  it('returns cached token when not expired and forceRefresh is false', async () => {
    const storage = new MemoryStorage({
      ...initialTokens,
      expires_at: Date.now() + 5 * 60_000,
    });
    const { resource, refreshSpy } = makeAuthResource(() =>
      Promise.resolve({ ...initialTokens, access_token: 'rotated' }),
    );
    const provide = createAccessTokenProvider(resource, storage);
    expect(await provide()).toBe('access-1');
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('observes credential changes during one provider lifetime', async () => {
    const storage = new MemoryStorage({
      ...initialTokens,
      expires_at: Date.now() + 5 * 60_000,
    });
    const { resource } = makeAuthResource(() => Promise.resolve({ ...initialTokens, access_token: 'rotated' }));
    const provide = createAccessTokenProvider(resource, storage);

    expect(await provide()).toBe('access-1');
    storage.setAuth({ ...initialTokens, access_token: 'access-2', expires_at: Date.now() + 5 * 60_000 });
    expect(await provide()).toBe('access-2');
    storage.clearAuth();
    await expect(provide()).rejects.toBeInstanceOf(InflowAuthenticationError);
  });

  it('refreshes when expiry within the 60s buffer', async () => {
    const storage = new MemoryStorage({
      ...initialTokens,
      expires_at: Date.now() + 30_000,
    });
    const { resource, refreshSpy } = makeAuthResource(() =>
      Promise.resolve({
        ...initialTokens,
        access_token: 'rotated',
        refresh_token: 'refresh-2',
      }),
    );
    const provide = createAccessTokenProvider(resource, storage);
    expect(await provide()).toBe('rotated');
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(storage.getAuth()?.refresh_token).toBe('refresh-2');
  });

  it('forceRefresh triggers a refresh even when token is fresh', async () => {
    const storage = new MemoryStorage({
      ...initialTokens,
      expires_at: Date.now() + 60 * 60_000,
    });
    const { resource, refreshSpy } = makeAuthResource(() =>
      Promise.resolve({ ...initialTokens, access_token: 'rotated' }),
    );
    const provide = createAccessTokenProvider(resource, storage);
    expect(await provide({ forceRefresh: true })).toBe('rotated');
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight refresh across concurrent callers', async () => {
    const storage = new MemoryStorage({
      ...initialTokens,
      expires_at: Date.now() + 30_000,
    });
    let resolve!: (v: AuthTokens) => void;
    const pending = new Promise<AuthTokens>((r) => {
      resolve = r;
    });
    const { resource, refreshSpy } = makeAuthResource(() => pending);
    const provide = createAccessTokenProvider(resource, storage);

    const promises = [provide(), provide(), provide()];
    resolve({
      ...initialTokens,
      access_token: 'rotated',
      refresh_token: 'refresh-2',
    });
    const results = await Promise.all(promises);
    expect(results.every((r) => r === 'rotated')).toBe(true);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight slot on refresh failure', async () => {
    const storage = new MemoryStorage({
      ...initialTokens,
      expires_at: Date.now() + 30_000,
    });
    let attempt = 0;
    const { resource, refreshSpy } = makeAuthResource(() => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve({ ...initialTokens, access_token: 'second' });
    });
    const provide = createAccessTokenProvider(resource, storage);

    await expect(provide()).rejects.toThrow('boom');
    expect(await provide()).toBe('second');
    expect(refreshSpy).toHaveBeenCalledTimes(2);
  });
});
