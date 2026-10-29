import type { Buffer } from 'node:buffer';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultBackend } from '../../../src/secure-storage/vault-backend.js';
import type { VerifiedWindowsPipeEvent } from '../../../src/secure-storage/vault-windows-transport.js';
import {
  encodeVaultIpcMessage,
  decodeVaultIpcFrame,
  type VaultIpcRequest,
} from '../../../src/secure-storage/vault-ipc.js';
import { SecureStorageError } from '../../../src/secure-storage/errors.js';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  startDispatcher: vi.fn(),
  stopDispatcher: vi.fn(),
  respond: vi.fn(),
  prepareDevelopmentDirectory: vi.fn(),
}));
vi.mock('../../../src/secure-storage/vault-daemon-handler.js', () => ({ handleVaultIpcRequest: mocks.handle }));
vi.mock('../../../src/secure-storage/vault-windows-transport.js', () => ({
  createWindowsVaultTransport: () => mocks,
}));
import { startWindowsDevelopmentVaultServer } from '../../../src/secure-storage/vault-windows-development.js';
import { startLocalVaultDaemon } from '../../../src/secure-storage/vault-daemon.js';
import { SecureSqliteRepository } from '../../../src/secure-storage/sqlite.js';
import { LocalVaultBackend } from '../../../src/secure-storage/vault-local-backend.js';

