import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecureSqliteRepository } from '../../../src/secure-storage/sqlite.js';
import { VaultBackendLifetime } from '../../../src/secure-storage/vault-backend-lifetime.js';
import { LocalVaultBackend } from '../../../src/secure-storage/vault-local-backend.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

describe('environment-specific vault defaults', () => {
  const platform = process.platform;
  let directory: string;
  let repository: SecureSqliteRepository;
  let backend: LocalVaultBackend;

  beforeEach(() => {
    directory = fs.mkdtempSync(join(tmpdir(), 'inflow-default-policy-'));
    repository = new SecureSqliteRepository({ rootDir: directory });
    repository.initialize();
    backend = new LocalVaultBackend({ repository });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { value: platform });
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(['darwin', 'win32', 'freebsd'])('retains sleep locking on %s without probing Linux', (value) => {
    Object.defineProperty(process, 'platform', { value });
    const probe = vi.spyOn(fs, 'statSync');
    expect(backend.getPolicy()).toEqual({ idleTimeoutSeconds: 28_800, lockOnSleep: true });
    expect(probe).not.toHaveBeenCalled();
  });

  it('retains sleep locking when the systemd runtime marker exists', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const marker = fs.statSync(directory);
    const probe = vi.spyOn(fs, 'statSync').mockReturnValue(marker);
    expect(backend.getPolicy()).toEqual({ idleTimeoutSeconds: 28_800, lockOnSleep: true });
    expect(probe).toHaveBeenCalledWith('/run/systemd/system/');
  });

  it.each(['ENOENT', 'EACCES', 'EIO', 'ENOTDIR'])('handles runtime marker error %s conservatively', (code) => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw Object.assign(new Error('marker probe'), { code });
    });
    expect(backend.getPolicy()).toEqual({ idleTimeoutSeconds: 28_800, lockOnSleep: code !== 'ENOENT' });
    expect(repository.getSetting('vault-policy')).toBeUndefined();
  });

  it('keeps sleep locking on for an unclassified failure', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('unclassified');
    });
    expect(backend.getPolicy().lockOnSleep).toBe(true);
  });

  it.each([true, false])('preserves saved sleep-lock choice %s across backend restart', (lockOnSleep) => {
    const policy = { idleTimeoutSeconds: 90, lockOnSleep };
    backend.setPolicy(policy);
    repository.close();
    repository = new SecureSqliteRepository({ rootDir: directory });
    repository.initialize();
    backend = new LocalVaultBackend({ repository });
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const probe = vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('saved policies must not need an environment probe');
    });
    expect(backend.getPolicy()).toEqual(policy);
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not replace a malformed saved policy with the environment default', () => {
    repository.upsertSetting('vault-policy', { lockOnSleep: 'false' });
    const probe = vi.spyOn(fs, 'statSync');
    expect(() => backend.getPolicy()).toThrow('The vault policy is malformed.');
    expect(probe).not.toHaveBeenCalled();
  });

  it('returns independent default policy objects', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    backend.getPolicy().lockOnSleep = false;
    expect(backend.getPolicy().lockOnSleep).toBe(true);
  });

  it.each([false, true])(
    'keeps idle expiration and honors explicit sleep locking %s on non-systemd Linux',
    async (explicit) => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.spyOn(fs, 'statSync').mockImplementation(() => {
        throw Object.assign(new Error('no systemd'), { code: 'ENOENT' });
      });
      if (explicit) backend.setPolicy({ idleTimeoutSeconds: 28_800, lockOnSleep: true });
      vi.useFakeTimers();
      const lifetime = new VaultBackendLifetime();
      const expire = vi.fn(() => Promise.resolve());
      lifetime.expireWith(expire);
      try {
        lifetime.refresh(backend.getPolicy());
        vi.setSystemTime(Date.now() + 180_000);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(expire).toHaveBeenCalledTimes(explicit ? 1 : 0);
        if (!explicit) {
          await vi.advanceTimersByTimeAsync(28_800_000 - 30_000);
          expect(expire).toHaveBeenCalledOnce();
        }
      } finally {
        lifetime.clear();
      }
    },
  );
});
