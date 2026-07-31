import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __testing,
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
  }, 15_000);

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
    expect(() => store.read({ purpose: 'api-key', reference: 'request-envelope' })).toThrow(
      'Vault IPC response is malformed.',
    );
  });

  it('uses a no-op reference manifest for vault-backed lifecycle rows', () => {
    const manifest = new NoopSyncSecretReferenceManifest();
    const reference = { purpose: 'api-key', reference: 'one' };

    manifest.add(reference);
    manifest.remove(reference);

    expect(manifest.read()).toEqual([]);
  });

  it('validates worker errors and daemon response envelopes', () => {
    expect(
      __testing.errorFromWorker(Buffer.from(JSON.stringify({ code: 'vault_locked', message: 'locked' }))),
    ).toMatchObject({ message: 'locked', secureStorageCode: 'vault_locked' });
    expect(__testing.errorFromWorker(Buffer.from('{'))).toMatchObject({
      secureStorageCode: 'secure_storage_io_error',
    });
    expect(__testing.errorFromWorker(Buffer.from(JSON.stringify({ code: 1, message: 'bad' })))).toMatchObject({
      secureStorageCode: 'secure_storage_io_error',
    });
    expect(__testing.responseResult({ id: 'one', ok: true, result: { value: 1 }, version: 1 })).toEqual({ value: 1 });
    expect(() =>
      __testing.responseResult({
        error: { code: 'unknown', message: 'failed' },
        id: 'one',
        ok: false,
        version: 1,
      }),
    ).toThrow('failed');
  });

  it('maps every supported secret purpose and stable storage error code', () => {
    const purposes = new Map([
      ['aep-credential', 'aep_credential'],
      ['api-key', 'inflow_api_key'],
      ['auth-access-token', 'auth_access_token'],
      ['auth-refresh-token', 'auth_refresh_token'],
      ['pending-device-code', 'pending_device_code'],
    ]);
    for (const [purpose, kind] of purposes) {
      const reference = { purpose, reference: 'one' };
      expect(__testing.kindForReference(reference)).toBe(kind);
      expect(__testing.vaultReferenceFor(reference)).toMatch(/^vlt_[0-9a-f]{32}$/u);
    }
    const codes = [
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
    for (const code of codes) expect(__testing.codeFromResponse(code)).toBe(code);
    expect(__testing.codeFromResponse('unknown')).toBe('secure_storage_io_error');
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
const store = new SyncVaultSecretStore({ rootDirectory, timeoutMs: 5000 });
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
function transform(value, attachments, decode) {
  if (decode && value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === 1 && Number.isSafeInteger(value.$inflowVaultAttachment)) {
    return attachments[value.$inflowVaultAttachment];
  }
  if (!decode && value instanceof Uint8Array) {
    const index = attachments.push(value) - 1;
    return { $inflowVaultAttachment: index };
  }
  if (Array.isArray(value)) return value.map((item) => transform(item, attachments, decode));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    transform(item, attachments, decode)
  ]));
}
function decodeFrame(buffer) {
  const jsonLength = buffer.readUInt32BE(4);
  const attachmentCount = buffer.readUInt32BE(8);
  const jsonEnd = 12 + jsonLength;
  const attachments = [];
  let offset = jsonEnd;
  for (let index = 0; index < attachmentCount; index += 1) {
    const length = buffer.readUInt32BE(offset);
    offset += 4;
    attachments.push(Buffer.from(buffer.subarray(offset, offset + length)));
    offset += length;
  }
  return transform(JSON.parse(buffer.subarray(12, jsonEnd).toString('utf8')), attachments, true);
}
function encodeFrame(message) {
  const attachments = [];
  const json = Buffer.from(JSON.stringify(transform(message, attachments, false)), 'utf8');
  const bodyLength = 8 + json.byteLength +
    attachments.reduce((total, attachment) => total + 4 + attachment.byteLength, 0);
  const frame = Buffer.alloc(4 + bodyLength);
  frame.writeUInt32BE(bodyLength, 0);
  frame.writeUInt32BE(json.byteLength, 4);
  frame.writeUInt32BE(attachments.length, 8);
  json.copy(frame, 12);
  let offset = 12 + json.byteLength;
  for (const attachment of attachments) {
    frame.writeUInt32BE(attachment.byteLength, offset);
    offset += 4;
    Buffer.from(attachment).copy(frame, offset);
    offset += attachment.byteLength;
  }
  return frame;
}
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
    const request = decodeFrame(buffer.subarray(0, length + 4));
    const params = request.params;
    let response;
    if (request.method === 'secret.put') {
      values.set(params.reference, params.payload);
      response = { id: request.id, ok: true, result: { reference: params.reference }, version: 1 };
    } else if (request.method === 'secret.get') {
      if (params.reference === 'vlt_d4085c4a6f3f1e80d9a4294530f6ec20') {
        socket.end(encodeFrame({ id: request.id, method: 'vault.status', params: {}, version: 1 }));
        return;
      }
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
    socket.end(encodeFrame(response));
  });
});
server.listen(socketPath, () => {
  process.stdout.write('ready\\n');
});
`;
}
