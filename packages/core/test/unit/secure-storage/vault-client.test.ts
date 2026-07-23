import { createServer, type Server } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalVaultClient } from '../../../src/secure-storage/vault-client.js';
import {
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

  it('sends lifecycle and policy update requests', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-vault-client-'));
    const methods: string[] = [];
    await listenWithResponder(tmpDir, (request) => {
      methods.push(request.method);
      return {
        id: request.id,
        ok: true,
        result:
          request.method === 'vault.setPolicy'
            ? {
                idleTimeoutSeconds: null,
                lockOnSleep: false,
              }
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
      'vault.changePassphrase',
      'vault.lock',
      'vault.reset',
      'daemon.shutdown',
    ]);
  });

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
        const parsed = JSON.parse(frame.subarray(4, length + 4).toString('utf8')) as VaultIpcRequest;
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
