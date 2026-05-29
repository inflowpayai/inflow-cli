import {
  augmentAuth,
  type AuthTokens,
  type DeviceAuthRequest,
  type IAuthResource,
  type IUserResource,
  InflowApiError,
  MemoryStorage,
} from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Login } from '../../../../src/commands/auth/login.js';

const userStub: IUserResource = { retrieve: vi.fn() };

const sampleRequest: DeviceAuthRequest = {
  device_code: 'dc-1',
  user_code: 'ABCD-WXYZ',
  verification_url: 'https://app.inflowpay.ai/device/',
  verification_url_complete: 'https://app.inflowpay.ai/device/?code=ABCD-WXYZ',
  expires_in: 600,
  interval: 5,
};

const sampleTokens: AuthTokens = {
  access_token: 'access-token-value-aaaaaaaaaaaaaaaaaaaaaaaaaa',
  refresh_token: 'refresh-token-value',
  token_type: 'Bearer',
  expires_in: 3600,
};

interface StubAuthOptions {
  initiate?: () => Promise<DeviceAuthRequest>;
  pollSequence?: Array<AuthTokens | null | Error>;
  revoke?: () => Promise<void>;
}

interface StubAuthHandles {
  resource: IAuthResource;
  initiateDeviceAuth: ReturnType<typeof vi.fn>;
  pollDeviceAuth: ReturnType<typeof vi.fn>;
  refreshToken: ReturnType<typeof vi.fn>;
  revokeToken: ReturnType<typeof vi.fn>;
}

function makeAuthResource(options: StubAuthOptions = {}): StubAuthHandles {
  const initiate = options.initiate ?? (() => Promise.resolve(sampleRequest));
  const queue = [...(options.pollSequence ?? [sampleTokens])];
  const initiateDeviceAuth = vi.fn(initiate);
  const pollDeviceAuth = vi.fn(() => {
    const next = queue.shift();
    if (next instanceof Error) return Promise.reject(next);
    if (next === undefined) return Promise.resolve(null);
    return Promise.resolve(next);
  });
  const refreshToken = vi.fn();
  const revokeToken = vi.fn(options.revoke ?? (() => Promise.resolve()));
  const resource: IAuthResource = {
    initiateDeviceAuth,
    pollDeviceAuth,
    refreshToken,
    revokeToken,
  };
  return { resource, initiateDeviceAuth, pollDeviceAuth, refreshToken, revokeToken };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Login', () => {
  it('renders the verification box once the device code is initiated', async () => {
    const storage = new MemoryStorage();
    const onComplete = vi.fn();
    const auth = makeAuthResource({
      pollSequence: [null, null, null], // never produce tokens during this test
    });

    const { lastFrame, unmount } = render(
      <Login
        auth={augmentAuth(auth.resource, userStub, storage)}
        clientName="Test"
        connection={{ environment: 'production' }}
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(() => {
      expect(lastFrame()).toContain(sampleRequest.verification_url_complete);
    });
    expect(lastFrame()).toContain(sampleRequest.user_code);
    expect(lastFrame()).toContain('Waiting for authorization');
    unmount();
  });

  it('writes tokens to storage and renders success when the poll yields tokens', async () => {
    const storage = new MemoryStorage();
    const onComplete = vi.fn();
    const auth = makeAuthResource({
      pollSequence: [null, sampleTokens],
    });

    const { lastFrame, unmount } = render(
      <Login
        auth={augmentAuth(auth.resource, userStub, storage)}
        clientName="Test"
        connection={{ environment: 'production' }}
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('Successfully authenticated');
      },
      { timeout: 10_000 },
    );
    expect(storage.getAuth()?.access_token).toBe(sampleTokens.access_token);
    unmount();
  });

  it('preserves the prior session when poll throws expired_token', async () => {
    const expired = new InflowApiError('Device code expired.', {
      status: 400,
      code: 'expired_token',
    });
    const storage = new MemoryStorage({
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const auth = makeAuthResource({ pollSequence: [expired] });
    const setAuthSpy = vi.spyOn(storage, 'setAuth');
    const onComplete = vi.fn();

    const { lastFrame, unmount } = render(
      <Login
        auth={augmentAuth(auth.resource, userStub, storage)}
        clientName="Test"
        connection={{ environment: 'production' }}
        priorRefreshToken="old-refresh"
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('Device code expired');
      },
      { timeout: 10_000 },
    );
    expect(setAuthSpy).not.toHaveBeenCalled();
    expect(auth.revokeToken).not.toHaveBeenCalled();
    expect(storage.getAuth()?.access_token).toBe('old-access');
    unmount();
  });

  it('renders the denied branch when poll throws access_denied', async () => {
    const denied = new InflowApiError('Authorization denied by user.', {
      status: 400,
      code: 'access_denied',
    });
    const storage = new MemoryStorage();
    const auth = makeAuthResource({ pollSequence: [denied] });
    const onComplete = vi.fn();

    const { lastFrame, unmount } = render(
      <Login
        auth={augmentAuth(auth.resource, userStub, storage)}
        clientName="Test"
        connection={{ environment: 'production' }}
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('Authorization denied');
      },
      { timeout: 10_000 },
    );
    unmount();
  });

  it('calls setAuth before revokeToken on safe-rebind', async () => {
    const storage = new MemoryStorage({
      access_token: 'old-access-token-aaaaaaaaaaaaaaaaaa',
      refresh_token: 'old-refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const callOrder: string[] = [];
    const setAuthSpy = vi.spyOn(storage, 'setAuth').mockImplementation((tokens) => {
      callOrder.push('setAuth');
      MemoryStorage.prototype.setAuth.call(storage, tokens);
    });
    const auth = makeAuthResource({ pollSequence: [sampleTokens] });
    auth.revokeToken.mockImplementation(() => {
      callOrder.push('revokeToken');
      return Promise.resolve();
    });
    const onComplete = vi.fn();

    const { lastFrame, unmount } = render(
      <Login
        auth={augmentAuth(auth.resource, userStub, storage)}
        clientName="Test"
        connection={{ environment: 'production' }}
        priorRefreshToken="old-refresh-token"
        onComplete={onComplete}
      />,
    );

    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('Successfully authenticated');
      },
      { timeout: 10_000 },
    );
    expect(setAuthSpy).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(auth.revokeToken).toHaveBeenCalledWith('old-refresh-token');
    });
    expect(callOrder.indexOf('setAuth')).toBeLessThan(callOrder.indexOf('revokeToken'));
    unmount();
  });
});
