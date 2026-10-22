import { describe, expect, it, vi } from 'vitest';
import { InflowApiError } from '../../../src/errors.js';
import { reduceAuthLogin, runAuthLogin } from '../../../src/flows/auth-login.js';
import type { IAuthResource } from '../../../src/resources/interfaces.js';
import type { AuthTokens, DeviceAuthRequest } from '../../../src/types/index.js';
import { MemoryStorage } from '../../../src/utils/storage.js';

const sampleReq: DeviceAuthRequest = {
  device_code: 'dc-1',
  user_code: 'WXYZ-ABCD',
  verification_url: 'https://example.test/device',
  verification_url_complete: 'https://example.test/device?u=WXYZ-ABCD',
  expires_in: 600,
  interval: 5,
};

const sampleTokens: AuthTokens = {
  access_token: 'access-aaaaaaaaaaaaaaaaa',
  refresh_token: 'refresh-1',
  token_type: 'Bearer',
  expires_in: 3600,
};

function makeAuth(overrides: Partial<IAuthResource> = {}): IAuthResource {
  return {
    initiateDeviceAuth: vi.fn().mockResolvedValue(sampleReq),
    pollDeviceAuth: vi.fn().mockResolvedValue(sampleTokens),
    refreshToken: vi.fn(),
    revokeToken: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iterable) out.push(v);
  return out;
}

describe('reduceAuthLogin', () => {
  it('init + initiated -> awaiting', () => {
    expect(reduceAuthLogin({ kind: 'init' }, { type: 'initiated', req: sampleReq })).toEqual({
      kind: 'awaiting',
      req: sampleReq,
    });
  });

  it('awaiting + tokensReceived -> success', () => {
    expect(reduceAuthLogin({ kind: 'awaiting', req: sampleReq }, { type: 'tokensReceived' })).toEqual({
      kind: 'success',
    });
  });

  it('awaiting + pollExpired -> expired', () => {
    expect(reduceAuthLogin({ kind: 'awaiting', req: sampleReq }, { type: 'pollExpired' })).toEqual({ kind: 'expired' });
  });

  it('awaiting + pollTimedOut -> expired', () => {
    expect(
      reduceAuthLogin({ kind: 'awaiting', req: sampleReq }, { type: 'pollTimedOut', reason: 'max_attempts' }),
    ).toEqual({ kind: 'expired' });
  });

  it('awaiting + pollDenied -> denied', () => {
    expect(reduceAuthLogin({ kind: 'awaiting', req: sampleReq }, { type: 'pollDenied' })).toEqual({ kind: 'denied' });
  });

  it('awaiting + pollFailed -> failed with message', () => {
    expect(reduceAuthLogin({ kind: 'awaiting', req: sampleReq }, { type: 'pollFailed', message: 'oops' })).toEqual({
      kind: 'failed',
      message: 'oops',
    });
  });

  it('init + initiateFailed -> failed with message', () => {
    expect(reduceAuthLogin({ kind: 'init' }, { type: 'initiateFailed', message: 'down' })).toEqual({
      kind: 'failed',
      message: 'down',
    });
  });
});

