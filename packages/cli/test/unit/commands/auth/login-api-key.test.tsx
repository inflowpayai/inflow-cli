import {
  augmentAuth,
  type AuthTokens,
  type DeviceAuthRequest,
  type IAuth,
  type IAuthResource,
  type IUserResource,
  InflowApiError,
  MemoryStorage,
  type User,
} from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LoginApiKey } from '../../../../src/commands/auth/login-api-key.js';

const sampleUser: User = {
  userId: 'u-1',
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  username: 'ada',
  mobile: null,
  locale: 'EN_US',
  timezone: 'UTC',
  created: '2026-01-01T00:00:00Z',
  updated: '2026-01-01T00:00:00Z',
};

const STUB_DEVICE: DeviceAuthRequest = {
  device_code: 'dc',
  user_code: 'UC',
  verification_url: '',
  verification_url_complete: '',
  expires_in: 0,
  interval: 0,
};

function authResourceStub(): IAuthResource {
  return {
    initiateDeviceAuth: vi.fn(() => Promise.resolve(STUB_DEVICE)),
    pollDeviceAuth: vi.fn(() => Promise.resolve<AuthTokens | null>(null)),
    refreshToken: vi.fn(() => Promise.reject(new Error('unused'))),
    revokeToken: vi.fn(() => Promise.resolve()),
  };
}

function makeAuth(storage: MemoryStorage, retrieve: () => Promise<User>): IAuth {
  const userResource: IUserResource = { retrieve: vi.fn(retrieve) };
  return augmentAuth(authResourceStub(), userResource, storage);
}

describe('LoginApiKey', () => {
  it('renders the validating spinner while the probe is in flight', () => {
    const storage = new MemoryStorage();
    const auth = makeAuth(storage, () => new Promise<User>(() => {})); // never settles
    const onComplete = vi.fn();

    const { lastFrame, unmount } = render(
      <LoginApiKey apiKey="ifk-test" auth={auth} connection={{ environment: 'production' }} onComplete={onComplete} />,
    );

    expect(lastFrame()).toContain('Validating API key...');
    expect(onComplete).not.toHaveBeenCalled();
    unmount();
  });

  it('persists the key, clears prior tokens, and renders the authenticated user on success', async () => {
    const storage = new MemoryStorage({
      access_token: 'old-access-token',
      refresh_token: 'old-refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const auth = makeAuth(storage, () => Promise.resolve(sampleUser));
    const onComplete = vi.fn();

    const { lastFrame, unmount } = render(
      <LoginApiKey apiKey="ifk-valid" auth={auth} connection={{ environment: 'sandbox' }} onComplete={onComplete} />,
    );

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Saved API key');
    });
    expect(lastFrame()).toContain('Authenticated as:');
    expect(lastFrame()).toContain('ada@example.test');
    expect(storage.getApiKey()).toBe('ifk-valid');
    expect(storage.getAuth()).toBeNull();
    expect(storage.getConnection()).toEqual({ environment: 'sandbox' });
    expect(onComplete).toHaveBeenCalledOnce();
    unmount();
  });

  it('renders the rejection message for a server-side 401 without persisting the key', async () => {
    const storage = new MemoryStorage();
    const rejected = new InflowApiError('Unauthorized', { status: 401 });
    const auth = makeAuth(storage, () => Promise.reject(rejected));
    const onComplete = vi.fn();

    const { lastFrame, unmount } = render(
      <LoginApiKey apiKey="ifk-bad" auth={auth} connection={{ environment: 'production' }} onComplete={onComplete} />,
    );

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('API key not accepted');
    });
    expect(lastFrame()).toContain('API key was rejected by the server (HTTP 401)');
    expect(storage.getApiKey()).toBeNull();
    expect(onComplete).toHaveBeenCalledOnce();
    unmount();
  });

  it('surfaces a generic error message verbatim in the failed branch', async () => {
    const storage = new MemoryStorage();
    const auth = makeAuth(storage, () => Promise.reject(new Error('network down')));
    const onComplete = vi.fn();

    const { lastFrame, unmount } = render(
      <LoginApiKey apiKey="ifk-any" auth={auth} connection={{ environment: 'production' }} onComplete={onComplete} />,
    );

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('API key not accepted');
    });
    expect(lastFrame()).toContain('network down');
    expect(storage.getApiKey()).toBeNull();
    unmount();
  });
});
