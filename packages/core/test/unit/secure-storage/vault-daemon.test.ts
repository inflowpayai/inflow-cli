import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecureStorageError } from '../../../src/secure-storage/errors.js';
import { sendVaultIpcRequest } from '../../../src/secure-storage/vault-socket.js';
import {
  attachLocalVaultDaemonSignalHandlers,
  runLinuxTransferredVaultService,
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
  });

  it('rejects Linux service entry points on other operating systems', async () => {
    await expect(runLinuxVaultService()).rejects.toThrow('available only on Linux');
    await expect(runLinuxVaultBroker()).rejects.toThrow('available only on Linux');
    await expect(runLinuxTransferredVaultService()).rejects.toThrow('requires its authenticated broker');
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
