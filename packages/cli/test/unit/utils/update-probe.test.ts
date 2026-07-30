import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatUpdateNotice,
  isNewerVersion,
  makeBackgroundUpdateProbe,
  makeFrozenUpdateProbe,
} from '../../../src/utils/update-probe.js';

function githubFetch(version: string): { calls: { headers: Headers; url: string }[]; fetch: typeof globalThis.fetch } {
  const calls: { headers: Headers; url: string }[] = [];
  const fetch = ((input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    calls.push({ headers: new Headers(init?.headers), url });
    return Promise.resolve(Response.json({ tag_name: `v${version}` }));
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

beforeEach(() => {
  delete process.env['NO_UPDATE_NOTIFIER'];
  vi.useFakeTimers();
});

afterEach(() => {
  delete process.env['NO_UPDATE_NOTIFIER'];
  vi.useRealTimers();
});

describe('isNewerVersion', () => {
  it('compares semver-shaped GitHub release names', () => {
    expect(isNewerVersion('v1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(false);
    expect(isNewerVersion('1.1.0', '1.0.9')).toBe(true);
  });
});

describe('makeBackgroundUpdateProbe', () => {
  it('returns update info from GitHub Releases when a newer version is available and caches it for 24 hours', async () => {
    const { calls, fetch } = githubFetch('1.0.1');
    const probe = makeBackgroundUpdateProbe('@inflowpayai/inflow', '1.0.0', fetch);

    const first = await probe({ polling: false });
    expect(first).toEqual({ current: '1.0.0', latest: '1.0.1' });

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 - 1);
    const second = await probe({ polling: false });
    expect(second).toEqual({ current: '1.0.0', latest: '1.0.1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/inflowpayai/inflow-cli/releases/latest');
    expect(calls[0]?.headers.get('Accept')).toBe('application/vnd.github+json');
    expect(calls[0]?.headers.get('User-Agent')).toBe('inflow/1.0.0');
  });

  it('returns undefined when the GitHub release version equals the current version', async () => {
    const { fetch } = githubFetch('1.0.0');
    const probe = makeBackgroundUpdateProbe('@inflowpayai/inflow', '1.0.0', fetch);
    expect(await probe({ polling: false })).toBeUndefined();
  });

  it('serves the cached value without fetching when polling=true', async () => {
    const { calls, fetch } = githubFetch('2.0.0');
    const probe = makeBackgroundUpdateProbe('@inflowpayai/inflow', '1.0.0', fetch);
    await probe({ polling: false });
    calls.length = 0;

    const value = await probe({ polling: true });
    expect(value).toEqual({ current: '1.0.0', latest: '2.0.0' });
    expect(calls).toHaveLength(0);
  });

  it('returns undefined on GitHub fetch failure and applies the short stale-cache TTL', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('network down'))) as unknown as typeof globalThis.fetch;
    const probe = makeBackgroundUpdateProbe('@inflowpayai/inflow', '1.0.0', fetch);
    expect(await probe({ polling: false })).toBeUndefined();
    expect(await probe({ polling: false })).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('short-circuits to undefined when update checks are disabled', async () => {
    process.env['NO_UPDATE_NOTIFIER'] = '1';
    const { calls, fetch } = githubFetch('2.0.0');
    const probe = makeBackgroundUpdateProbe('@inflowpayai/inflow', '1.0.0', fetch);
    expect(await probe({ polling: false })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe('makeFrozenUpdateProbe', () => {
  it('returns the captured snapshot on every call', async () => {
    const snapshot = { current: '1.0.0', latest: '1.0.1' };
    const probe = makeFrozenUpdateProbe(snapshot);
    expect(await probe({ polling: false })).toBe(snapshot);
    expect(await probe({ polling: true })).toBe(snapshot);
  });

  it('returns undefined when no snapshot was captured', async () => {
    const probe = makeFrozenUpdateProbe();
    expect(await probe({ polling: false })).toBeUndefined();
  });
});

describe('formatUpdateNotice', () => {
  it('renders one human-facing line', () => {
    expect(formatUpdateNotice({ current: '0.5.0', latest: '0.5.1' })).toBe('A newer InFlow CLI is available: 0.5.1.\n');
  });
});