describe('Windows development vault request lifecycle', () => {
  const platform = process.platform;
  // Only dispatch and transport are under test; the actual backend is exercised by CLI integration tests.
  const backend = {} as VaultBackend;
  let receive: (event: VerifiedWindowsPipeEvent) => void;
  const replies: ReturnType<typeof decodeVaultIpcFrame>[] = [];
  const onShutdown = vi.fn();
  const identity = { slot: 1, generation: 1, sequence: 1 };
  const peer = { pid: 123, uid: 0, path: 'node.exe', principal: 'S-1-5-21-1000' };
  function request(method: VaultIpcRequest['method'] = 'vault.status', generation = 1): Buffer {
    const frame = encodeVaultIpcMessage({ id: 'test', version: 1, method, params: {} });
    receive({ ...identity, generation, type: 'request', frame, peer });
    return frame;
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  beforeEach(() => {
    vi.resetAllMocks();
    replies.length = 0;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubGlobal('__INFLOW_DEVELOPMENT_VAULT__', true);
    mocks.startDispatcher.mockImplementation((_path, callback: typeof receive) => {
      receive = callback;
    });
    mocks.handle.mockResolvedValue({ id: 'test', version: 1, ok: true, result: { lock_state: 'locked' } });
    mocks.respond.mockImplementation((_identity, frame: Buffer) => {
      replies.push(decodeVaultIpcFrame(frame));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: platform });
    vi.unstubAllGlobals();
  });

  it('rejects non-development builds and non-Windows platforms', () => {
    vi.stubGlobal('__INFLOW_DEVELOPMENT_VAULT__', false);
    expect(() => startWindowsDevelopmentVaultServer({ backend, socketPath: 'pipe' })).toThrow('unavailable');
    vi.stubGlobal('__INFLOW_DEVELOPMENT_VAULT__', true);
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(() => startWindowsDevelopmentVaultServer({ backend, socketPath: 'pipe' })).toThrow('unavailable');
    expect(mocks.startDispatcher).not.toHaveBeenCalled();
  });

  it('restricts the development directory and closes the database before resetting Windows state', async () => {
    const rootDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'inflow-windows-daemon-')));
    const close = vi.spyOn(SecureSqliteRepository.prototype, 'close');
    const reset = vi.spyOn(LocalVaultBackend.prototype, 'reset');
    try {
      const daemon = await startLocalVaultDaemon({ rootDirectory });
      expect(mocks.prepareDevelopmentDirectory).toHaveBeenCalledWith(rootDirectory);
      expect(mocks.startDispatcher).toHaveBeenCalledOnce();
      expect(daemon.socketPath).toMatch(/InFlowDevelopment-/u);
      mocks.handle.mockImplementationOnce(async (actualBackend: VaultBackend) => {
        await actualBackend.reset();
        return { id: 'test', version: 1, ok: true, result: {} };
      });
      request('vault.reset');
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      expect(close.mock.invocationCallOrder[0]).toBeLessThan(reset.mock.invocationCallOrder[0] ?? 0);
      expect(replies[0]).toMatchObject({ ok: true });
      receive({ ...identity, type: 'closed' });
      await daemon.closed;
      expect(mocks.stopDispatcher).toHaveBeenCalledOnce();
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it('copies native frames before returning and serializes backend requests', async () => {
    const server = startWindowsDevelopmentVaultServer({ backend, socketPath: 'pipe' });
    let release: () => void = () => {
      throw new Error('not started');
    };
    mocks.handle.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ id: 'test', version: 1, ok: true, result: {} });
        }),
    );
    const first = request();
    first.fill(0);
    request();
    await flush();
    expect(mocks.handle).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(mocks.handle).toHaveBeenCalledTimes(2);
    expect(replies).toHaveLength(2);
    const sent = mocks.respond.mock.calls[0]?.[1] as Buffer;
    expect(sent.every((byte) => byte === 0)).toBe(true);
    await server.close();
  });

  it.each(['daemon.shutdown', 'vault.reset'] as const)(
    'delivers %s before closing and refuses further work',
    async (method) => {
      const server = startWindowsDevelopmentVaultServer({ backend, socketPath: 'pipe', onShutdown });
      request(method);
      await flush();
      expect(replies[0]).toMatchObject({ ok: true });
      expect(onShutdown).not.toHaveBeenCalled();
      request();
      await flush();
      expect(mocks.handle).toHaveBeenCalledTimes(1);
      expect(replies[1]).toMatchObject({ ok: false, error: { code: 'secure_storage_unavailable' } });
      receive({ ...identity, type: 'closed' });
      expect(onShutdown).toHaveBeenCalledOnce();
      await server.close();
    },
  );

  it('finishes shutdown if a client disconnects while reset is running', async () => {
    const server = startWindowsDevelopmentVaultServer({ backend, socketPath: 'pipe', onShutdown });
    let release: () => void = () => {
      throw new Error('not started');
    };
    mocks.handle.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ id: 'test', version: 1, ok: true, result: {} });
        }),
    );
    request('vault.reset');
    await flush();
    receive({ ...identity, type: 'closed' });
    release();
    await flush();
    expect(onShutdown).toHaveBeenCalledOnce();
    expect(mocks.respond).not.toHaveBeenCalled();
    await server.close();
  });

  it('does not process disconnected or replaced connections and ignores old close events', async () => {
    const server = startWindowsDevelopmentVaultServer({ backend, socketPath: 'pipe' });
    request();
    request('vault.status', 2);
    receive({ ...identity, type: 'closed' });
    await flush();
    expect(mocks.handle).toHaveBeenCalledOnce();
    expect(replies).toHaveLength(1);
    request('vault.status', 2);
    receive({ ...identity, generation: 2, type: 'closed' });
    await flush();
    expect(mocks.handle).toHaveBeenCalledOnce();
    await server.close();
  });

  it.each([new SecureStorageError('vault_locked', 'The InFlow vault is locked.'), new Error('private backend detail')])(
    'returns safe errors without stopping the daemon',
    async (cause) => {
      const server = startWindowsDevelopmentVaultServer({ backend, socketPath: 'pipe', onShutdown });
      mocks.handle.mockRejectedValueOnce(cause);
      request();
      await flush();
      expect(replies[0]).toMatchObject({ ok: false });
      expect(JSON.stringify(replies)).not.toContain('private backend detail');
      expect(onShutdown).not.toHaveBeenCalled();
      request();
      await flush();
      expect(replies[1]).toMatchObject({ ok: true });
      await server.close();
    },
  );

  it('rejects response frames presented as requests', async () => {
    const server = startWindowsDevelopmentVaultServer({ backend, socketPath: 'pipe' });
    receive({
      ...identity,
      type: 'request',
      peer,
      frame: encodeVaultIpcMessage({ id: 'x', version: 1, ok: true, result: {} }),
    });
    await flush();
    expect(replies[0]).toMatchObject({ ok: false, error: { code: 'secure_storage_corrupt' } });
    expect(mocks.handle).not.toHaveBeenCalled();
    await server.close();
  });

  it('stops dispatch on a transport failure', async () => {
    const server = startWindowsDevelopmentVaultServer({ backend, socketPath: 'pipe', onShutdown });
    mocks.respond.mockImplementationOnce(() => {
      throw new Error('pipe failure');
    });
    request();
    await flush();
    expect(mocks.stopDispatcher).toHaveBeenCalledOnce();
    expect(onShutdown).toHaveBeenCalledOnce();
    await server.close();
  });
});
