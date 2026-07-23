import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NoopSyncSecretReferenceManifest,
  SyncVaultSecretStore,
} from '../../../src/secure-storage/vault-sync-secret-store.js';

describe('SyncVaultSecretStore', () => {
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-sync-vault-store-'));
  });

  afterEach(() => {
    child?.kill();
    child = undefined;
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it('uses exact references over a separate vault socket process', async () => {
    child = await startVaultSocketFixture(join(tmpDir, 'run', 'vault.sock'));
    const store = new SyncVaultSecretStore({ rootDirectory: tmpDir });
    const references = [
      { purpose: 'aep-credential', reference: 'stored-aep-credential' },
      { purpose: 'api-key', reference: 'stored-api-key' },
      { purpose: 'auth-access-token', reference: 'stored-access-token' },
      { purpose: 'auth-refresh-token', reference: 'stored-refresh-token' },
      { purpose: 'pending-device-code', reference: 'stored-device-code' },
    ];

    for (const reference of references) {
      store.create(reference, Buffer.from(`secret-${reference.purpose}`));
      expect(Buffer.from(store.read(reference)).toString('utf8')).toBe(`secret-${reference.purpose}`);
    }

    const reference = references[1];
    if (reference === undefined) throw new Error('expected reference');
    store.delete(reference);
    expect(() => store.read(reference)).toThrow('missing');
  });

  it('works when loaded from the built ESM package', async () => {
    child = await startVaultSocketFixture(join(tmpDir, 'run', 'vault.sock'));

    const result = await runNodeProcess(['--input-type=module', '-e', esmProbeSource(), tmpDir]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('secret-esm\n');
  });

  it('fails closed for unsupported purposes, malformed payloads, and unavailable daemons', async () => {
    const store = new SyncVaultSecretStore({ rootDirectory: tmpDir, timeoutMs: 250 });
    expect(() => store.create({ purpose: 'manifest', reference: 'one' }, Buffer.from('x'))).toThrow(
      'Secret reference purpose is not vault-backed.',
    );
    expect(() => store.read({ purpose: 'api-key', reference: 'missing-daemon' })).toThrow(
      'The InFlow vault daemon is unavailable.',
    );

    child = await startVaultSocketFixture(join(tmpDir, 'run', 'vault.sock'));
    expect(() => store.read({ purpose: 'api-key', reference: 'malformed-payload' })).toThrow(
      'Vault IPC secret response is malformed.',
    );
  });

  it('uses a no-op reference manifest for vault-backed lifecycle rows', () => {
    const manifest = new NoopSyncSecretReferenceManifest();
    const reference = { purpose: 'api-key', reference: 'one' };

    manifest.add(reference);
    manifest.remove(reference);

    expect(manifest.read()).toEqual([]);
  });
});

async function startVaultSocketFixture(socketPath: string): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  const child = spawn(process.execPath, ['-e', fixtureSource(), socketPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`fixture socket did not start: ${stderr}`));
    }, 5_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('ready')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('error', (cause) => {
      clearTimeout(timeout);
      reject(cause);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`fixture socket exited ${code}: ${stderr}`));
    });
  });
  return child;
}

async function runNodeProcess(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const probe = spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  probe.stdout.on('data', (chunk: Buffer) => {
    stdout.push(chunk);
  });
  probe.stderr.on('data', (chunk: Buffer) => {
    stderr.push(chunk);
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    probe.once('error', reject);
    probe.once('exit', resolve);
  });
  return {
    status,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

function esmProbeSource(): string {
  return `
import { Buffer } from 'node:buffer';
import { SyncVaultSecretStore } from './dist/index.js';
const rootDirectory = process.argv[1];
const store = new SyncVaultSecretStore({ rootDirectory, timeoutMs: 1000 });
const reference = { purpose: 'api-key', reference: 'esm-api-key' };
store.create(reference, Buffer.from('secret-esm', 'utf8'));
process.stdout.write(Buffer.from(store.read(reference)).toString('utf8') + '\\n');
store.delete(reference);
`;
}

function fixtureSource(): string {
  return `
const { mkdirSync, rmSync } = require('node:fs');
const { dirname } = require('node:path');
const net = require('node:net');
const socketPath = process.argv[1];
const values = new Map();
mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
rmSync(socketPath, { force: true });
const server = net.createServer((socket) => {
  const chunks = [];
  socket.on('data', (chunk) => {
    chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    if (buffer.byteLength < 4) return;
    const length = buffer.readUInt32BE(0);
    if (buffer.byteLength < length + 4) return;
    const request = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
    const params = request.params;
    let response;
    if (request.method === 'secret.put') {
      values.set(params.reference, params.payload);
      response = { id: request.id, ok: true, result: { reference: params.reference }, version: 1 };
    } else if (request.method === 'secret.get') {
      if (params.reference === 'vlt_49f4c397821a81dab9433f0f7a56565e') {
        response = { id: request.id, ok: true, result: { payload: 1, reference: params.reference }, version: 1 };
      } else {
      const payload = values.get(params.reference);
      response = payload === undefined
        ? { id: request.id, ok: false, error: { code: 'secure_storage_secret_missing', message: 'missing' }, version: 1 }
        : { id: request.id, ok: true, result: { payload, reference: params.reference }, version: 1 };
      }
    } else if (request.method === 'secret.delete') {
      values.delete(params.reference);
      response = { id: request.id, ok: true, result: {}, version: 1 };
    } else {
      response = { id: request.id, ok: false, error: { code: 'secure_storage_invalid_path', message: 'bad method' }, version: 1 };
    }
    const body = Buffer.from(JSON.stringify(response), 'utf8');
    const frame = Buffer.alloc(4 + body.byteLength);
    frame.writeUInt32BE(body.byteLength, 0);
    body.copy(frame, 4);
    socket.end(frame);
  });
});
server.listen(socketPath, () => {
  process.stdout.write('ready\\n');
});
`;
}
