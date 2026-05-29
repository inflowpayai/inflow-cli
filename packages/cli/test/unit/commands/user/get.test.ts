import { buildProfileRows, joinName, type User } from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { UserGet, type UserGetOutcome, type UserGetProps } from '../../../../src/commands/user/get.js';

const fullyPopulatedUser: User = {
  userId: 'u-1',
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  username: 'ada',
  mobile: '+1-555-0100',
  locale: 'EN_US',
  timezone: 'US/Pacific',
  created: '2025-08-12T18:24:31.501Z',
  updated: '2026-05-24T16:08:09.221Z',
};

function userWith(overrides: Partial<User>): User {
  return { ...fullyPopulatedUser, ...overrides };
}

function renderUserGet(props: UserGetProps) {
  return render(createElement(UserGet, props));
}

describe('joinName', () => {
  it('joins both halves with a single space', () => {
    expect(joinName('Ada', 'Lovelace')).toBe('Ada Lovelace');
  });

  it('returns the first name alone when last is null', () => {
    expect(joinName('Nas', null)).toBe('Nas');
  });

  it('returns the last name alone when first is null', () => {
    expect(joinName(null, 'Lovelace')).toBe('Lovelace');
  });

  it('returns null when both halves are null', () => {
    expect(joinName(null, null)).toBeNull();
  });
});

describe('buildProfileRows', () => {
  it('emits every row for a fully populated user, in spec order', () => {
    const rows = buildProfileRows(fullyPopulatedUser);
    expect(rows.map((r) => r.label)).toEqual([
      'User ID',
      'Email',
      'Username',
      'Full Name',
      'Mobile',
      'Locale',
      'Timezone',
    ]);
  });

  it('does not surface Created or Updated as rows', () => {
    const rows = buildProfileRows(fullyPopulatedUser);
    expect(rows.some((r) => r.label === 'Created')).toBe(false);
    expect(rows.some((r) => r.label === 'Updated')).toBe(false);
  });

  it('keeps the Email row but sets value=null when email is null', () => {
    const rows = buildProfileRows(userWith({ email: null }));
    const email = rows.find((r) => r.label === 'Email');
    expect(email).toBeDefined();
    expect(email?.value).toBeNull();
  });

  it('keeps the Username row but sets value=null when username is null', () => {
    const rows = buildProfileRows(userWith({ username: null }));
    const username = rows.find((r) => r.label === 'Username');
    expect(username).toBeDefined();
    expect(username?.value).toBeNull();
  });

  it('keeps the Mobile row but sets value=null when mobile is null', () => {
    const rows = buildProfileRows(userWith({ mobile: null }));
    const mobile = rows.find((r) => r.label === 'Mobile');
    expect(mobile).toBeDefined();
    expect(mobile?.value).toBeNull();
  });

  it('keeps the Full Name row with value=null when both first and last are null', () => {
    const rows = buildProfileRows(userWith({ firstName: null, lastName: null }));
    const fullName = rows.find((r) => r.label === 'Full Name');
    expect(fullName).toBeDefined();
    expect(fullName?.value).toBeNull();
  });

  it('renders the Full Name row with just firstName when lastName is null', () => {
    const rows = buildProfileRows(userWith({ firstName: 'Nas', lastName: null }));
    const fullName = rows.find((r) => r.label === 'Full Name');
    expect(fullName?.value).toBe('Nas');
  });

  it('emits every row regardless of null fields, in spec order', () => {
    const rows = buildProfileRows(
      userWith({
        email: null,
        firstName: null,
        lastName: null,
        username: null,
        mobile: null,
      }),
    );
    expect(rows.map((r) => r.label)).toEqual([
      'User ID',
      'Email',
      'Username',
      'Full Name',
      'Mobile',
      'Locale',
      'Timezone',
    ]);
    expect(rows.find((r) => r.label === 'Email')?.value).toBeNull();
    expect(rows.find((r) => r.label === 'Username')?.value).toBeNull();
    expect(rows.find((r) => r.label === 'Full Name')?.value).toBeNull();
    expect(rows.find((r) => r.label === 'Mobile')?.value).toBeNull();
  });

  it('treats an empty string field the same as null', () => {
    const rows = buildProfileRows(userWith({ email: '' }));
    expect(rows.find((r) => r.label === 'Email')?.value).toBeNull();
  });

  it('treats undefined fields the same as null (regression: blank Username row)', () => {
    const userWithMissingUsername = userWith({
      username: undefined as unknown as string | null,
    });
    const rows = buildProfileRows(userWithMissingUsername);
    const username = rows.find((r) => r.label === 'Username');
    expect(username).toBeDefined();
    expect(username?.value).toBeNull();
  });
});

