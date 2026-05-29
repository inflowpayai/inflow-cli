import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LoginPrompt } from '../../../../src/commands/auth/login-prompt.js';

const MOUNT_SETTLE_MS = 50;

describe('LoginPrompt', () => {
  it('shows the user-display row and the y/N prompt', () => {
    const { lastFrame } = render(
      <LoginPrompt userDisplay="ada@example.test" onAccept={() => undefined} onReject={() => undefined} />,
    );
    expect(lastFrame()).toContain('Already signed in as ada@example.test');
    expect(lastFrame()).toContain('Re-authenticate? [y/N]');
  });

  it.each([
    ['y', 'lowercase y'],
    ['Y', 'uppercase Y'],
  ])('calls onAccept on %s', async (input) => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const { stdin, unmount } = render(<LoginPrompt userDisplay="x" onAccept={onAccept} onReject={onReject} />);
    await new Promise((resolve) => setTimeout(resolve, MOUNT_SETTLE_MS));
    stdin.write(input);
    await vi.waitFor(() => {
      expect(onAccept).toHaveBeenCalledTimes(1);
    });
    expect(onReject).not.toHaveBeenCalled();
    unmount();
  });

  it.each([
    ['n', 'lowercase n'],
    ['N', 'uppercase N'],
    ['\r', 'Enter'],
    ['', 'Escape'],
  ])('calls onReject on %s', async (input) => {
    const onReject = vi.fn();
    const { stdin, unmount } = render(<LoginPrompt userDisplay="x" onAccept={() => undefined} onReject={onReject} />);
    await new Promise((resolve) => setTimeout(resolve, MOUNT_SETTLE_MS));
    stdin.write(input);
    await vi.waitFor(() => {
      expect(onReject).toHaveBeenCalledTimes(1);
    });
    unmount();
  });

  it('ignores other keys', async () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const { stdin, unmount } = render(<LoginPrompt userDisplay="x" onAccept={onAccept} onReject={onReject} />);
    await new Promise((resolve) => setTimeout(resolve, MOUNT_SETTLE_MS));
    stdin.write('q');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onAccept).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
    unmount();
  });
});
