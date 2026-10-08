import { describe, expect, it, vi } from 'vitest';
import { InflowAuthenticationError } from '../../src/errors.js';
import type { IAuthResource } from '../../src/resources/interfaces.js';
import { createAccessTokenProvider } from '../../src/session.js';
import type { AuthTokens } from '../../src/types/index.js';
import { MemoryStorage } from '../../src/utils/storage.js';
import { runAuthLogout } from '../../src/flows/auth-logout.js';

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
  it.each(['logout', 'replacement'] as const)('rejects all pending refresh callers after %s', async (change) => {
    const storage = new MemoryStorage({ ...initialTokens, expires_at: 0 });
    let resolvePending = (_tokens: AuthTokens): void => {
      throw new Error('Refresh has not started');
    };
    const pending = {
      promise: new Promise<AuthTokens>((resolve) => {
        resolvePending = resolve;
      }),
    };
    const { resource } = makeAuthResource(() => pending.promise);
    const provide = createAccessTokenProvider(resource, storage);
    const results = Promise.allSettled([provide(), provide()]);
    if (change === 'logout') await runAuthLogout({ authResource: resource, authStorage: storage });
    else storage.setAuth({ ...initialTokens, access_token: 'replacement' });
    resolvePending({ ...initialTokens, access_token: 'stale' });
    expect(
      (await results).every(
        (result) => result.status === 'rejected' && result.reason instanceof InflowAuthenticationError,
      ),
    ).toBe(true);
    expect(storage.getAuth()?.access_token ?? null).toBe(change === 'logout' ? null : 'replacement');
  });

  it('does not share refreshes between different sessions', async () => {
    const storage = new MemoryStorage({ ...initialTokens, expires_at: 0 });
    let resolveOld = (_tokens: AuthTokens): void => {
      throw new Error('Refresh has not started');
    };
    const old = {
      promise: new Promise<AuthTokens>((resolve) => {
        resolveOld = resolve;
      }),
    };
    const { resource, refreshSpy } = makeAuthResource(() => old.promise);
    const provide = createAccessTokenProvider(resource, storage);
    const oldResult = Promise.allSettled([provide()]);
    storage.setAuth({ ...initialTokens, access_token: 'new', expires_at: 0 });
    refreshSpy.mockResolvedValueOnce({ ...initialTokens, access_token: 'new-refreshed' });
    expect(await provide()).toBe('new-refreshed');
    resolveOld({ ...initialTokens, access_token: 'stale' });
    expect((await oldResult)[0].status).toBe('rejected');
    expect(storage.getAuth()?.access_token).toBe('new-refreshed');
  });

  it('reads only the access secret on the unexpired path', async () => {
    const storage = new MemoryStorage(initialTokens);
    const read = vi.spyOn(storage, 'getAuthToken');
    const fullRead = vi.spyOn(storage, 'getAuth');
    const { resource } = makeAuthResource(() => Promise.resolve(initialTokens));
    expect(await createAccessTokenProvider(resource, storage)()).toBe('access-1');
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(expect.any(String), 'access');
    expect(fullRead).not.toHaveBeenCalled();
  });
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