describe('UserGet (TTY component)', () => {
  function makeResource(impl: () => Promise<User>): { retrieve: () => Promise<User> } {
    return { retrieve: vi.fn(impl) };
  }

  function noopComplete(_outcome: UserGetOutcome): void {
    return undefined;
  }

  it('renders the loading spinner before the action resolves', () => {
    const resource = makeResource(() => new Promise<User>(() => undefined));
    const { lastFrame, unmount } = renderUserGet({
      userResource: resource,
      onComplete: noopComplete,
    });
    expect(lastFrame()).toContain('Loading user');
    unmount();
  });

  it('renders every populated row on success', async () => {
    const resource = makeResource(() => Promise.resolve(fullyPopulatedUser));
    const { lastFrame, unmount } = renderUserGet({
      userResource: resource,
      onComplete: noopComplete,
    });
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('User ID:');
      },
      { timeout: 5_000 },
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Email: ');
    expect(frame).toContain('ada@example.test');
    expect(frame).toContain('Username: ');
    expect(frame).toContain('Full Name: ');
    expect(frame).toContain('Ada Lovelace');
    expect(frame).toContain('Mobile: ');
    expect(frame).toContain('Locale: ');
    expect(frame).toContain('Timezone: ');
    expect(frame).not.toContain('Created:');
    expect(frame).not.toContain('Updated:');
    unmount();
  });

  it('renders the Email row with an em dash when email is null', async () => {
    const resource = makeResource(() => Promise.resolve(userWith({ email: null })));
    const { lastFrame, unmount } = renderUserGet({
      userResource: resource,
      onComplete: noopComplete,
    });
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('User ID:');
      },
      { timeout: 5_000 },
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Email:');
    expect(frame).toMatch(/Email:\s+—/);
    unmount();
  });

  it('renders the Full Name row with an em dash when both firstName and lastName are null', async () => {
    const resource = makeResource(() => Promise.resolve(userWith({ firstName: null, lastName: null })));
    const { lastFrame, unmount } = renderUserGet({
      userResource: resource,
      onComplete: noopComplete,
    });
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('User ID:');
      },
      { timeout: 5_000 },
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Full Name:');
    expect(frame).toMatch(/Full Name:\s+—/);
    expect(frame).not.toContain('null');
    unmount();
  });

  it('renders just the firstName in the Full Name row when lastName is null', async () => {
    const resource = makeResource(() => Promise.resolve(userWith({ firstName: 'Nas', lastName: null })));
    const { lastFrame, unmount } = renderUserGet({
      userResource: resource,
      onComplete: noopComplete,
    });
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('Full Name:');
      },
      { timeout: 5_000 },
    );
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Full Name:\s+Nas/);
    expect(frame).not.toContain('null');
    unmount();
  });

  it('never renders Created or Updated rows', async () => {
    const resource = makeResource(() => Promise.resolve(fullyPopulatedUser));
    const { lastFrame, unmount } = renderUserGet({
      userResource: resource,
      onComplete: noopComplete,
    });
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('User ID:');
      },
      { timeout: 5_000 },
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Created');
    expect(frame).not.toContain('Updated');
    expect(frame).not.toContain('2025-08-12T18:24:31.501Z');
    expect(frame).not.toContain('2026-05-24T16:08:09.221Z');
    unmount();
  });

  it('renders the failure marker plus the error message on rejection', async () => {
    const resource = makeResource(() => Promise.reject(new Error('boom from server')));
    const { lastFrame, unmount } = renderUserGet({
      userResource: resource,
      onComplete: noopComplete,
    });
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('Failed to retrieve user');
      },
      { timeout: 5_000 },
    );
    expect(lastFrame() ?? '').toContain('boom from server');
    unmount();
  });

  it('calls onComplete with kind=success and the user after the linger', async () => {
    const resource = makeResource(() => Promise.resolve(fullyPopulatedUser));
    const onComplete = vi.fn<(o: UserGetOutcome) => void>();
    const { unmount } = renderUserGet({
      userResource: resource,
      onComplete,
    });
    await vi.waitFor(
      () => {
        expect(onComplete).toHaveBeenCalledWith({
          kind: 'success',
          user: fullyPopulatedUser,
        });
      },
      { timeout: 3_000 },
    );
    unmount();
  });

  it('calls onComplete with kind=error and the actual message after the linger', async () => {
    const resource = makeResource(() => Promise.reject(new Error('network down')));
    const onComplete = vi.fn<(o: UserGetOutcome) => void>();
    const { unmount } = renderUserGet({
      userResource: resource,
      onComplete,
    });
    await vi.waitFor(
      () => {
        expect(onComplete).toHaveBeenCalledWith({
          kind: 'error',
          message: 'network down',
        });
      },
      { timeout: 3_000 },
    );
    unmount();
  });
});
