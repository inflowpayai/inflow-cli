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
