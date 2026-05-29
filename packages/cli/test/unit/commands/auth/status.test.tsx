import {
  augmentAuth,
  type AuthStorage,
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
import { AuthStatus } from '../../../../src/commands/auth/status.js';

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

function makeUserResource(override?: () => Promise<User>): IUserResource {
  return { retrieve: vi.fn(override ?? (() => Promise.resolve(sampleUser))) };
}

function makeAuth(
  opts: { storage: AuthStorage; userImpl?: () => Promise<User> } = { storage: new MemoryStorage() },
): IAuth {
  return augmentAuth(authResourceStub(), makeUserResource(opts.userImpl), opts.storage);
}

describe('AuthStatus (TTY component)', () => {
  it('renders the unauthenticated branch when there is no local auth', async () => {
    const storage = new MemoryStorage();
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <AuthStatus auth={makeAuth({ storage })} probe={false} onComplete={onComplete} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Not authenticated');
    });
    expect(lastFrame()).toContain('inflow auth login');
    unmount();
  });

  it('renders the authenticated branch (probe off) with the token preview', async () => {
    const storage = new MemoryStorage({
      access_token: 'access-token-abc-1234567890-xyzxyz',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(
      <AuthStatus auth={makeAuth({ storage })} probe={false} onComplete={onComplete} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Authenticated');
    });
    expect(lastFrame()).toContain('access-token-abc-123...');
    expect(lastFrame()).toContain('Bearer');
    unmount();
  });

  it('renders "Signed in as" when probe succeeds', async () => {
    const storage = new MemoryStorage({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(<AuthStatus auth={makeAuth({ storage })} probe onComplete={onComplete} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Authenticated as');
    });
    expect(lastFrame()).toContain('ada@example.test');
    unmount();
  });

  it('renders the probed_invalid note when probe returns 401', async () => {
    const storage = new MemoryStorage({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const auth = makeAuth({
      storage,
      userImpl: () => Promise.reject(new InflowApiError('unauthorized', { status: 401, code: 'unauthorized' })),
    });
    const onComplete = vi.fn();
    const { lastFrame, unmount } = render(<AuthStatus auth={auth} probe onComplete={onComplete} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Not authenticated');
    });
    expect(lastFrame()).toContain('Local credentials failed validation');
    unmount();
  });

  it('shows the update-available footer when updateNotice is provided', async () => {
    const storage = new MemoryStorage();
    const { lastFrame, unmount } = render(
      <AuthStatus
        auth={makeAuth({ storage })}
        probe={false}
        updateNotice={{ current: '0.1.0', latest: '0.2.0' }}
        onComplete={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Update available');
    });
    expect(lastFrame()).toContain('0.1.0 -> 0.2.0');
    unmount();
  });
});
