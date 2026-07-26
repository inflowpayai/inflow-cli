import { Buffer } from 'node:buffer';
import { createConnection, createServer, type Socket } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  VaultBackend,
  VaultPolicy,
  VaultSecretPayload,
  VaultStatus,
} from '../../../src/secure-storage/vault-backend.js';
import { SecureStorageError } from '../../../src/secure-storage/errors.js';
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
  private active = true;
  private locked = false;
  readonly secret: VaultSecretPayload;

  constructor(payload = 'socket-secret') {
    this.secret = {
      payload: Buffer.from(payload),
      reference: { reference: 'vlt_22222222222222222222222222222222' },
    };
  }

  changePassphrase(_currentUnlockFactor: Uint8Array, _nextUnlockFactor: Uint8Array): void {}

  changeWrappingKey(_currentWrappingKey: Uint8Array, _nextWrappingKey: Uint8Array, _nextSalt: Uint8Array): void {}

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
    if (!this.active) {
      throw new SecureStorageError('secure_storage_secret_missing', 'The vault secret was not found.');
    }
    return { payload: Buffer.from(this.secret.payload), reference: this.secret.reference };
  }

  lock(): void {
    this.locked = true;
  }

  putSecret(_input: { expectedKind: 'inflow_api_key'; payload: Uint8Array }): VaultSecretReference {
    return this.secret.reference;
  }

  reset(): Promise<void> {
    this.active = false;
    return Promise.resolve();
  }

  setPolicy(policy: VaultPolicy): VaultPolicy {
    return policy;
  }

  status(): VaultStatus {
    return { daemonRunning: true, lockState: this.locked ? 'locked' : 'unlocked' };
  }

  touch(_input: { expectedKind: 'inflow_api_key'; reference: VaultSecretReference }): void {}

  unlock(_unlockFactor: Uint8Array): VaultStatus {
    this.locked = false;
    return this.status();
  }

  unlockSalt(): Uint8Array {
    return Buffer.alloc(16);
  }

  unlockWithWrappingKey(_wrappingKey: Uint8Array, _salt: Uint8Array): VaultStatus {
    this.locked = false;
    return this.status();
  }
}

class BlockingSocketVaultBackend extends SocketVaultBackend {
  private releaseReset: () => void = () => undefined;
  private resolveResetStarted: () => void = () => undefined;
  readonly resetStarted = new Promise<void>((resolve) => {
    this.resolveResetStarted = resolve;
  });
  statusCalls = 0;

  finishReset(): void {
    this.releaseReset();
  }

  override async reset(): Promise<void> {
    this.resolveResetStarted();
    await new Promise<void>((resolve) => {
      this.releaseReset = resolve;
    });
    await super.reset();
  }

  override status(): VaultStatus {
    this.statusCalls += 1;
    return super.status();
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
      result: { payload: Buffer.from('socket-secret') },
    });
  });

  it('authenticates the daemon before transmitting request bytes', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-socket-'));
    const socketPath = join(tmpDir, 'run', 'vault.sock');
    mkdirSync(join(tmpDir, 'run'));
    let receivedBytes = false;
    const fakeDaemon = createServer((socket) => {
      socket.on('data', () => {
        receivedBytes = true;
      });
    });
    await new Promise<void>((resolve, reject) => {
      fakeDaemon.once('error', reject);
      fakeDaemon.listen(socketPath, resolve);
    });
    servers.push({
      close: () =>
        new Promise<void>((resolve, reject) => {
          fakeDaemon.close((cause) => {
            if (cause !== undefined) {
              reject(cause);
              return;
            }
            resolve();
          });
        }),
      socketPath,
    });

    await expect(
      sendVaultIpcRequest(socketPath, request('vault.status'), () => {
        throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
      }),
    ).rejects.toMatchObject({ secureStorageCode: 'secure_storage_peer_verification_failed' });
    expect(receivedBytes).toBe(false);
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

  it('routes authenticated peers to isolated tenant backends', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-socket-'));
    const socketPath = join(tmpDir, 'run', 'vault.sock');
    const backends = new Map([
      [1001, new SocketVaultBackend('tenant-a-secret')],
      [1002, new SocketVaultBackend('tenant-b-secret')],
    ]);
    const peerUserIds = [1001, 1002, 1001, 1002, 1001, 1002];
    const backendForPeer = vi.fn((peer: { uid: number }) => {
      const backend = backends.get(peer.uid);
      if (backend === undefined) throw new Error('unknown peer');
      return backend;
    });
    servers.push(
      await startVaultSocketServer({
        backendForPeer,
        peerVerifier() {
          const uid = peerUserIds.shift();
          if (uid === undefined) throw new Error('unexpected connection');
          return { path: '/usr/bin/inflow', pid: uid, uid };
        },
        socketPath,
      }),
    );
    const secretRequest = request('secret.get', {
      expectedKind: 'inflow_api_key',
      reference: 'vlt_22222222222222222222222222222222',
    });

    await expect(sendVaultIpcRequest(socketPath, secretRequest)).resolves.toMatchObject({
      ok: true,
      result: { payload: Buffer.from('tenant-a-secret') },
    });
    await expect(sendVaultIpcRequest(socketPath, secretRequest)).resolves.toMatchObject({
      ok: true,
      result: { payload: Buffer.from('tenant-b-secret') },
    });
    await expect(sendVaultIpcRequest(socketPath, request('vault.reset'))).resolves.toMatchObject({ ok: true });
    await expect(sendVaultIpcRequest(socketPath, secretRequest)).resolves.toMatchObject({
      ok: true,
      result: { payload: Buffer.from('tenant-b-secret') },
    });
    await expect(sendVaultIpcRequest(socketPath, request('daemon.shutdown'))).resolves.toMatchObject({
      error: {
        code: 'secure_storage_unavailable',
        message: 'The vault service lifecycle is managed by the operating system.',
      },
      ok: false,
    });
    await expect(sendVaultIpcRequest(socketPath, request('vault.status'))).resolves.toMatchObject({
      ok: true,
      result: { lockState: 'unlocked' },
    });
    expect(backendForPeer.mock.calls.map(([peer]) => peer.uid)).toEqual([1001, 1002, 1001, 1002, 1001, 1002]);
  });

  it('serializes concurrent requests for one tenant backend', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-socket-'));
    const socketPath = join(tmpDir, 'run', 'vault.sock');
    const backend = new BlockingSocketVaultBackend();
    servers.push(await startVaultSocketServer({ backend, socketPath }));

    const reset = sendVaultIpcRequest(socketPath, request('vault.reset'));
    await backend.resetStarted;
    const status = sendVaultIpcRequest(socketPath, request('vault.status'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(backend.statusCalls).toBe(0);

    backend.finishReset();

    await expect(reset).resolves.toMatchObject({ ok: true });
    await expect(status).resolves.toMatchObject({ ok: true });
    expect(backend.statusCalls).toBe(1);
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
