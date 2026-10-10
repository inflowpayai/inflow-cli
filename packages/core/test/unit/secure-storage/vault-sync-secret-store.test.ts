import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { LocalVaultClient } from '../../../src/secure-storage/vault-client.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __testing,
  NoopSyncSecretReferenceManifest,
  SyncVaultSecretStore,
} from '../../../src/secure-storage/vault-sync-secret-store.js';

describe('SyncVaultSecretStore', () => {
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let tmpDir: string;
  const stores: SyncVaultSecretStore[] = [];
  function store(options: ConstructorParameters<typeof SyncVaultSecretStore>[0]): SyncVaultSecretStore {
    const value = new SyncVaultSecretStore(options);
    stores.push(value);
    return value;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'inflow-sync-vault-store-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const value of stores.splice(0)) value.dispose();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    child = undefined;
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it('uses exact references over a separate vault socket process', async () => {
    child = await startVaultSocketFixture(join(tmpDir, 'run', 'vault.sock'));
    const client = store({ rootDirectory: tmpDir });
    const references = [
      { purpose: 'aep-credential', reference: 'stored-aep-credential' },
      { purpose: 'api-key', reference: 'stored-api-key' },
      { purpose: 'auth-access-token', reference: 'stored-access-token' },
      { purpose: 'auth-refresh-token', reference: 'stored-refresh-token' },
      { purpose: 'pending-device-code', reference: 'stored-device-code' },
    ];

    for (const reference of references) {
      client.create(reference, Buffer.from(`secret-${reference.purpose}`));
      expect(Buffer.from(client.read(reference)).toString('utf8')).toBe(`secret-${reference.purpose}`);
    }

    const reference = references[1];
    if (reference === undefined) throw new Error('expected reference');
    client.delete(reference);
    expect(() => client.read(reference)).toThrow('missing');
    expect(JSON.parse(readFileSync(join(tmpDir, 'run', 'vault.sock.counts'), 'utf8'))).toMatchObject({
      connections: 1,
    });
  });

  it('checks compatibility on its own connection before secrets, and snapshots the expected identity', async () => {
    child = await startVaultSocketFixture(join(tmpDir, 'run', 'vault.sock'));
    const expected = { buildId: 'test-build', cliVersion: 'test-version', executablePath: process.execPath };
    const client = store({ rootDirectory: tmpDir, expectedDaemon: expected });
    expected.buildId = 'mutated';
    const reference = { purpose: 'api-key', reference: 'one' };
    client.create(reference, Buffer.from('value'));
    expect(Buffer.from(client.read(reference)).toString()).toBe('value');
    const evidence: unknown = JSON.parse(readFileSync(join(tmpDir, 'run', 'vault.sock.counts'), 'utf8'));
    expect(evidence).toEqual({ connections: 1, methods: ['daemon.info', 'secret.put', 'secret.get'] });
    for (const override of [{ buildId: 'wrong' }, { cliVersion: 'wrong' }, { executablePath: '/wrong/executable' }]) {
      const incompatible = store({
        rootDirectory: tmpDir,
        expectedDaemon: { ...expected, buildId: 'test-build', ...override },
      });
      expect(() => incompatible.create(reference, Buffer.from('not-written'))).toThrow('incompatible');
    }
    expect(Buffer.from(client.read(reference)).toString()).toBe('value');
  });

  it('rejects invalid responses and reconnects only for a later distinct request', async () => {
    child = await startVaultSocketFixture(join(tmpDir, 'run', 'vault.sock'));
    const client = store({ rootDirectory: tmpDir, timeoutMs: 5000 });
    const reference = { purpose: 'api-key', reference: 'good' };
    client.create(reference, Buffer.from('value'));
    for (const name of ['wrong-id', 'oversized', 'surplus', 'truncated', 'disconnect', 'stall']) {
      expect(() => client.read({ purpose: 'api-key', reference: name })).toThrow();
      expect(Buffer.from(client.read(reference)).toString()).toBe('value');
    }
    expect(() =>
      client.create({ purpose: 'api-key', reference: 'put-disconnect' }, Buffer.from('ambiguous')),
    ).toThrow();
    expect(readFileSync(join(tmpDir, 'run', 'vault.sock.counts'), 'utf8').match(/"secret.put"/gu)).toHaveLength(2);
    client.dispose();
    client.dispose();
    expect(() => client.read(reference)).toThrow('disposed');
  }, 15_000);

  it('rejects invalid timeouts and oversized input without mutating caller-owned bytes', async () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new SyncVaultSecretStore({ timeoutMs })).toThrow('positive');
    }
    child = await startVaultSocketFixture(join(tmpDir, 'run', 'vault.sock'));
    const client = store({ rootDirectory: tmpDir });
    const input = Buffer.alloc(1024 * 1024, 1);
    expect(() => client.create({ purpose: 'api-key', reference: 'large' }, input)).toThrow('too large');
    expect(input.equals(Buffer.alloc(input.length, 1))).toBe(true);
    const value = Buffer.from('owned');
    client.create({ purpose: 'api-key', reference: 'small' }, value);
    expect(value.toString()).toBe('owned');
  });

  it('bounds a worker crash while the main event loop cannot deliver worker exit events', async () => {
    child = await startVaultSocketFixture(join(tmpDir, 'run', 'vault.sock'));
    const client = store({ rootDirectory: tmpDir, timeoutMs: 5000 });
    const send = vi.spyOn(Worker.prototype, 'postMessage').mockImplementationOnce(function (this: Worker) {
      void this.terminate();
    });
    expect(() => client.read({ purpose: 'api-key', reference: 'crashed' })).toThrow('did not respond');
    send.mockRestore();
    client.create({ purpose: 'api-key', reference: 'next' }, Buffer.from('next'));
    expect(Buffer.from(client.read({ purpose: 'api-key', reference: 'next' })).toString()).toBe('next');
  }, 15_000);

  it('does not dispatch after the request deadline expires during preparation', () => {
    const client = store({ rootDirectory: tmpDir, timeoutMs: 1 });
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(10);
    const send = vi.spyOn(Worker.prototype, 'postMessage');
    expect(() => client.read({ purpose: 'api-key', reference: 'late' })).toThrow('did not respond');
    expect(send).not.toHaveBeenCalled();
  });

  it('validates shared response bounds and clears request-owned buffers on worker failure', () => {
    for (const [status, length] of [
      [1, -1],
      [1, 2 * 1024 * 1024],
      [7, 0],
    ]) {
      const client = store({ rootDirectory: tmpDir });
      let input: Uint8Array | undefined;
      let output: Uint8Array | undefined;
      const send = vi.spyOn(Worker.prototype, 'postMessage').mockImplementationOnce((message: unknown) => {
        if (
          typeof message !== 'object' ||
          message === null ||
          !('shared' in message) ||
          !('input' in message) ||
          !(message.shared instanceof SharedArrayBuffer) ||
          !(message.input instanceof SharedArrayBuffer)
        ) {
          throw new Error('Expected owned shared buffers');
        }
        input = new Uint8Array(message.input);
        output = new Uint8Array(message.shared, 8);
        output.fill(42);
        const state = new Int32Array(message.shared, 0, 2);
        Atomics.store(state, 1, length ?? 0);
        Atomics.store(state, 0, status ?? 0);
      });
      expect(() => client.create({ purpose: 'api-key', reference: 'bounds' }, Buffer.from('owned'))).toThrow(
        'malformed',
      );
      expect(input?.every((byte) => byte === 0)).toBe(true);
      expect(output?.every((byte) => byte === 0)).toBe(true);
      send.mockRestore();
    }
  });

  it('keeps a late timed-out response separate from a later request', async () => {
    const socketPath = join(tmpDir, 'run', 'vault.sock');
    child = await startVaultSocketFixture(socketPath);
    const client = store({ rootDirectory: tmpDir, timeoutMs: 5000 });
    expect(() => client.read({ purpose: 'api-key', reference: 'late' })).toThrow('did not respond');
    expect(JSON.parse(readFileSync(socketPath + '.counts', 'utf8'))).toEqual({
      connections: 1,
      methods: ['secret.get'],
    });
    const reference = { purpose: 'api-key', reference: 'next' };
    client.create(reference, Buffer.from('next-value'));
    writeFileSync(socketPath + '.release-late', 'release');
    await vi.waitFor(() => expect(readFileSync(socketPath + '.late-attempted', 'utf8')).toBe('attempted'), {
      timeout: 5000,
    });
    expect(Buffer.from(client.read(reference)).toString()).toBe('next-value');
    expect(JSON.parse(readFileSync(socketPath + '.counts', 'utf8'))).toEqual({
      connections: 2,
      methods: ['secret.get', 'secret.put', 'secret.get'],
    });
  }, 20_000);

  it('rechecks compatibility after the daemon is replaced', async () => {
    const path = join(tmpDir, 'run', 'vault.sock');
    child = await startVaultSocketFixture(path);
    const client = store({
      rootDirectory: tmpDir,
      expectedDaemon: { buildId: 'test-build', cliVersion: 'test-version', executablePath: process.execPath },
    });
    client.create({ purpose: 'api-key', reference: 'before' }, Buffer.from('value'));
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    child = await startVaultSocketFixture(
      path,
      fixtureSource().replace("buildId: 'test-build'", "buildId: 'replacement'"),
    );
    expect(() => client.create({ purpose: 'api-key', reference: 'after' }, Buffer.from('not sent'))).toThrow(
      'incompatible',
    );
    expect(JSON.parse(readFileSync(path + '.counts', 'utf8'))).toEqual({ connections: 1, methods: ['daemon.info'] });
  });

  it('handles fragmented responses and preserves peer refusal errors before a request identifier is known', async () => {
    child = await startVaultSocketFixture(join(tmpDir, 'run', 'vault.sock'));
    const client = store({ rootDirectory: tmpDir });
    expect(() => client.read({ purpose: 'api-key', reference: 'fragmented' })).toThrow('locked');
    expect(() => client.read({ purpose: 'api-key', reference: 'peer-refused' })).toThrow(
      'Vault peer verification failed.',
    );
  });

  it('uses the real daemon while the main thread is blocked and enforces a lock from another connection', async () => {
    child = await startVaultSocketFixture(
      tmpDir,
      `
      const { startLocalVaultDaemon } = await import('./dist/index.js');
      const daemon = await startLocalVaultDaemon({ rootDirectory: process.argv[1], buildId: 'real', cliVersion: 'test' });
      process.once('SIGTERM', async () => { await daemon.close(); process.exit(0); });
      process.stdout.write('ready\\n');
    `,
    );
    const control = new LocalVaultClient({ rootDirectory: tmpDir });
    const client = store({
      rootDirectory: tmpDir,
      expectedDaemon: { buildId: 'real', cliVersion: 'test', executablePath: process.execPath },
    });
    try {
      await control.unlock(Buffer.from('isolated-test-passphrase'));
      const reference = { purpose: 'api-key', reference: 'real' };
      client.create(reference, Buffer.from('value'));
      const pendingStatus = control.status();
      expect(Buffer.from(client.read(reference)).toString()).toBe('value');
      await expect(pendingStatus).resolves.toMatchObject({ lockState: 'unlocked' });
      await control.lock();
      expect(() => client.read(reference)).toThrow('locked');
      await control.unlock(Buffer.from('isolated-test-passphrase'));
      expect(Buffer.from(client.read(reference)).toString()).toBe('value');
      client.delete(reference);
      expect(() => client.read(reference)).toThrow();
    } finally {
      control.dispose();
    }
  }, 15_000);

  it('works when loaded from the built ESM package', async () => {
    child = await startVaultSocketFixture(join(tmpDir, 'run', 'vault.sock'));

    const result = await runNodeProcess(['--input-type=module', '-e', esmProbeSource(), tmpDir]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('secret-esm\n');
  }, 15_000);

  it('fails closed for unsupported purposes, malformed payloads, and unavailable daemons', async () => {
    const client = store({ rootDirectory: tmpDir, timeoutMs: 1000 });
    expect(() => client.create({ purpose: 'manifest', reference: 'one' }, Buffer.from('x'))).toThrow(
      'Secret reference purpose is not vault-backed.',
    );
    expect(() => client.read({ purpose: 'api-key', reference: 'missing-daemon' })).toThrow(
      'The InFlow vault daemon is unavailable.',
    );

    child = await startVaultSocketFixture(join(tmpDir, 'run', 'vault.sock'));
    expect(() => client.read({ purpose: 'api-key', reference: 'malformed-payload' })).toThrow(
      'Vault IPC secret response is malformed.',
    );
    expect(() => client.read({ purpose: 'api-key', reference: 'request-envelope' })).toThrow(
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

async function startVaultSocketFixture(
  socketPath: string,
  source = fixtureSource(),
): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, socketPath], {
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
const { mkdirSync, rmSync, unwatchFile, watchFile, writeFileSync } = await import('node:fs');
const { createHash } = await import('node:crypto');
const { dirname } = await import('node:path');
const net = await import('node:net');
const socketPath = process.argv[1];
const values = new Map();
const counts = { connections: 0, methods: [] };
function reference(name) {
  return 'vlt_' + createHash('sha256').update('api-key\\0' + name).digest('hex').slice(0, 32);
}
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
  counts.connections++;
  socket.on('error', () => {});
  const chunks = [];
  socket.on('data', (chunk) => {
    chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    if (buffer.byteLength < 4) return;
    const length = buffer.readUInt32BE(0);
    if (buffer.byteLength < length + 4) return;
    const request = decodeFrame(buffer.subarray(0, length + 4));
    chunks.length = 0;
    const params = request.params;
    counts.methods.push(request.method);
    writeFileSync(socketPath + '.counts', JSON.stringify(counts));
    let response;
    if (request.method === 'daemon.info') {
      response = { id: request.id, ok: true, result: { buildId: 'test-build', cliVersion: 'test-version', executablePath: process.execPath, pid: process.pid }, version: 1 };
    } else if (params.reference === reference('fragmented')) {
      const frame = encodeFrame({ id: request.id, ok: false, error: { code: 'vault_locked', message: 'locked' }, version: 1 });
      socket.write(frame.subarray(0, 2));
      setTimeout(() => socket.write(frame.subarray(2, 6)), 10);
      setTimeout(() => socket.write(frame.subarray(6)), 20); return;
    } else if (params.reference === reference('peer-refused')) {
      socket.end(encodeFrame({ id: 'unknown', ok: false, error: { code: 'secure_storage_peer_verification_failed', message: 'Vault peer verification failed.' }, version: 1 })); return;
    } else if (params.reference === reference('late')) {
      const releasePath = socketPath + '.release-late';
      watchFile(releasePath, { interval: 20 }, (stat) => {
        if (stat.size === 0) return;
        unwatchFile(releasePath);
        socket.write(encodeFrame({ id: request.id, ok: true, result: { payload: Buffer.from('late-value') }, version: 1 }));
        writeFileSync(socketPath + '.late-attempted', 'attempted');
      });
      return;
    } else if (params.reference === reference('stall')) {
      return;
    } else if (params.reference === reference('disconnect') || params.reference === reference('put-disconnect')) {
      socket.destroy(); return;
    } else if (params.reference === reference('oversized')) {
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(2 * 1024 * 1024);
      socket.write(prefix); return;
    } else if (params.reference === reference('truncated')) {
      socket.end(Buffer.from([0, 0, 0, 50, 0])); return;
    } else if (params.reference === reference('surplus')) {
      const frame = encodeFrame({ id: request.id, ok: true, result: {}, version: 1 });
      socket.write(Buffer.concat([frame, frame])); return;
    } else if (params.reference === reference('wrong-id')) {
      response = { id: 'wrong', ok: true, result: {}, version: 1 };
    } else if (request.method === 'secret.put') {
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
    socket.write(encodeFrame(response));
  });
});
server.listen(socketPath, () => {
  process.stdout.write('ready\\n');
});
`;
}
