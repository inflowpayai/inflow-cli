import {
  augmentAuth,
  type AuthTokens,
  type DeviceAuthRequest,
  type IAuth,
  type IAuthResource,
  type IUserResource,
  MemoryStorage,
} from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Login } from '../../../../src/commands/auth/login.js';

const sampleRequest: DeviceAuthRequest = {
  device_code: 'dc-2',
  user_code: 'EEEE-FFFF',
  verification_url: 'https://app.inflowpay.ai/device/',
  verification_url_complete: 'https://app.inflowpay.ai/device/?code=EEEE-FFFF',
  expires_in: 1,
  interval: 5,
};

afterEach(() => {
  vi.useRealTimers();
});

function rawAuthStub(overrides: Partial<IAuthResource> = {}): IAuthResource {
  return {
    initiateDeviceAuth: vi.fn(() => Promise.resolve(sampleRequest)),
    pollDeviceAuth: vi.fn(() => Promise.resolve(null as AuthTokens | null)),
    refreshToken: vi.fn(),
    revokeToken: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function authStub(overrides: Partial<IAuthResource> = {}, storage = new MemoryStorage()): IAuth {
  const user: IUserResource = { retrieve: vi.fn() };
  return augmentAuth(rawAuthStub(overrides), user, storage);
}

describe('Login — extra branches', () => {
  it('surfaces an authentication failure when initiateDeviceAuth rejects with an Error', async () => {
    const auth = authStub({
      initiateDeviceAuth: vi.fn(() => Promise.reject(new Error('network down'))),
    });
    const { lastFrame, unmount } = render(
      <Login auth={auth} clientName="Test" connection={{ environment: 'production' }} onComplete={() => undefined} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Authentication failed');
    });
    expect(lastFrame()).toContain('network down');
    unmount();
  });

  it('surfaces an authentication failure when initiateDeviceAuth rejects with a bare string', async () => {
    const auth = authStub({
      initiateDeviceAuth: vi.fn(() => Promise.reject('bare-string-fail')),
    });
    const { lastFrame, unmount } = render(
      <Login auth={auth} clientName="Test" connection={{ environment: 'production' }} onComplete={() => undefined} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Authentication failed');
    });
    expect(lastFrame()).toContain('bare-string-fail');
    unmount();
  });

  it('falls back to the failed frame with a string message when polling rejects with a non-Error value', async () => {
    const auth = authStub({
      pollDeviceAuth: vi.fn(() => Promise.reject('boom-from-server')),
    });
    const { lastFrame, unmount } = render(
      <Login auth={auth} clientName="Test" connection={{ environment: 'production' }} onComplete={() => undefined} />,
    );
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('Authentication failed');
      },
      { timeout: 10_000 },
    );
    expect(lastFrame()).toContain('boom-from-server');
    unmount();
  });

  it('renders the expired frame when the poll deadline elapses (device_code expires_in=1)', async () => {
    const auth = authStub({
      pollDeviceAuth: vi.fn(() => Promise.resolve(null)),
    });
    const { lastFrame, unmount } = render(
      <Login auth={auth} clientName="Test" connection={{ environment: 'production' }} onComplete={() => undefined} />,
    );
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('Device code expired');
      },
      { timeout: 10_000 },
    );
    unmount();
  });
});
