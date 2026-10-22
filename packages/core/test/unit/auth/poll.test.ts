import { describe, expect, it, vi } from 'vitest';
import { __testing, composeAuthSnapshot, pollAuthStatus } from '../../../src/auth/poll.js';
import { SecureStorageError } from '../../../src/secure-storage/errors.js';
import type { IAuthResource } from '../../../src/resources/interfaces.js';
import type { AuthTokens } from '../../../src/types/index.js';
import { MemoryStorage } from '../../../src/utils/storage.js';

const newTokens: AuthTokens = {
  access_token: 'access-token-value-aaaaaaaaaaaaaaaaa',
  refresh_token: 'new-refresh',
  token_type: 'Bearer',
  expires_in: 3600,
};

interface AuthHandles {
  resource: IAuthResource;
  pollDeviceAuth: ReturnType<typeof vi.fn>;
  revokeToken: ReturnType<typeof vi.fn>;
}

function makeAuth(poll: () => Promise<AuthTokens | null>, revokeImpl?: () => Promise<void>): AuthHandles {
  const pollDeviceAuth = vi.fn(poll);
  const revokeToken = vi.fn(revokeImpl ?? (() => Promise.resolve()));
  const resource: IAuthResource = {
    initiateDeviceAuth: vi.fn(),
    pollDeviceAuth,
    refreshToken: vi.fn(),
    revokeToken,
  };
  return { resource, pollDeviceAuth, revokeToken };
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe('pollAuthStatus', () => {
  it.each(['anonymous', 'pending', 'device', 'saved-key', 'runtime-key'] as const)(
    'reports %s authentication without leaking secrets and only includes explicitly requested metadata',
    (mode) => {
      const storage = new MemoryStorage();
      if (mode === 'device' || mode === 'saved-key') storage.setAuth(newTokens);
      if (mode === 'saved-key') storage.setApiKey('saved-secret-key');
      if (mode === 'pending')
        storage.setPendingDeviceAuth({
          device_code: 'secret-device-code',
          interval: 1,
          expires_at: Date.now() + 60_000,
          verification_url: 'https://example.test/activate',
          phrase: 'PUBLIC-PHRASE',
        });
      const options = mode === 'runtime-key' ? { effectiveApiKey: 'runtime-secret-key' } : {};
      const minimal = composeAuthSnapshot(storage, options);
      expect(minimal).not.toHaveProperty('credentials_path');
      expect(minimal).not.toHaveProperty('update');
      const update = { current_version: '0.14.1', latest_version: '0.14.2' };
      const connection = { environment: 'sandbox' as const };
      const detailed = composeAuthSnapshot(storage, { ...options, update, connection, verbose: true });
      expect(detailed).toMatchObject({ ...minimal, update, connection, credentials_path: storage.getPath() });
      expect(detailed.authenticated).toBe(['device', 'saved-key', 'runtime-key'].includes(mode));
      if (mode === 'device') expect(detailed).toMatchObject({ auth_method: 'device_token', token_type: 'Bearer' });
      if (mode.endsWith('key')) expect(detailed).toMatchObject({ auth_method: 'api_key' });
      if (mode === 'pending') expect(detailed).toMatchObject({ pending: true, phrase: 'PUBLIC-PHRASE' });
      const serialized = JSON.stringify(detailed);
      for (const secret of [
        newTokens.access_token,
        newTokens.refresh_token,
        'saved-secret-key',
        'runtime-secret-key',
        'secret-device-code',
      ]) {
        expect(serialized).not.toContain(secret);
      }
    },
  );

  it('preserves the prior login when persisting new tokens fails and does not revoke it', async () => {
    const storage = new MemoryStorage(newTokens);
    storage.setPendingDeviceAuth({
      device_code: 'dc',
      interval: 1,
      expires_at: Date.now() + 60_000,
      verification_url: 'https://example.test',
      phrase: 'P',
    });
    const replacement = { ...newTokens, access_token: 'replacement', refresh_token: 'replacement-refresh' };
    const auth = makeAuth(() => Promise.resolve(replacement));
    vi.spyOn(storage, 'setAuth').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(
      drain(pollAuthStatus(auth.resource, storage, { interval: 0, maxAttempts: 1, timeout: 30 })),
    ).rejects.toThrow('disk full');
    expect(storage.getAuth()?.refresh_token).toBe(newTokens.refresh_token);
    expect(storage.getPendingDeviceAuth()).not.toBeNull();
    expect(auth.revokeToken).not.toHaveBeenCalled();
  });

  it('keeps the successful new login when retiring the old refresh token fails', async () => {
    const storage = new MemoryStorage(newTokens);
    storage.setApiKey('old-key');
    storage.setPendingDeviceAuth({
      device_code: 'dc',
      interval: 1,
      expires_at: Date.now() + 60_000,
      verification_url: 'https://example.test',
      phrase: 'P',
    });
    const replacement = { ...newTokens, refresh_token: 'replacement-refresh' };
    const auth = makeAuth(
      () => Promise.resolve(replacement),
      () => Promise.reject(new Error('offline')),
    );
    const connection = { environment: 'sandbox' as const };
    const frames = await drain(
      pollAuthStatus(auth.resource, storage, { interval: 0, maxAttempts: 1, timeout: 30 }, { connection }),
    );
    expect(frames.at(-1)).toMatchObject({ authenticated: true, auth_method: 'device_token', connection });
    expect(storage.getAuth()?.refresh_token).toBe('replacement-refresh');
    expect(storage.getApiKey()).toBeNull();
    expect(storage.getPendingDeviceAuth()).toBeNull();
    expect(storage.getConnection()).toEqual(connection);
    expect(auth.revokeToken).toHaveBeenCalledWith(newTokens.refresh_token);
  });

  it.each([true, false])(
    'retains environment and update information in terminal polling output (override=%s)',
    async (override) => {
      const storage = new MemoryStorage();
      storage.setConnection({ environment: 'production' });
      const update = { current_version: '0.14.1', latest_version: '0.14.2' };
      const auth = makeAuth(() => Promise.resolve(null));
      const frames = await drain(
        pollAuthStatus(
          auth.resource,
          storage,
          { interval: 0.01, maxAttempts: 1, timeout: 30 },
          {
            verbose: true,
            update,
            ...(override ? { connection: { environment: 'sandbox' as const } } : {}),
          },
        ),
      );
      expect(frames.at(-1)).toEqual({
        authenticated: false,
        reason: 'max_attempts',
        credentials_path: storage.getPath(),
        update,
        connection: { environment: override ? 'sandbox' : 'production' },
      });
      expect(auth.pollDeviceAuth).not.toHaveBeenCalled();
    },
  );

  it('reports an effective API key without reading locked credential storage', () => {
    const storage = new MemoryStorage();
    const getAuth = vi.spyOn(storage, 'getAuth').mockImplementation(() => {
      throw new SecureStorageError('vault_locked', 'The InFlow vault is locked.');
    });
    const getApiKey = vi.spyOn(storage, 'getApiKey').mockImplementation(() => {
      throw new SecureStorageError('vault_locked', 'The InFlow vault is locked.');
    });

    expect(
      composeAuthSnapshot(storage, {
        connection: { environment: 'production' },
        effectiveApiKey: 'inflow_runtime_key',
      }),
    ).toEqual({
      authenticated: true,
      auth_method: 'api_key',
      connection: { environment: 'production' },
    });
    expect(getAuth).not.toHaveBeenCalled();
    expect(getApiKey).not.toHaveBeenCalled();
  });

  it('uses a fallback only for an exact missing-vault-secret error', () => {
    expect(
      __testing.readStorageValue(() => {
        throw new SecureStorageError('secure_storage_secret_missing', 'A referenced vault secret is missing.');
      }, null),
    ).toBeNull();
    expect(() =>
      __testing.readStorageValue(() => {
        throw new SecureStorageError('secure_storage_secret_missing', 'A different secret is missing.');
      }, null),
    ).toThrow('A different secret is missing.');
    expect(() =>
      __testing.readStorageValue(() => {
        throw new Error('storage failed');
      }, null),
    ).toThrow('storage failed');
  });

  it('yields authenticated:true once the in-flight device flow succeeds', async () => {
    const storage = new MemoryStorage();
    storage.setPendingDeviceAuth({
      device_code: 'dc',
      interval: 5,
      expires_at: Date.now() + 60_000,
      verification_url: 'https://example.test',
      phrase: 'P',
    });
    const sequence: Array<AuthTokens | null> = [null, newTokens];
    const auth = makeAuth(() => Promise.resolve(sequence.shift() ?? null));

    const frames = await drain(
      pollAuthStatus(auth.resource, storage, {
        interval: 0.01,
        maxAttempts: 5,
        timeout: 30,
      }),
    );
    const last = frames[frames.length - 1] as { authenticated: boolean };
    expect(last.authenticated).toBe(true);
    expect(storage.getPendingDeviceAuth()).toBeNull();
  });

  it('prefer-pending: drives the new flow even when stale auth is in storage', async () => {
    const storage = new MemoryStorage({
      access_token: 'old-access-token-aaaaaaaaaaaaaaa',
      refresh_token: 'old-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    storage.setPendingDeviceAuth({
      device_code: 'dc',
      interval: 5,
      expires_at: Date.now() + 60_000,
      verification_url: 'https://example.test',
      phrase: 'P',
    });
    const auth = makeAuth(() => Promise.resolve(newTokens));

    const frames = await drain(
      pollAuthStatus(auth.resource, storage, {
        interval: 0.01,
        maxAttempts: 5,
        timeout: 30,
      }),
    );
    expect(auth.pollDeviceAuth).toHaveBeenCalled();
    expect(storage.getAuth()?.access_token).toBe(newTokens.access_token);
    await vi.waitFor(() => {
      expect(auth.revokeToken).toHaveBeenCalledWith('old-refresh');
    });
    const last = frames[frames.length - 1] as { authenticated: boolean };
    expect(last.authenticated).toBe(true);
  });

  it('yields the terminal frame with reason=timeout when polling exceeds the deadline', async () => {
    const storage = new MemoryStorage();
    storage.setPendingDeviceAuth({
      device_code: 'dc',
      interval: 5,
      expires_at: Date.now() + 60_000,
      verification_url: 'https://example.test',
      phrase: 'P',
    });
    const auth = makeAuth(() => Promise.resolve(null));
    const frames = await drain(
      pollAuthStatus(auth.resource, storage, {
        interval: 0.05,
        maxAttempts: 0,
        timeout: 0,
      }),
    );
    const last = frames[frames.length - 1] as {
      authenticated: boolean;
      reason?: string;
    };
    expect(last.authenticated).toBe(false);
    expect(last.reason).toBe('timeout');
  });

  it('reports a max_attempts terminal frame when the cap fires before tokens', async () => {
    const storage = new MemoryStorage();
    storage.setPendingDeviceAuth({
      device_code: 'dc',
      interval: 5,
      expires_at: Date.now() + 60_000,
      verification_url: 'https://example.test',
      phrase: 'P',
    });
    const auth = makeAuth(() => Promise.resolve(null));
    const frames = await drain(
      pollAuthStatus(auth.resource, storage, {
        interval: 0.005,
        maxAttempts: 2,
        timeout: 30,
      }),
    );
    const last = frames[frames.length - 1] as {
      authenticated: boolean;
      reason?: string;
    };
    expect(last.reason).toBe('max_attempts');
  });

  it('propagates pollDeviceAuth errors out of the generator', async () => {
    const storage = new MemoryStorage();
    storage.setPendingDeviceAuth({
      device_code: 'dc',
      interval: 5,
      expires_at: Date.now() + 60_000,
      verification_url: 'https://example.test',
      phrase: 'P',
    });
    const auth = makeAuth(() => Promise.reject(new Error('boom')));
    await expect(
      drain(
        pollAuthStatus(auth.resource, storage, {
          interval: 0.01,
          maxAttempts: 5,
          timeout: 30,
        }),
      ),
    ).rejects.toThrow('boom');
    expect(storage.getAuth()).toBeNull();
  });

  it('includes the pending block on intermediate frames', async () => {
    const storage = new MemoryStorage();
    storage.setPendingDeviceAuth({
      device_code: 'dc',
      interval: 5,
      expires_at: Date.now() + 60_000,
      verification_url: 'https://example.test/device',
      phrase: 'XXXX',
    });
    const sequence: Array<AuthTokens | null> = [null, null, newTokens];
    const auth = makeAuth(() => {
      const next = sequence.shift();
      return Promise.resolve(next === undefined ? newTokens : next);
    });

    const frames = await drain(
      pollAuthStatus(auth.resource, storage, {
        interval: 0.01,
        maxAttempts: 10,
        timeout: 30,
      }),
    );
    const first = frames[0] as { pending?: boolean; verification_url?: string };
    expect(first.pending).toBe(true);
    expect(first.verification_url).toBe('https://example.test/device');
  });
});
