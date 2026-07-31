import { createServer, type Server } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { __testing, LocalVaultClient } from '../../../src/secure-storage/vault-client.js';
import {
  decodeVaultIpcFrame,
  encodeVaultIpcMessage,
  type VaultIpcRequest,
  type VaultIpcResponse,
} from '../../../src/secure-storage/vault-ipc.js';

describe('LocalVaultClient', () => {
  let server: Server | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
    if (tmpDir !== undefined) rmSync(tmpDir, { force: true, recursive: true });
    tmpDir = undefined;
  });

  it('maps vault status and policy responses from the local socket', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-client-'));
    await listenWithResponder(tmpDir, (request) => {
      if (request.method === 'vault.status') {
        return {
          id: request.id,
          ok: true,
          result: { daemonRunning: true, lockState: 'unlocked' },
          version: 1,
        };
      }
      if (request.method === 'daemon.info') {
        return {
          id: request.id,
          ok: true,
          result: {
            buildId: 'build-1',
            cliVersion: '0.9.0',
            executablePath: '/Applications/InFlow.app/Contents/MacOS/inflow',
            pid: 123,
          },
          version: 1,
        };
      }
      return {
        id: request.id,
        ok: true,
        result: {
          idleTimeoutSeconds: 120,
          lockOnSleep: false,
        },
        version: 1,
      };
    });
    const client = new LocalVaultClient({ rootDirectory: tmpDir });

    await expect(client.status()).resolves.toEqual({ daemonRunning: true, lockState: 'unlocked' });
    await expect(client.info()).resolves.toEqual({
      buildId: 'build-1',
      cliVersion: '0.9.0',
      executablePath: '/Applications/InFlow.app/Contents/MacOS/inflow',
      pid: 123,
    });
    await expect(client.getPolicy()).resolves.toEqual({
      idleTimeoutSeconds: 120,
      lockOnSleep: false,
    });
  });

  it('maps daemon errors into secure storage errors', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-client-'));
    await listenWithResponder(tmpDir, (request) => ({
      error: { code: 'secure_storage_secret_missing', message: 'The InFlow vault is locked.' },
      id: request.id,
      ok: false,
      version: 1,
    }));
    const client = new LocalVaultClient({ rootDirectory: tmpDir });

    await expect(client.unlock(Buffer.from('123456'))).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_secret_missing',
    });
  });

  it('rejects an unlock response when an independent status request remains locked', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-client-'));
    await listenWithResponder(tmpDir, (request) => ({
      id: request.id,
      ok: true,
      result:
        request.method === 'vault.unlockSalt'
          ? { salt: Buffer.alloc(16) }
          : request.method === 'vault.unlock'
            ? { daemonRunning: true, lockState: 'unlocked' }
            : { daemonRunning: true, lockState: 'locked' },
      version: 1,
    }));
    const client = new LocalVaultClient({ rootDirectory: tmpDir });

    await expect(client.unlock(Buffer.from('123456'))).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_corrupt',
    });
  });

  it('rejects a response for a different request', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-client-'));
    await listenWithResponder(tmpDir, () => ({
      id: 'req_stale',
      ok: true,
      result: { daemonRunning: true, lockState: 'locked' },
      version: 1,
    }));
    const client = new LocalVaultClient({ rootDirectory: tmpDir });

    await expect(client.status()).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_corrupt',
    });
  });

  it('sends lifecycle and policy update requests', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-client-'));
    const methods: string[] = [];
    let statusRequests = 0;
    let unlockRequests = 0;
    await listenWithResponder(tmpDir, (request) => {
      methods.push(request.method);
      if (request.method === 'vault.unlock') {
        unlockRequests += 1;
        if (unlockRequests === 1) {
          return {
            error: { code: 'secure_storage_corrupt', message: 'Vault material could not be unwrapped.' },
            id: request.id,
            ok: false,
            version: 1,
          };
        }
        return {
          id: request.id,
          ok: true,
          result: { daemonRunning: true, lockState: 'unlocked' },
          version: 1,
        };
      }
      if (request.method === 'vault.status') statusRequests += 1;
      return {
        id: request.id,
        ok: true,
        result:
          request.method === 'vault.setPolicy'
            ? {
                idleTimeoutSeconds: null,
                lockOnSleep: false,
              }
            : request.method === 'vault.unlockSalt'
              ? { salt: Buffer.alloc(16) }
              : request.method === 'vault.status'
                ? { daemonRunning: true, lockState: statusRequests === 1 ? 'locked' : 'unlocked' }
                : {},
        version: 1,
      };
    });
    const client = new LocalVaultClient({ rootDirectory: tmpDir });

    await expect(
      client.setPolicy({
        idleTimeoutSeconds: null,
        lockOnSleep: false,
      }),
    ).resolves.toEqual({
      idleTimeoutSeconds: null,
      lockOnSleep: false,
    });
    await expect(client.changePassphrase(Buffer.from('current'), Buffer.from('next123'))).resolves.toBeUndefined();
    await expect(client.lock()).resolves.toBeUndefined();
    await expect(client.reset()).resolves.toBeUndefined();
    await expect(client.shutdown()).resolves.toBeUndefined();

    expect(methods).toEqual([
      'vault.setPolicy',
      'vault.unlockSalt',
      'vault.changePassphrase',
      'vault.lock',
      'vault.unlockSalt',
      'vault.unlock',
      'vault.status',
      'vault.unlockSalt',
      'vault.unlock',
      'vault.status',
      'vault.lock',
      'vault.reset',
      'daemon.shutdown',
    ]);
  }, 15_000);

  it('rejects malformed status and policy payloads', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-client-'));
    await listenWithResponder(tmpDir, (request) => ({
      id: request.id,
      ok: true,
      result:
        request.method === 'vault.status' ? { daemonRunning: true, lockState: 'bogus' } : { idleTimeoutSeconds: -1 },
      version: 1,
    }));
    const client = new LocalVaultClient({ rootDirectory: tmpDir });

    await expect(client.status()).rejects.toMatchObject({ secureStorageCode: 'secure_storage_corrupt' });
    await expect(client.getPolicy()).rejects.toMatchObject({ secureStorageCode: 'secure_storage_corrupt' });
  });

  it('rejects an unchanged passphrase before contacting the daemon', async () => {
    const client = new LocalVaultClient({ rootDirectory: join(tmpdir(), 'missing-inflow-vault') });
    const factor = Buffer.from('current');

    await expect(client.changePassphrase(factor, Buffer.from(factor))).rejects.toMatchObject({
      secureStorageCode: 'secure_storage_invalid_path',
    });
  });

  it('validates every daemon response field and preserves recognized error codes', () => {
    expect(__testing.parseInfo({ buildId: null, cliVersion: null, executablePath: '/inflow', pid: 0 })).toEqual({
      buildId: null,
      cliVersion: null,
      executablePath: '/inflow',
      pid: 0,
    });
    for (const malformed of [
      { buildId: 1, cliVersion: null, executablePath: '/inflow', pid: 1 },
      { buildId: null, cliVersion: 1, executablePath: '/inflow', pid: 1 },
      { buildId: null, cliVersion: null, executablePath: 1, pid: 1 },
      { buildId: null, cliVersion: null, executablePath: '/inflow', pid: -1 },
    ]) {
      expect(() => __testing.parseInfo(malformed)).toThrow('daemon info response is malformed');
    }

    for (const lockState of ['locked', 'not_initialized', 'unlocked'] as const) {
      expect(__testing.parseStatus({ daemonRunning: false, lockState })).toEqual({ daemonRunning: false, lockState });
    }
    expect(() => __testing.parseStatus({ daemonRunning: 'yes', lockState: 'locked' })).toThrow(
      'status response is malformed',
    );
    expect(() => __testing.parseStatus({ daemonRunning: true, lockState: 'invalid' })).toThrow(
      'status response is malformed',
    );

    expect(__testing.parsePolicy({ idleTimeoutSeconds: 0, lockOnSleep: true })).toEqual({
      idleTimeoutSeconds: 0,
      lockOnSleep: true,
    });
    expect(__testing.parsePolicy({ idleTimeoutSeconds: null, lockOnSleep: false })).toEqual({
      idleTimeoutSeconds: null,
      lockOnSleep: false,
    });
    expect(() => __testing.parsePolicy({ idleTimeoutSeconds: 1.5, lockOnSleep: true })).toThrow(
      'policy response is malformed',
    );
    expect(() => __testing.parsePolicy({ idleTimeoutSeconds: 1, lockOnSleep: 1 })).toThrow(
      'policy response is malformed',
    );

    const recognized = [
      'secure_storage_corrupt',
      'secure_storage_invalid_path',
      'secure_storage_io_error',
      'secure_storage_peer_verification_failed',
      'secure_storage_secret_conflict',
      'secure_storage_secret_missing',
      'secure_storage_unavailable',
      'vault_daemon_busy',
      'vault_locked',
      'vault_not_initialized',
    ] as const;
    for (const code of recognized) expect(__testing.codeFromResponse(code)).toBe(code);
    expect(__testing.codeFromResponse('unknown')).toBe('secure_storage_io_error');
  });

  it('copies and clears valid salts and rejects malformed salts', () => {
    const salt = Buffer.alloc(16, 7);
    expect(__testing.parseSalt({ salt })).toEqual(Buffer.alloc(16, 7));
    expect(salt).toEqual(Buffer.alloc(16));
    expect(() => __testing.parseSalt({ salt: Buffer.alloc(15) })).toThrow('unlock salt response is malformed');
    expect(() => __testing.parseSalt({ salt: 'not-bytes' })).toThrow('unlock salt response is malformed');
  });

  async function listenWithResponder(rootDirectory: string, respond: (request: VaultIpcRequest) => VaultIpcResponse) {
    const socketPath = join(rootDirectory, 'run', 'vault.sock');
    mkdirSync(join(rootDirectory, 'run'));
    server = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        const frame = Buffer.concat(chunks);
        if (frame.byteLength < 4) return;
        const length = frame.readUInt32BE(0);
        if (frame.byteLength < length + 4) return;
        const parsed = decodeVaultIpcFrame(frame.subarray(0, length + 4));
        if (!('method' in parsed)) throw new Error('expected request');
        socket.end(encodeVaultIpcMessage(respond(parsed)));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(socketPath, () => {
        server?.off('error', reject);
        resolve();
      });
    });
  }
});

function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((cause) => {
      if (cause !== undefined) {
        reject(cause);
        return;
      }
      resolve();
    });
  });
}
