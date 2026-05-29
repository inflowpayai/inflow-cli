import {
  augmentAuth,
  type IAuth,
  type IAuthResource,
  type IUserResource,
  MemoryStorage,
} from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Logout } from '../../../../src/commands/auth/logout.js';

interface AuthHandles {
  resource: IAuth;
  revokeToken: ReturnType<typeof vi.fn>;
}

function makeAuthResource(storage: MemoryStorage): AuthHandles {
  const revokeToken = vi.fn(() => Promise.resolve());
  const raw: IAuthResource = {
    initiateDeviceAuth: vi.fn(),
    pollDeviceAuth: vi.fn(),
    refreshToken: vi.fn(),
    revokeToken,
  };
  const user: IUserResource = { retrieve: vi.fn() };
  return { resource: augmentAuth(raw, user, storage), revokeToken };
}

describe('Logout', () => {
  it('clears auth, clears pending device auth, and deletes the config', async () => {
    const storage = new MemoryStorage({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    storage.setPendingDeviceAuth({
      device_code: 'dc',
      interval: 5,
      expires_at: Date.now() + 60_000,
      verification_url: 'https://example.test/device',
      phrase: 'AAAA-BBBB',
    });
    const auth = makeAuthResource(storage);
    const onComplete = vi.fn();

    const { lastFrame, unmount } = render(<Logout auth={auth.resource} onComplete={onComplete} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Logged out successfully');
    });
    expect(auth.revokeToken).toHaveBeenCalledWith('r');
    expect(storage.getAuth()).toBeNull();
    expect(storage.getPendingDeviceAuth()).toBeNull();
    await vi.waitFor(
      () => {
        expect(onComplete).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );
    unmount();
  });

  it('still clears local state when revokeToken rejects', async () => {
    const storage = new MemoryStorage({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const auth = makeAuthResource(storage);
    auth.revokeToken.mockRejectedValueOnce(new Error('boom'));
    const onComplete = vi.fn();

    const { lastFrame, unmount } = render(<Logout auth={auth.resource} onComplete={onComplete} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Logged out successfully');
    });
    expect(storage.getAuth()).toBeNull();
    unmount();
  });

  it('is a no-op-safe path when storage already had no auth', async () => {
    const storage = new MemoryStorage();
    const auth = makeAuthResource(storage);
    const onComplete = vi.fn();

    const { lastFrame, unmount } = render(<Logout auth={auth.resource} onComplete={onComplete} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Logged out successfully');
    });
    expect(auth.revokeToken).not.toHaveBeenCalled();
    unmount();
  });
});
