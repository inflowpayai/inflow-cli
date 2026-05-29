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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthStatus } from '../../../../src/commands/auth/status.js';

const tokens: AuthTokens = {
  access_token: 'access-token-aaaaaaaaaaaaaaaaaaaaaaaa',
  refresh_token: 'r',
  token_type: 'Bearer',
  expires_in: 3600,
};

const sampleUser: User = {
  userId: 'u-1',
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  username: 'ada',
  mobile: null,
  locale: 'EN_US',
  timezone: 'UTC',
  created: '2025-01-01T00:00:00Z',
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

function userStub(impl?: (opts?: { signal?: AbortSignal }) => Promise<User>): IUserResource {
  return { retrieve: vi.fn(impl ?? (() => Promise.resolve(sampleUser))) };
}

function makeAuth(
  opts: { storage: AuthStorage; userImpl?: (opts?: { signal?: AbortSignal }) => Promise<User> } = {
    storage: new MemoryStorage(),
  },
): IAuth {
  return augmentAuth(authResourceStub(), userStub(opts.userImpl), opts.storage);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AuthStatus', () => {
  it('renders the unauthenticated frame with the credentials path when verbose is on', async () => {
    const storage = new MemoryStorage();
    const { lastFrame, unmount } = render(
      <AuthStatus auth={makeAuth({ storage })} probe={false} verbose onComplete={() => undefined} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Not authenticated');
    });
    expect(lastFrame()).toContain('Credentials: memory');
    unmount();
  });

  it('does NOT render the credentials path when verbose is off', async () => {
    const storage = new MemoryStorage();
    const { lastFrame, unmount } = render(
      <AuthStatus auth={makeAuth({ storage })} probe={false} onComplete={() => undefined} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Not authenticated');
    });
    expect(lastFrame() ?? '').not.toContain('Credentials:');
    unmount();
  });

  it('renders the authenticated frame with the access token preview when not probing', async () => {
    const storage = new MemoryStorage(tokens);
    const { lastFrame, unmount } = render(
      <AuthStatus auth={makeAuth({ storage })} probe={false} onComplete={() => undefined} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Authenticated');
    });
    expect(lastFrame()).toContain('Access token:');
    expect(lastFrame()).toContain('Bearer');
    unmount();
  });

  it('renders the authenticated frame with the user line on successful probe', async () => {
    const storage = new MemoryStorage(tokens);
    const { lastFrame, unmount } = render(
      <AuthStatus auth={makeAuth({ storage })} probe={true} onComplete={() => undefined} />,
    );
    await vi.waitFor(() => {
      // Label was unified across auth methods.
      expect(lastFrame()).toContain('Authenticated as:');
    });
    expect(lastFrame()).toContain('ada@example.test');
    unmount();
  });

  it('renders the api-key authenticated frame (Method: API key, Authenticated as, no Access token)', async () => {
    const storage = new MemoryStorage();
    const { lastFrame, unmount } = render(
      <AuthStatus
        auth={makeAuth({ storage })}
        probe={true}
        apiKey="inflow_live_runtime"
        onComplete={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Method: API key');
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Authenticated as:');
    expect(frame).toContain('ada@example.test');
    expect(frame).not.toContain('API key:');
    expect(frame).not.toContain('Access token:');
    expect(frame).not.toContain('Token type:');
    unmount();
  });

  it('renders the Environment + API base URL from displayConnection even when storage has no saved connection', async () => {
    const storage = new MemoryStorage();
    const { lastFrame, unmount } = render(
      <AuthStatus
        auth={makeAuth({ storage })}
        probe={false}
        apiKey="inflow_live_runtime"
        displayConnection={{
          environment: 'sandbox',
          apiBaseUrl: 'https://sandbox.inflowpay.ai',
        }}
        onComplete={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Method: API key');
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Environment:');
    expect(frame).toContain('sandbox');
    expect(frame).toContain('API base URL:');
    expect(frame).toContain('https://sandbox.inflowpay.ai');
    unmount();
  });

  it('renders the Connection block when storage has saved settings', async () => {
    const storage = new MemoryStorage(tokens);
    storage.setConnection({
      environment: 'sandbox',
      apiBaseUrl: 'https://dev.inflowpay.ai',
    });
    const { lastFrame, unmount } = render(
      <AuthStatus auth={makeAuth({ storage })} probe={false} onComplete={() => undefined} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Authenticated');
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Environment:');
    expect(frame).toContain('sandbox');
    expect(frame).toContain('API base URL:');
    expect(frame).toContain('https://dev.inflowpay.ai');
    unmount();
  });

  it('falls back to the probed-invalid frame on a 401 probe response', async () => {
    const storage = new MemoryStorage(tokens);
    const auth = makeAuth({
      storage,
      userImpl: () => Promise.reject(new InflowApiError('unauthorized', { status: 401, code: 'unauthorized' })),
    });
    const { lastFrame, unmount } = render(<AuthStatus auth={auth} probe={true} onComplete={() => undefined} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Not authenticated');
    });
    expect(lastFrame()).toContain('Local credentials failed validation');
    unmount();
  });

  it('renders the probe-failed frame on non-401 probe errors', async () => {
    const storage = new MemoryStorage(tokens);
    const auth = makeAuth({
      storage,
      userImpl: () => Promise.reject(new Error('network broken')),
    });
    const { lastFrame, unmount } = render(<AuthStatus auth={auth} probe={true} onComplete={() => undefined} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Probe failed');
    });
    expect(lastFrame()).toContain('network broken');
    unmount();
  });

  it('renders the probe-failed frame with a string fallback when probe rejects with a non-Error', async () => {
    const storage = new MemoryStorage(tokens);
    const auth = makeAuth({
      storage,
      userImpl: () => Promise.reject('boom'),
    });
    const { lastFrame, unmount } = render(<AuthStatus auth={auth} probe={true} onComplete={() => undefined} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Probe failed');
    });
    expect(lastFrame()).toContain('boom');
    unmount();
  });

  it('appends the update footer when updateNotice is provided', async () => {
    const storage = new MemoryStorage(tokens);
    const { lastFrame, unmount } = render(
      <AuthStatus
        auth={makeAuth({ storage })}
        probe={false}
        updateNotice={{ current: '0.1.0', latest: '0.2.0' }}
        onComplete={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Update available: 0.1.0 -> 0.2.0');
    });
    unmount();
  });
});
