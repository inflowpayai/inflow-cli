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
    const auth = makeAuth();
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
      expect(auth.revokeToken).toHaveBeenCalledWith('old-refresh');
    });
  });

  it('emits initiateFailed when initiateDeviceAuth throws', async () => {
    const auth = makeAuth({
      initiateDeviceAuth: vi.fn().mockRejectedValue(new Error('boom')),
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
