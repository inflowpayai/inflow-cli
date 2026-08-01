import { Buffer } from 'node:buffer';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, Socket, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecureStorageError } from '../../../src/secure-storage/errors.js';
import { sendVaultIpcRequest } from '../../../src/secure-storage/vault-socket.js';
import {
  __testing,
  attachLocalVaultDaemonSignalHandlers,
  runLinuxTransferredVaultService,
  runLinuxTransferredVaultServiceWithRuntime,
  runLinuxVaultBroker,
  runLinuxVaultService,
  startLinuxVaultService,
  startLocalVaultDaemon,
  systemdSocketFileDescriptor,
  type LocalVaultDaemon,
  type LocalVaultDaemonRuntime,
} from '../../../src/secure-storage/vault-daemon.js';
import type { VaultIpcResponse } from '../../../src/secure-storage/vault-ipc.js';

describe('local vault daemon lifecycle', () => {
  let daemon: LocalVaultDaemon | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (daemon !== undefined) await daemon.close();
    daemon = undefined;
    if (tmpDir !== undefined) rmSync(tmpDir, { force: true, recursive: true });
    tmpDir = undefined;
  });

  it('serves generic vault IPC over the configured socket', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-daemon-'));
    daemon = await startLocalVaultDaemon({ buildId: 'build-1', cliVersion: '0.9.0', rootDirectory: tmpDir });

    await expect(
      sendVaultIpcRequest(daemon.socketPath, {
        id: 'req_info',
        method: 'daemon.info',
        params: {},
        version: 1,
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        buildId: 'build-1',
        cliVersion: '0.9.0',
        executablePath: process.execPath,
      },
    });

    await expect(
      sendVaultIpcRequest(daemon.socketPath, {
        id: 'req_1',
        method: 'vault.unlock',
        params: { salt: Buffer.alloc(16), wrappingKey: Buffer.alloc(32) },
        version: 1,
      }),
    ).resolves.toMatchObject({ ok: true, result: { lockState: 'unlocked' } });
    const putResponse = await sendVaultIpcRequest(daemon.socketPath, {
      id: 'req_2',
      method: 'secret.put',
      params: {
        expectedKind: 'inflow_api_key',
        payload: Buffer.from('api-key'),
      },
      version: 1,
    });

    expect(vaultReferenceFromPut(putResponse)).toMatch(/^vlt_[0-9a-f]{32}$/);
  });

  it('serves isolated tenants without allowing a client to stop the Linux service', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-service-'));
    const socketPath = join(tmpDir, 'run', 'vault.sock');
    const peerUserIds = [1001, 1002, 1001, 1002, 1002];
    daemon = await startLinuxVaultService({
      peerVerifier() {
        const uid = peerUserIds.shift();
        if (uid === undefined) throw new Error('unexpected connection');
        return { path: '/opt/inflow/bin/inflow', pid: uid, uid };
      },
      rootDirectory: join(tmpDir, 'vaults'),
      socketPath,
    });

    await expect(
      sendVaultIpcRequest(socketPath, {
        id: 'unlock_a',
        method: 'vault.unlock',
        params: { salt: Buffer.alloc(16), wrappingKey: Buffer.alloc(32) },
        version: 1,
      }),
    ).resolves.toMatchObject({ ok: true, result: { lockState: 'unlocked' } });
    await expect(
      sendVaultIpcRequest(socketPath, {
        id: 'status_b',
        method: 'vault.status',
        params: {},
        version: 1,
      }),
    ).resolves.toMatchObject({ ok: true, result: { lockState: 'not_initialized' } });
    await expect(
      sendVaultIpcRequest(socketPath, {
        id: 'reset_a',
        method: 'vault.reset',
        params: {},
        version: 1,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      sendVaultIpcRequest(socketPath, {
        id: 'shutdown_b',
        method: 'daemon.shutdown',
        params: {},
        version: 1,
      }),
    ).resolves.toMatchObject({ error: { code: 'secure_storage_unavailable' }, ok: false });
    await expect(
      sendVaultIpcRequest(socketPath, {
        id: 'status_b_after',
        method: 'vault.status',
        params: {},
        version: 1,
      }),
    ).resolves.toMatchObject({ ok: true, result: { lockState: 'not_initialized' } });
  });

  it('accepts exactly one named systemd socket owned by the current service process', () => {
    expect(
      systemdSocketFileDescriptor({ LISTEN_FDNAMES: 'inflow-vault', LISTEN_FDS: '1', LISTEN_PID: '123' }, 123),
    ).toBe(3);
    expect(() =>
      systemdSocketFileDescriptor({ LISTEN_FDNAMES: 'other', LISTEN_FDS: '1', LISTEN_PID: '123' }, 123),
    ).toThrow(SecureStorageError);
    expect(() =>
      systemdSocketFileDescriptor({ LISTEN_FDNAMES: 'inflow-vault', LISTEN_FDS: '2', LISTEN_PID: '123' }, 123),
    ).toThrow(SecureStorageError);
    expect(() => systemdSocketFileDescriptor({}, 123)).toThrow(SecureStorageError);
    expect(() => systemdSocketFileDescriptor({ LISTEN_FDS: '01', LISTEN_PID: '123' }, 123)).toThrow(SecureStorageError);
    expect(() => systemdSocketFileDescriptor({ LISTEN_FDS: '1', LISTEN_PID: '9007199254740992' }, 123)).toThrow(
      SecureStorageError,
    );
  });

  it('rejects unavailable Linux service entry points', async () => {
    if (process.platform === 'linux') {
      await expect(runLinuxVaultService()).rejects.toThrow(SecureStorageError);
      await expect(runLinuxVaultBroker()).rejects.toThrow(SecureStorageError);
    } else {
      await expect(runLinuxVaultService()).rejects.toThrow('available only on Linux');
      await expect(runLinuxVaultBroker()).rejects.toThrow('available only on Linux');
      await expect(runLinuxTransferredVaultService()).rejects.toThrow('requires its authenticated broker');
    }
  });

  it('prepares explicit and filesystem-backed Linux broker identities', async () => {
    const hardenProcess = vi.fn();
    const resolveServiceIdentity = vi.fn(() => ({ gid: 991, uid: 992 }));
    const runBroker = vi.fn(
      (
        _fileDescriptor: number,
        _identity: { gid: number; uid: number },
        _brokerDependencies: Parameters<typeof __testing.runLinuxVaultBrokerWithDependencies>[2],
      ) => Promise.resolve(),
    );
    const dependencies = { hardenProcess, resolveServiceIdentity, runBroker };

    await __testing.runLinuxVaultBrokerEntry(
      { listenFd: 4, serviceGroupId: 1000, serviceUserId: 1001 },
      'linux',
      dependencies,
    );
    expect(runBroker).toHaveBeenLastCalledWith(4, { gid: 1000, uid: 1001 }, expect.anything());
    expect(resolveServiceIdentity).not.toHaveBeenCalled();

    await __testing.runLinuxVaultBrokerEntry({ listenFd: 5 }, 'linux', dependencies);
    expect(resolveServiceIdentity).toHaveBeenCalledWith('/var/lib/inflow');
    expect(runBroker).toHaveBeenLastCalledWith(5, { gid: 991, uid: 992 }, expect.anything());
    expect(hardenProcess).toHaveBeenCalledTimes(2);

    const brokerDependencies = runBroker.mock.calls[0]?.[2];
    if (brokerDependencies === undefined) throw new Error('expected broker dependencies');
    const child = brokerDependencies.spawnService({ gid: process.getgid?.() ?? 0, uid: process.getuid?.() ?? 0 });
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  });

  it('runs the transferred Linux service on its broker IPC channel', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-transferred-service-'));
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    const messages: unknown[] = [];
    let transfers = 0;
    let messageHandler: ((message: unknown, handle: unknown) => void) | undefined;
    const service = runLinuxTransferredVaultServiceWithRuntime(
      { rootDirectory: tmpDir },
      'linux',
      {
        exit(code) {
          exits.push(code);
        },
        on(_event, handler) {
          messageHandler = handler;
        },
        once(event, handler) {
          handlers.set(event, handler);
        },
        send(message) {
          messages.push(message);
          const transferredSocket = new Socket();
          messageHandler?.(
            { peer: { path: process.execPath, pid: process.pid, uid: process.getuid?.() ?? 0 }, type: 'vault-client' },
            transferredSocket,
          );
          messageHandler?.(
            { peer: { path: process.execPath, pid: process.pid, uid: process.getuid?.() ?? 0 }, type: 'vault-client' },
            new Socket(),
          );
          handlers.get('disconnect')?.();
        },
      },
      (_socket, peer) => {
        transfers += 1;
        if (transfers === 2) throw new Error('invalid transferred peer');
        return peer;
      },
    );

    await service;
    messageHandler?.({ type: 'invalid' }, undefined);
    handlers.get('SIGINT')?.();
    handlers.get('SIGTERM')?.();

    expect(messages).toEqual([{ type: 'vault-service-ready' }]);
    expect(exits).toEqual([0]);
  });

  it('rejects a transferred service runtime on other platforms', async () => {
    await expect(
      runLinuxTransferredVaultServiceWithRuntime({}, 'darwin', {
        exit() {},
        on() {},
        once() {},
        send() {},
      }),
    ).rejects.toThrow('requires its authenticated broker');
  });

  it('validates broker control messages and peer identities', () => {
    expect(__testing.isReadyMessage({ type: 'vault-service-ready' })).toBe(true);
    expect(__testing.isReadyMessage(null)).toBe(false);
    expect(__testing.isReadyMessage({ type: 'other' })).toBe(false);

    expect(
      __testing.isBrokerTransferMessage({
        peer: { path: '/opt/inflow/bin/inflow', pid: 123, uid: 1000 },
        type: 'vault-client',
      }),
    ).toBe(true);
    expect(__testing.isBrokerTransferMessage(null)).toBe(false);
    expect(__testing.isBrokerTransferMessage({ type: 'other' })).toBe(false);
    expect(__testing.isBrokerTransferMessage({ type: 'vault-client' })).toBe(false);
    expect(__testing.isBrokerTransferMessage({ peer: null, type: 'vault-client' })).toBe(false);
    expect(
      __testing.isBrokerTransferMessage({
        peer: { path: 1, pid: 0, uid: -1 },
        type: 'vault-client',
      }),
    ).toBe(false);
  });

  it('maps only configured daemon lifetime options', () => {
    expect(__testing.lifetimeOptions({})).toEqual({});
    expect(
      __testing.lifetimeOptions({
        sleepCheckIntervalMilliseconds: 10,
        sleepDriftThresholdMilliseconds: 20,
      }),
    ).toEqual({
      sleepCheckIntervalMilliseconds: 10,
      sleepDriftThresholdMilliseconds: 20,
    });
  });

  it('waits for a ready child and rejects a child that exits first', async () => {
    const ready = spawn(process.execPath, ['-e', "process.send({ type: 'vault-service-ready' })"], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const readyExited = new Promise<void>((resolve) => ready.once('exit', () => resolve()));
    await expect(__testing.waitForVaultServiceReady(ready)).resolves.toBeUndefined();
    if (ready.connected) ready.disconnect();
    await readyExited;

    const stopped = spawn(process.execPath, ['-e', 'process.exit(1)'], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    await expect(__testing.waitForVaultServiceReady(stopped)).rejects.toThrow(
      'The InFlow vault service did not start.',
    );

    const failed = spawn('/definitely/missing/inflow');
    await expect(__testing.waitForVaultServiceReady(failed)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('authenticates and transfers broker sockets until the service exits cleanly', async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      connected: true,
      disconnect: vi.fn(() => {
        Object.assign(child, { connected: false });
      }),
      send: vi.fn(
        (
          _message: unknown,
          _socket: Socket,
          _options: { keepOpen: boolean },
          callback: (error: Error | null) => void,
        ) => callback(null),
      ),
    });
    const signalHandlers = new Map<'SIGINT' | 'SIGTERM', () => void>();
    const authenticateClient = vi.fn(() => Promise.resolve());
    let connection: ((socket: Socket) => void) | undefined;
    const run = __testing.runLinuxVaultBrokerWithDependencies(
      3,
      { gid: 1000, uid: 1000 },
      {
        authenticateClient,
        closeServer: () => Promise.resolve(),
        createBrokerServer(listener) {
          connection = listener;
          return createServer();
        },
        createPeerVerifier: () => (socket) => {
          if (socket.destroyed) throw new Error('rejected peer');
          return { path: '/opt/inflow/bin/inflow', pid: 123, uid: 1000 };
        },
        ensureBrokerKey: () => Promise.resolve(generateKeyPairSync('ed25519').privateKey),
        listenServer: () => {
          const socket = new Socket();
          vi.spyOn(socket, 'destroy');
          connection?.(socket);
          const rejected = new Socket();
          rejected.destroy();
          connection?.(rejected);
          return Promise.resolve();
        },
        runtime: {
          once(event, handler) {
            signalHandlers.set(event, handler);
          },
        },
        spawnService: () => child,
      },
    );
    child.emit('message', { type: 'vault-service-ready' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    signalHandlers.get('SIGINT')?.();
    signalHandlers.get('SIGTERM')?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    child.emit('exit', 0, null);

    await expect(run).resolves.toBeUndefined();
    expect(authenticateClient).toHaveBeenCalledOnce();
  });

  it('closes the tenant manager when Linux service socket startup fails', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-service-failure-'));
    await expect(
      startLinuxVaultService({
        rootDirectory: join(tmpDir, 'vaults'),
        socketPath: join(tmpDir, 'run', 'x'.repeat(180)),
      }),
    ).rejects.toBeDefined();
  });

  it('propagates broker close failures', async () => {
    const server = {
      close(callback: (cause?: Error) => void) {
        callback(new Error('close failed'));
      },
      listening: true,
    } as Server;

    await expect(__testing.closeBroker(server)).rejects.toThrow('close failed');
  });

  it('rejects an unexpected vault service exit after broker startup', async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { connected: false, disconnect: vi.fn(), send: vi.fn() });
    const run = __testing.runLinuxVaultBrokerWithDependencies(
      3,
      { gid: 1000, uid: 1000 },
      {
        authenticateClient: vi.fn(() => Promise.resolve()),
        closeServer: () => Promise.resolve(),
        createBrokerServer: () => createServer(),
        createPeerVerifier: () => () => ({ path: '/opt/inflow/bin/inflow', pid: 123, uid: 1000 }),
        ensureBrokerKey: () => Promise.resolve(generateKeyPairSync('ed25519').privateKey),
        listenServer: () => Promise.resolve(),
        runtime: { once: vi.fn() },
        spawnService: () => child,
      },
    );
    child.emit('message', { type: 'vault-service-ready' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    child.emit('exit', 1, null);

    await expect(run).rejects.toThrow('exited unexpectedly');
  });

  it('validates the dedicated Linux service identity directory', () => {
    const identityDirectory = mkdtempSync(join(tmpdir(), 'inflow-vault-identity-'));
    tmpDir = identityDirectory;
    chmodSync(identityDirectory, 0o700);
    const identityStat = lstatSync(identityDirectory);
    if (identityStat.uid === 0 || identityStat.gid === 0) {
      expect(() => __testing.linuxVaultServiceIdentity(identityDirectory)).toThrow('service identity is invalid');
    } else {
      expect(__testing.linuxVaultServiceIdentity(identityDirectory)).toMatchObject({
        gid: identityStat.gid,
        uid: identityStat.uid,
      });
    }

    const file = join(identityDirectory, 'file');
    const link = join(identityDirectory, 'link');
    writeFileSync(file, '');
    symlinkSync(identityDirectory, link);
    expect(() => __testing.linuxVaultServiceIdentity(file)).toThrow('service identity is invalid');
    expect(() => __testing.linuxVaultServiceIdentity(link)).toThrow('service identity is invalid');
    chmodSync(identityDirectory, 0o755);
    expect(() => __testing.linuxVaultServiceIdentity(identityDirectory)).toThrow('service identity is invalid');
  });

  it('rejects invalid broker descriptors and destroys sockets when the service IPC channel is closed', async () => {
    const server = createServer();
    await expect(__testing.listenBroker(server, -1)).rejects.toBeDefined();

    const child = spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const socket = new Socket();
    const destroy = vi.spyOn(socket, 'destroy');
    __testing.transferSocketToVaultService(child, socket, {
      path: '/opt/inflow/bin/inflow',
      pid: 123,
      uid: 1000,
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('closes listening and already-closed broker servers', async () => {
    const idle = createServer();
    await expect(__testing.closeBroker(idle)).resolves.toBeUndefined();

    const listening = createServer();
    await new Promise<void>((resolve, reject) => {
      listening.once('error', reject);
      listening.listen(0, '127.0.0.1', resolve);
    });
    await expect(__testing.closeBroker(listening)).resolves.toBeUndefined();
  });

  it('closes the daemon before exiting on termination signals', async () => {
    const handlers = new Map<'SIGINT' | 'SIGTERM', () => Promise<void>>();
    const exits: number[] = [];
    let closed = 0;
    const runtime: LocalVaultDaemonRuntime = {
      exit(code) {
        exits.push(code);
      },
      once(signal, handler) {
        handlers.set(signal, handler);
      },
    };

    attachLocalVaultDaemonSignalHandlers(
      {
        close() {
          closed += 1;
          return Promise.resolve();
        },
        closed: Promise.resolve(),
        socketPath: '/tmp/inflow-test-vault.sock',
      },
      runtime,
    );

    await handlers.get('SIGTERM')?.();

    expect(closed).toBe(1);
    expect(exits).toEqual([0]);
    expect(handlers.has('SIGINT')).toBe(true);
  });

  it('stops accepting IPC after a reset request', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-daemon-'));
    daemon = await startLocalVaultDaemon({ rootDirectory: tmpDir });

    await expect(
      sendVaultIpcRequest(daemon.socketPath, {
        id: 'req_reset',
        method: 'vault.reset',
        params: {},
        version: 1,
      }),
    ).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expectClosed(daemon.closed);

    await expect(
      sendVaultIpcRequest(daemon.socketPath, {
        id: 'req_after_reset',
        method: 'vault.status',
        params: {},
        version: 1,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops accepting IPC after a shutdown request', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-daemon-'));
    daemon = await startLocalVaultDaemon({ rootDirectory: tmpDir });

    await expect(
      sendVaultIpcRequest(daemon.socketPath, {
        id: 'req_shutdown',
        method: 'daemon.shutdown',
        params: {},
        version: 1,
      }),
    ).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expectClosed(daemon.closed);

    await expect(
      sendVaultIpcRequest(daemon.socketPath, {
        id: 'req_after_shutdown',
        method: 'vault.status',
        params: {},
        version: 1,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops accepting IPC after the configured idle timeout', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-daemon-'));
    daemon = await startLocalVaultDaemon({ rootDirectory: tmpDir });

    await sendVaultIpcRequest(daemon.socketPath, {
      id: 'req_unlock',
      method: 'vault.unlock',
      params: { salt: Buffer.alloc(16), wrappingKey: Buffer.alloc(32) },
      version: 1,
    });
    await expect(
      sendVaultIpcRequest(daemon.socketPath, {
        id: 'req_policy',
        method: 'vault.setPolicy',
        params: {
          policy: {
            idleTimeoutSeconds: 1,
            lockOnSleep: true,
          },
        },
        version: 1,
      }),
    ).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expectClosed(daemon.closed);

    await expect(
      sendVaultIpcRequest(daemon.socketPath, {
        id: 'req_after_idle',
        method: 'vault.status',
        params: {},
        version: 1,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops accepting IPC after sleep-like timer drift when sleep locking is enabled', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-daemon-'));
    daemon = await startLocalVaultDaemon({
      rootDirectory: tmpDir,
      sleepCheckIntervalMilliseconds: 10,
      sleepDriftThresholdMilliseconds: 25,
    });

    await sendVaultIpcRequest(daemon.socketPath, {
      id: 'req_unlock',
      method: 'vault.unlock',
      params: { salt: Buffer.alloc(16), wrappingKey: Buffer.alloc(32) },
      version: 1,
    });
    await sendVaultIpcRequest(daemon.socketPath, {
      id: 'req_policy',
      method: 'vault.setPolicy',
      params: {
        policy: {
          idleTimeoutSeconds: null,
          lockOnSleep: true,
        },
      },
      version: 1,
    });

    blockEventLoop(80);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expectClosed(daemon.closed);

    await expect(
      sendVaultIpcRequest(daemon.socketPath, {
        id: 'req_after_sleep',
        method: 'vault.status',
        params: {},
        version: 1,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function expectClosed(closed: Promise<void>): Promise<void> {
  await expect(Promise.race([closed.then(() => 'closed'), delay(500).then(() => 'open')])).resolves.toBe('closed');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function vaultReferenceFromPut(response: VaultIpcResponse): string {
  if (!response.ok) throw new Error('expected successful put response');
  const reference = response.result['reference'];
  if (typeof reference !== 'string') throw new Error('expected string reference');
  return reference;
}

function blockEventLoop(milliseconds: number): void {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    Math.sqrt(deadline);
  }
}
