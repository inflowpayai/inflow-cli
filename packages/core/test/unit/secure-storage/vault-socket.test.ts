import { Buffer } from 'node:buffer';
import { createConnection, createServer, type Socket } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  VaultBackend,
  VaultPolicy,
  VaultSecretPayload,
  VaultStatus,
} from '../../../src/secure-storage/vault-backend.js';
import {
  sendVaultIpcRequest,
  startVaultSocketServer,
  type VaultSocketServer,
} from '../../../src/secure-storage/vault-socket.js';
import {
  decodeVaultIpcFrame,
  encodeVaultIpcMessage,
  VAULT_IPC_MAX_MESSAGE_BYTES,
  type VaultIpcRequest,
} from '../../../src/secure-storage/vault-ipc.js';
import type { VaultSecretReference } from '../../../src/secure-storage/vault-types.js';

class SocketVaultBackend implements VaultBackend {
  secret: VaultSecretPayload = {
    payload: Buffer.from('socket-secret'),
    reference: { reference: 'vlt_22222222222222222222222222222222' },
  };

  changePassphrase(_currentUnlockFactor: Uint8Array, _nextUnlockFactor: Uint8Array): void {}

  deleteExpired(_input: { now: string }): void {}

  deleteSecret(_input: { expectedKind: 'inflow_api_key'; reference: VaultSecretReference }): void {}

  exists(_input: { expectedKind: 'inflow_api_key'; reference: VaultSecretReference }): boolean {
    return true;
  }

  getPolicy(): VaultPolicy {
    return {
      idleTimeoutSeconds: 28_800,
      lockOnSleep: true,
    };
  }

  getSecret(_input: { expectedKind: 'inflow_api_key'; reference: VaultSecretReference }): VaultSecretPayload {
    return this.secret;
  }

  lock(): void {}

  putSecret(_input: { expectedKind: 'inflow_api_key'; payload: Uint8Array }): VaultSecretReference {
    return this.secret.reference;
  }

  reset(): void {}

  setPolicy(policy: VaultPolicy): VaultPolicy {
    return policy;
  }

  status(): VaultStatus {
    return { daemonRunning: true, lockState: 'unlocked' };
  }

  touch(_input: { expectedKind: 'inflow_api_key'; reference: VaultSecretReference }): void {}

  unlock(_unlockFactor: Uint8Array): VaultStatus {
    return this.status();
  }
}

function request(method: VaultIpcRequest['method'], params: Record<string, unknown> = {}): VaultIpcRequest {
  return { id: 'req_socket', method, params, version: 1 };
}

