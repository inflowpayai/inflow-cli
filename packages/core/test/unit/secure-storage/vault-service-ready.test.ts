import type * as fs from 'node:fs';
import { Server } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { __testing } from '../../../src/secure-storage/vault-daemon.js';

const calls = vi.hoisted(() => ({ write: vi.fn(), close: vi.fn() }));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof fs>()),
  writeSync: calls.write,
  closeSync: calls.close,
}));
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

it.each([true, false])('signals readiness only after the broker listens (success=%s)', async (success) => {
  vi.stubEnv('INFLOW_VAULT_READY_FD', '5');
  vi.stubEnv('INFLOW_VAULT_LOCK_FD', '6');
  let listening: (() => void) | undefined;
  const listen = vi.fn((_options: { fd: number }, callback: () => void) => {
    listening = callback;
  });
  const transport = Object.assign(new Server(), { listen });
  const result = __testing.runLinuxVaultBrokerEntry({ listenFd: 3 }, 'linux', {
    hardenProcess: vi.fn(),
    resolveServiceIdentity: () => ({ uid: 994, gid: 994 }),
    runBroker: async (descriptor, _identity, dependencies) => {
      await dependencies.listenServer(transport, descriptor);
    },
  });
  expect(calls.write).not.toHaveBeenCalled();
  expect(listen).toHaveBeenCalledWith({ fd: 3 }, expect.any(Function));
  if (success) {
    listening?.();
    await result;
    expect(calls.write.mock.calls).toEqual([
      [6, 'READY\n'],
      [5, 'READY\n'],
    ]);
  } else {
    transport.emit('error', new Error('listen failed'));
    await expect(result).rejects.toThrow('listen failed');
    expect(calls.write).not.toHaveBeenCalled();
  }
});

it('does not add readiness signaling to systemd startup', () => {
  __testing.notifyLinuxServiceReady({});
  expect(calls.write).not.toHaveBeenCalled();
});

it('marks startup complete before acknowledging the caller and retains the lifecycle lock', () => {
  const environment = { INFLOW_VAULT_READY_FD: '5', INFLOW_VAULT_LOCK_FD: '6', LISTEN_FDS: '1' };
  __testing.notifyLinuxServiceReady(environment);
  expect(calls.write.mock.calls).toEqual([
    [6, 'READY\n'],
    [5, 'READY\n'],
  ]);
  expect(calls.close.mock.calls).toEqual([[5]]);
  expect(environment).toEqual({ LISTEN_FDS: '1' });
});

it.each([
  ['invalid', '6'],
  ['3', '6'],
  ['5', 'invalid'],
  ['5', '3'],
  ['5', '5'],
])('refuses invalid or overlapping readiness and lock descriptors (%s, %s)', (ready, lock) => {
  expect(() => __testing.notifyLinuxServiceReady({ INFLOW_VAULT_READY_FD: ready, INFLOW_VAULT_LOCK_FD: lock })).toThrow(
    'Invalid service startup',
  );
  expect(calls.write).not.toHaveBeenCalled();
});

it('does not acknowledge readiness if recording startup fails', () => {
  calls.write.mockImplementation(() => {
    throw new Error('write failed');
  });
  expect(() => __testing.notifyLinuxServiceReady({ INFLOW_VAULT_READY_FD: '5', INFLOW_VAULT_LOCK_FD: '6' })).toThrow(
    'write failed',
  );
  expect(calls.write).toHaveBeenCalledOnce();
});