describe('runAuthLogin', () => {
  it.each([new Error('poll unavailable'), 'poll unavailable'])(
    'reports a polling failure without replacing existing authentication: %s',
    async (error) => {
      const storage = new MemoryStorage(sampleTokens);
      const before = storage.getAuth();
      const run = runAuthLogin({
        authResource: makeAuth({ pollDeviceAuth: vi.fn().mockRejectedValue(error) }),
        authStorage: storage,
        clientName: 'Test',
        connection: { environment: 'sandbox' },
        firstPollDelayMs: 0,
      });
      expect(await drain(run.events)).toEqual([
        { type: 'initiated', req: sampleReq },
        { type: 'pollFailed', message: 'poll unavailable' },
      ]);
      expect(storage.getAuth()).toEqual(before);
      expect(storage.getConnection()).toBeNull();
    },
  );

  it('stops at the requested poll count without saving an unfinished authorization', async () => {
    const storage = new MemoryStorage();
    const pollDeviceAuth = vi.fn().mockResolvedValue(null);
    const run = runAuthLogin({
      authResource: makeAuth({ pollDeviceAuth }),
      authStorage: storage,
      clientName: 'Test',
      connection: { environment: 'sandbox' },
      firstPollDelayMs: 0,
      pollIntervalMs: 1,
      pollMaxAttempts: 2,
      pollTimeoutSeconds: 10,
    });
    expect(await drain(run.events)).toEqual([
      { type: 'initiated', req: sampleReq },
      { type: 'pollTimedOut', reason: 'max_attempts' },
    ]);
    expect(pollDeviceAuth).toHaveBeenCalledTimes(2);
    expect(storage.getAuth()).toBeNull();
  });

  it('keeps the new login when best-effort revocation of the prior refresh token fails', async () => {
    const storage = new MemoryStorage();
    const revokeToken = vi.fn().mockRejectedValue(new Error('revoke unavailable'));
    const run = runAuthLogin({
      authResource: makeAuth({ revokeToken }),
      authStorage: storage,
      clientName: 'Test',
      connection: { environment: 'sandbox' },
      firstPollDelayMs: 0,
      priorRefreshToken: 'old-refresh',
    });
    expect(await drain(run.events)).toEqual([{ type: 'initiated', req: sampleReq }, { type: 'tokensReceived' }]);
    expect(revokeToken).toHaveBeenCalledWith('old-refresh');
    expect(storage.getAuth()?.access_token).toBe(sampleTokens.access_token);
    expect(storage.getConnection()).toEqual({ environment: 'sandbox' });
  });

  it.each(['resolve', 'reject'] as const)('ignores a device poll that %ss after cancellation', async (settlement) => {
    const storage = new MemoryStorage(sampleTokens);
    const before = storage.getAuth();
    let resolvePoll: ((tokens: AuthTokens) => void) | undefined;
    let rejectPoll: ((error: Error) => void) | undefined;
    const pending = new Promise<AuthTokens>((resolve, reject) => {
      resolvePoll = resolve;
      rejectPoll = reject;
    });
    const poll = vi.fn<IAuthResource['pollDeviceAuth']>(() => pending);
    const revokeToken = vi.fn<IAuthResource['revokeToken']>();
    const run = runAuthLogin({
      authResource: makeAuth({ pollDeviceAuth: poll, revokeToken }),
      authStorage: storage,
      clientName: 'Test',
      connection: { environment: 'sandbox' },
      priorRefreshToken: 'prior',
      firstPollDelayMs: 0,
    });
    const iterator = run.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'initiated' });
    const next = iterator.next();
    await vi.waitFor(() => expect(poll).toHaveBeenCalledOnce());
    run.cancel();
    if (settlement === 'resolve') resolvePoll?.({ ...sampleTokens, access_token: 'late-token' });
    else rejectPoll?.(new Error('late failure'));
    expect(await next).toMatchObject({ done: true });
    expect(storage.getAuth()).toEqual(before);
    expect(storage.getConnection()).toBeNull();
    expect(revokeToken).not.toHaveBeenCalled();
  });

  it('does not poll when cancellation occurs while device authorization is being created', async () => {
    let resolveInitiation: ((value: DeviceAuthRequest) => void) | undefined;
    const initiation = new Promise<DeviceAuthRequest>((resolve) => {
      resolveInitiation = resolve;
    });
    const initiateDeviceAuth = vi.fn<IAuthResource['initiateDeviceAuth']>(() => initiation);
    const pollDeviceAuth = vi.fn<IAuthResource['pollDeviceAuth']>();
    const storage = new MemoryStorage();
    const run = runAuthLogin({
      authResource: makeAuth({ initiateDeviceAuth, pollDeviceAuth }),
      authStorage: storage,
      clientName: 'Test',
      connection: { environment: 'sandbox' },
      firstPollDelayMs: 0,
    });
    const completed = drain(run.events);
    expect(initiateDeviceAuth).toHaveBeenCalledOnce();
    run.cancel();
    resolveInitiation?.(sampleReq);
    expect(await completed).toEqual([]);
    expect(pollDeviceAuth).not.toHaveBeenCalled();
    expect(storage.getAuth()).toBeNull();
  });

  it('emits initiated then tokensReceived on a happy device flow, and persists to storage', async () => {
    const storage = new MemoryStorage();
    const auth = makeAuth();
    const run = runAuthLogin({
      authResource: auth,
      authStorage: storage,
      clientName: 'Test',
      connection: { environment: 'sandbox' },
      firstPollDelayMs: 0,
      pollIntervalMs: 1,
    });
    const events = await drain(run.events);

    expect(events.map((e) => e.type)).toEqual(['initiated', 'tokensReceived']);
    expect(storage.getAuth()?.access_token).toBe(sampleTokens.access_token);
    expect(storage.getConnection()).toEqual({ environment: 'sandbox' });
  });

  it('clears a pending device-auth record once tokens land', async () => {
    const storage = new MemoryStorage();
    storage.setPendingDeviceAuth({
      device_code: sampleReq.device_code,
      interval: sampleReq.interval,
      expires_at: Date.now() + 600_000,
      verification_url: sampleReq.verification_url_complete,
      phrase: sampleReq.user_code,
    });
    const run = runAuthLogin({
      authResource: makeAuth(),
      authStorage: storage,
      clientName: 'Test',
      connection: { environment: 'sandbox' },
      firstPollDelayMs: 0,
      pollIntervalMs: 1,
    });
    await drain(run.events);
    expect(storage.getPendingDeviceAuth()).toBeNull();
    expect(storage.getAuth()?.access_token).toBe(sampleTokens.access_token);
  });

  it('clears any prior api key on a successful login', async () => {
    const storage = new MemoryStorage();
    storage.setApiKey('inflow_old_key');
    const run = runAuthLogin({
      authResource: makeAuth(),
      authStorage: storage,
      clientName: 'Test',
      connection: { environment: 'sandbox' },
      firstPollDelayMs: 0,
      pollIntervalMs: 1,
    });
    await drain(run.events);
    expect(storage.getApiKey()).toBeNull();
  });

  it('best-effort revokes the prior refresh token after the new tokens land', async () => {
    const storage = new MemoryStorage();
    const revokeToken = vi.fn().mockResolvedValue(undefined);
    const auth = makeAuth({ revokeToken });
    const run = runAuthLogin({
      authResource: auth,
      authStorage: storage,
      clientName: 'Test',
      connection: { environment: 'sandbox' },
      priorRefreshToken: 'old-refresh',
      firstPollDelayMs: 0,
      pollIntervalMs: 1,
    });
    await drain(run.events);
    await vi.waitFor(() => {
      expect(revokeToken).toHaveBeenCalledWith('old-refresh');
    });
  });

  it.each([new Error('boom'), 'boom'])('emits initiateFailed when initiateDeviceAuth rejects: %s', async (failure) => {
    const auth = makeAuth({
      initiateDeviceAuth: vi.fn().mockRejectedValue(failure),
    });
    const run = runAuthLogin({
      authResource: auth,
      authStorage: new MemoryStorage(),
      clientName: 'Test',
      connection: { environment: 'sandbox' },
      firstPollDelayMs: 0,
      pollIntervalMs: 1,
    });
    const events = await drain(run.events);
    expect(events).toEqual([{ type: 'initiateFailed', message: 'boom' }]);
  });

  it('waits the default initial delay before polling and persists the authenticated session', async () => {
    vi.useFakeTimers();
    const poll = vi.fn<IAuthResource['pollDeviceAuth']>().mockResolvedValue(sampleTokens);
    const auth = makeAuth({ pollDeviceAuth: poll });
    const storage = new MemoryStorage();
    const run = runAuthLogin({
      authResource: auth,
      authStorage: storage,
      clientName: 'Test',
      connection: { environment: 'sandbox' },
    });
    const iterator = run.events[Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).value).toEqual({ type: 'initiated', req: sampleReq });
      const polling = iterator.next();
      await vi.advanceTimersByTimeAsync(999);
      expect(poll).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect((await polling).value).toMatchObject({ type: 'tokensReceived' });
      expect(poll).toHaveBeenCalledOnce();
      expect(storage.getAuth()).toMatchObject(sampleTokens);
    } finally {
      run.cancel();
      await iterator.return?.();
      vi.useRealTimers();
    }
  });

  it('emits pollExpired when pollDeviceAuth throws an expired_token InflowApiError', async () => {
    const auth = makeAuth({
      pollDeviceAuth: vi.fn().mockRejectedValue(new InflowApiError('expired', { status: 400, code: 'expired_token' })),
    });
    const run = runAuthLogin({
      authResource: auth,
      authStorage: new MemoryStorage(),
      clientName: 'Test',
      connection: { environment: 'sandbox' },
      firstPollDelayMs: 0,
      pollIntervalMs: 1,
    });
    const events = await drain(run.events);
    expect(events.map((e) => e.type)).toEqual(['initiated', 'pollExpired']);
  });

  it('emits pollDenied when pollDeviceAuth throws access_denied', async () => {
    const auth = makeAuth({
      pollDeviceAuth: vi.fn().mockRejectedValue(new InflowApiError('denied', { status: 400, code: 'access_denied' })),
    });
    const run = runAuthLogin({
      authResource: auth,
      authStorage: new MemoryStorage(),
      clientName: 'Test',
      connection: { environment: 'sandbox' },
      firstPollDelayMs: 0,
      pollIntervalMs: 1,
    });
    const events = await drain(run.events);
    expect(events.map((e) => e.type)).toEqual(['initiated', 'pollDenied']);
  });

  it('cancel() stops the iterator before the next poll', async () => {
    let pollCalls = 0;
    const auth = makeAuth({
      pollDeviceAuth: vi.fn(() => {
        pollCalls += 1;
        return Promise.resolve(null);
      }),
    });
    const run = runAuthLogin({
      authResource: auth,
      authStorage: new MemoryStorage(),
      clientName: 'Test',
      connection: { environment: 'sandbox' },
      firstPollDelayMs: 5,
      pollIntervalMs: 50,
    });
    setTimeout(() => run.cancel(), 1);
    const events = await drain(run.events);
    expect(events.find((e) => e.type === 'tokensReceived')).toBeUndefined();
    expect(pollCalls).toBeLessThanOrEqual(1);
  });
});
