import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatUpdateNotice,
  makeBackgroundUpdateProbe,
  makeFrozenUpdateProbe,
} from '../../../src/utils/update-probe.js';

const { fetchInfoMock } = vi.hoisted(() => ({
  fetchInfoMock: vi.fn(),
}));

vi.mock('update-notifier', () => ({
  default: vi.fn(() => ({ fetchInfo: fetchInfoMock })),
}));

beforeEach(() => {
  fetchInfoMock.mockReset();
  delete process.env.NO_UPDATE_NOTIFIER;
});

afterEach(() => {
  delete process.env.NO_UPDATE_NOTIFIER;
});

describe('makeBackgroundUpdateProbe', () => {
  it('returns update info when a newer version is available and caches it', async () => {
    fetchInfoMock.mockResolvedValueOnce({ latest: '1.0.1' });
    const probe = makeBackgroundUpdateProbe('@inflowpayai/inflow', '1.0.0');

    const first = await probe({ polling: false });
    expect(first).toEqual({ current: '1.0.0', latest: '1.0.1' });

    const second = await probe({ polling: false });
    expect(second).toEqual({ current: '1.0.0', latest: '1.0.1' });
    expect(fetchInfoMock).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the upstream version equals the current', async () => {
    fetchInfoMock.mockResolvedValueOnce({ latest: '1.0.0' });
    const probe = makeBackgroundUpdateProbe('@inflowpayai/inflow', '1.0.0');
    expect(await probe({ polling: false })).toBeUndefined();
  });

  it('serves the cached value (no re-fetch) when polling=true', async () => {
    fetchInfoMock.mockResolvedValueOnce({ latest: '2.0.0' });
    const probe = makeBackgroundUpdateProbe('@inflowpayai/inflow', '1.0.0');
    await probe({ polling: false });
    fetchInfoMock.mockClear();

    const value = await probe({ polling: true });
    expect(value).toEqual({ current: '1.0.0', latest: '2.0.0' });
    expect(fetchInfoMock).not.toHaveBeenCalled();
  });

  it('returns undefined on fetch failure and applies the short stale-cache TTL', async () => {
    fetchInfoMock.mockRejectedValueOnce(new Error('network down'));
    const probe = makeBackgroundUpdateProbe('@inflowpayai/inflow', '1.0.0');
    expect(await probe({ polling: false })).toBeUndefined();
    expect(await probe({ polling: false })).toBeUndefined();
    expect(fetchInfoMock).toHaveBeenCalledTimes(1);
  });

  it('short-circuits to undefined when NO_UPDATE_NOTIFIER is set', async () => {
    process.env.NO_UPDATE_NOTIFIER = '1';
    const probe = makeBackgroundUpdateProbe('@inflowpayai/inflow', '1.0.0');
    expect(await probe({ polling: false })).toBeUndefined();
    expect(fetchInfoMock).not.toHaveBeenCalled();
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
  it('renders the inflow package name and install command', () => {
    const text = formatUpdateNotice({ current: '0.5.0', latest: '0.5.1' });
    expect(text).toContain('Update available for @inflowpayai/inflow: 0.5.0 -> 0.5.1');
    expect(text).toContain('Run: npm install -g @inflowpayai/inflow');
  });
});