describe('vault socket transport', () => {
  const servers: VaultSocketServer[] = [];
  let tmpDir: string | undefined;

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    if (tmpDir !== undefined) rmSync(tmpDir, { force: true, recursive: true });
    tmpDir = undefined;
  });

  it('sends one bounded IPC request and receives one response', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-socket-'));
    const socketPath = join(tmpDir, 'run', 'vault.sock');
    servers.push(await startVaultSocketServer({ backend: new SocketVaultBackend(), socketPath }));

    await expect(sendVaultIpcRequest(socketPath, request('vault.status'))).resolves.toMatchObject({
      id: 'req_socket',
      ok: true,
      result: { daemonRunning: true, lockState: 'unlocked' },
    });
    await expect(
      sendVaultIpcRequest(
        socketPath,
        request('secret.get', {
          expectedKind: 'inflow_api_key',
          reference: 'vlt_22222222222222222222222222222222',
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { payload: Buffer.from('socket-secret').toString('base64') },
    });
  });

  it('removes stale socket files before listening', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-socket-'));
    const socketPath = join(tmpDir, 'run', 'vault.sock');
    mkdirSync(join(tmpDir, 'run'));
    await writeFile(socketPath, 'stale');
    servers.push(await startVaultSocketServer({ backend: new SocketVaultBackend(), socketPath }));

    await expect(sendVaultIpcRequest(socketPath, request('vault.status'))).resolves.toMatchObject({
      ok: true,
      result: { lockState: 'unlocked' },
    });
  });

  it('refuses to unlink a reachable daemon socket', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-socket-'));
    const socketPath = join(tmpDir, 'run', 'vault.sock');
    mkdirSync(join(tmpDir, 'run'));
    const existing = createServer((socket) => {
      socket.end();
    });
    await new Promise<void>((resolve, reject) => {
      existing.once('error', reject);
      existing.listen(socketPath, () => {
        existing.off('error', reject);
        resolve();
      });
    });
    servers.push({
      close: () =>
        new Promise<void>((resolve, reject) => {
          existing.close((cause) => {
            if (cause !== undefined) {
              reject(cause);
              return;
            }
            resolve();
          });
        }),
      socketPath,
    });

    await expect(startVaultSocketServer({ backend: new SocketVaultBackend(), socketPath })).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_unavailable',
    });
  });

  it('returns a redacted socket response for malformed request frames', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-socket-'));
    const socketPath = join(tmpDir, 'run', 'vault.sock');
    servers.push(await startVaultSocketServer({ backend: new SocketVaultBackend(), socketPath }));
    const socket = createConnection(socketPath);
    const response = readRawFrame(socket);
    socket.end(
      encodeVaultIpcMessage({
        id: 'response_instead_of_request',
        ok: true,
        result: {},
        version: 1,
      }),
    );

    await expect(response.then((frame) => decodeVaultIpcFrame(frame))).resolves.toMatchObject({
      error: {
        code: 'secure_storage_corrupt',
        message: 'Vault IPC request is malformed.',
      },
      ok: false,
    });
  });

  it('closes an oversized frame after reading only its declared length', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-socket-'));
    const socketPath = join(tmpDir, 'run', 'vault.sock');
    servers.push(await startVaultSocketServer({ backend: new SocketVaultBackend(), socketPath }));
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const closed = new Promise<boolean>((resolve, reject) => {
      socket.once('close', resolve);
      socket.once('error', reject);
    });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(VAULT_IPC_MAX_MESSAGE_BYTES + 1);
    socket.write(header);

    await expect(closed).resolves.toBe(false);
  });

  it('returns a redacted socket response when peer verification fails', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-socket-'));
    const socketPath = join(tmpDir, 'run', 'vault.sock');
    servers.push(
      await startVaultSocketServer({
        backend: new SocketVaultBackend(),
        peerVerifier() {
          throw new Error('wrong peer');
        },
        socketPath,
      }),
    );

    await expect(sendVaultIpcRequest(socketPath, request('vault.status'))).resolves.toMatchObject({
      error: { code: 'secure_storage_io_error' },
      id: 'unknown',
      ok: false,
    });
  });

  it('rejects malformed socket responses', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-socket-'));
    const socketPath = join(tmpDir, 'vault.sock');
    const rawSockets = new Set<Socket>();
    const server = createServer((socket) => {
      rawSockets.add(socket);
      socket.on('close', () => {
        rawSockets.delete(socket);
      });
      socket.end(encodeVaultIpcMessage(request('vault.status')));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    servers.push({
      close: () =>
        new Promise<void>((resolve, reject) => {
          for (const socket of rawSockets) socket.destroy();
          server.close((cause) => {
            if (cause !== undefined) {
              reject(cause);
              return;
            }
            resolve();
          });
        }),
      socketPath,
    });

    await expect(sendVaultIpcRequest(socketPath, request('vault.status'))).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_corrupt',
    });
  });

  it('rejects truncated socket responses', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-socket-'));
    const socketPath = join(tmpDir, 'vault.sock');
    const rawSockets = new Set<Socket>();
    const server = createServer((socket) => {
      rawSockets.add(socket);
      socket.on('close', () => {
        rawSockets.delete(socket);
      });
      socket.end(Buffer.from([0, 0, 0, 8, 123]));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    servers.push({
      close: () =>
        new Promise<void>((resolve, reject) => {
          for (const socket of rawSockets) socket.destroy();
          server.close((cause) => {
            if (cause !== undefined) {
              reject(cause);
              return;
            }
            resolve();
          });
        }),
      socketPath,
    });

    await expect(sendVaultIpcRequest(socketPath, request('vault.status'))).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_corrupt',
    });
  });

  it('rejects unsafe socket paths before listening', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-socket-'));
    const socketPath = join(tmpDir, 'run', 'vault.sock');
    mkdirSync(join(tmpDir, 'run'));
    symlinkSync('/tmp/unsafe-vault.sock', socketPath);

    await expect(startVaultSocketServer({ backend: new SocketVaultBackend(), socketPath })).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_invalid_path',
    });
  });
});

function readRawFrame(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (buffer.byteLength < 4) return;
      const length = buffer.readUInt32BE(0);
      if (buffer.byteLength >= length + 4) {
        resolve(buffer.subarray(0, length + 4));
      }
    });
    socket.on('error', reject);
  });
}
