import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sendVaultIpcRequest } from '../../../src/secure-storage/vault-socket.js';
import {
  attachLocalVaultDaemonSignalHandlers,
  startLocalVaultDaemon,
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
    daemon = await startLocalVaultDaemon({ rootDirectory: tmpDir });

    await expect(
      sendVaultIpcRequest(daemon.socketPath, {
        id: 'req_1',
        method: 'vault.unlock',
        params: { unlockFactor: Buffer.from('123456').toString('base64') },
        version: 1,
      }),
    ).resolves.toMatchObject({ ok: true, result: { lockState: 'unlocked' } });
    const putResponse = await sendVaultIpcRequest(daemon.socketPath, {
      id: 'req_2',
      method: 'secret.put',
      params: {
        expectedKind: 'inflow_api_key',
        payload: Buffer.from('api-key').toString('base64'),
      },
      version: 1,
    });

    expect(vaultReferenceFromPut(putResponse)).toMatch(/^vlt_[0-9a-f]{32}$/);
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
        socketPath: '/tmp/inflow-test-vault.sock',
      },
      runtime,
    );

    await handlers.get('SIGTERM')?.();

    expect(closed).toBe(1);
    expect(exits).toEqual([0]);
    expect(handlers.has('SIGINT')).toBe(true);
  });

  it('stops accepting IPC after the configured idle timeout', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-daemon-'));
    daemon = await startLocalVaultDaemon({ rootDirectory: tmpDir });

    await sendVaultIpcRequest(daemon.socketPath, {
      id: 'req_unlock',
      method: 'vault.unlock',
      params: { unlockFactor: Buffer.from('123456').toString('base64') },
      version: 1,
    });
    await expect(
      sendVaultIpcRequest(daemon.socketPath, {
        id: 'req_policy',
        method: 'vault.setPolicy',
        params: {
          policy: {
            idleTimeoutSeconds: 1,
            lockOnDaemonExit: true,
            lockOnExplicitLogout: true,
            lockOnSleep: true,
          },
        },
        version: 1,
      }),
    ).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 1_100));

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
      params: { unlockFactor: Buffer.from('123456').toString('base64') },
      version: 1,
    });
    await sendVaultIpcRequest(daemon.socketPath, {
      id: 'req_policy',
      method: 'vault.setPolicy',
      params: {
        policy: {
          idleTimeoutSeconds: null,
          lockOnDaemonExit: true,
          lockOnExplicitLogout: true,
          lockOnSleep: true,
        },
      },
      version: 1,
    });

    blockEventLoop(80);
    await new Promise((resolve) => setTimeout(resolve, 30));

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
