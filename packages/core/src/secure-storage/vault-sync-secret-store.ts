import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { SecureStorageError, type SecureStorageErrorCode } from './errors.js';
import type { SecretReference, SyncSecureSecretStore } from './secret-store.js';
import { decodeVaultIpcFrame, VAULT_IPC_MAX_MESSAGE_BYTES, type VaultIpcRequest } from './vault-ipc.js';
import { vaultFilePaths } from './vault-files.js';
import type { VaultSecretKind } from './vault-types.js';

export interface SyncVaultSecretStoreOptions {
  rootDirectory?: string;
  timeoutMs?: number;
}

const SHARED_HEADER_INTS = 2;
const SHARED_HEADER_BYTES = SHARED_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
const DEFAULT_TIMEOUT_MS = 10_000;

export class SyncVaultSecretStore implements SyncSecureSecretStore {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(options: SyncVaultSecretStoreOptions = {}) {
    this.socketPath = vaultFilePaths(options.rootDirectory).socket;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  create(reference: SecretReference, value: Uint8Array): void {
    this.request('secret.put', {
      expectedKind: kindForReference(reference),
      payload: Buffer.from(value).toString('base64'),
      reference: vaultReferenceFor(reference),
    });
  }

  delete(reference: SecretReference): void {
    this.request('secret.delete', {
      expectedKind: kindForReference(reference),
      reference: vaultReferenceFor(reference),
    });
  }

  read(reference: SecretReference): Uint8Array {
    const result = this.request('secret.get', {
      expectedKind: kindForReference(reference),
      reference: vaultReferenceFor(reference),
    });
    const payload = result['payload'];
    if (typeof payload !== 'string') {
      throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC secret response is malformed.');
    }
    return Buffer.from(payload, 'base64');
  }

  private request(method: VaultIpcRequest['method'], params: Record<string, unknown>): Record<string, unknown> {
    const request: VaultIpcRequest = {
      id: `req_${randomUUID().replaceAll('-', '')}`,
      method,
      params,
      version: 1,
    };
    const shared = new SharedArrayBuffer(SHARED_HEADER_BYTES + VAULT_IPC_MAX_MESSAGE_BYTES + 4);
    const state = new Int32Array(shared, 0, SHARED_HEADER_INTS);
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        request,
        shared,
        socketPath: this.socketPath,
      },
    });
    worker.unref();
    const waitResult = Atomics.wait(state, 0, 0, this.timeoutMs);
    if (waitResult === 'timed-out') {
      void worker.terminate();
      throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault daemon did not respond.');
    }
    const status = Atomics.load(state, 0);
    const length = Atomics.load(state, 1);
    const bytes = new Uint8Array(shared, SHARED_HEADER_BYTES, length);
    if (status === 2) {
      throw errorFromWorker(bytes);
    }
    if (status !== 1) {
      throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC worker response is malformed.');
    }
    const response = decodeVaultIpcFrame(bytes);
    if ('method' in response) {
      throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC response is malformed.');
    }
    if (!response.ok) {
      throw new SecureStorageError(codeFromResponse(response.error.code), response.error.message);
    }
    return response.result;
  }
}

export class NoopSyncSecretReferenceManifest {
  add(_reference: SecretReference): void {}

  read(): SecretReference[] {
    return [];
  }

  remove(_reference: SecretReference): void {}
}

function kindForReference(reference: SecretReference): VaultSecretKind {
  switch (reference.purpose) {
    case 'aep-credential':
      return 'aep_credential';
    case 'api-key':
      return 'inflow_api_key';
    case 'auth-access-token':
      return 'auth_access_token';
    case 'auth-refresh-token':
      return 'auth_refresh_token';
    case 'pending-device-code':
      return 'pending_device_code';
    default:
      throw new SecureStorageError('secure_storage_invalid_path', 'Secret reference purpose is not vault-backed.');
  }
}

function vaultReferenceFor(reference: SecretReference): string {
  const digest = createHash('sha256').update(reference.purpose).update('\0').update(reference.reference).digest('hex');
  return `vlt_${digest.slice(0, 32)}`;
}

function errorFromWorker(bytes: Uint8Array): SecureStorageError {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'code' in parsed &&
      'message' in parsed &&
      typeof parsed.code === 'string' &&
      typeof parsed.message === 'string'
    ) {
      return new SecureStorageError(codeFromResponse(parsed.code), parsed.message);
    }
  } catch {
    return new SecureStorageError('secure_storage_io_error', 'The InFlow vault operation failed.');
  }
  return new SecureStorageError('secure_storage_io_error', 'The InFlow vault operation failed.');
}

function codeFromResponse(code: string): SecureStorageErrorCode {
  switch (code) {
    case 'secure_storage_corrupt':
    case 'secure_storage_invalid_path':
    case 'secure_storage_io_error':
    case 'secure_storage_secret_conflict':
    case 'secure_storage_secret_missing':
    case 'secure_storage_unavailable':
    case 'vault_daemon_busy':
    case 'vault_locked':
    case 'vault_not_initialized':
      return code;
    default:
      return 'secure_storage_io_error';
  }
}

const WORKER_SOURCE = `
let catchState;
let catchOutput;
function finishFromCatch() {
  if (catchState === undefined || catchOutput === undefined) return;
  const bytes = new TextEncoder().encode(JSON.stringify({
    code: 'secure_storage_io_error',
    message: 'The InFlow vault operation failed.'
  }));
  catchOutput.set(bytes, 0);
  Atomics.store(catchState, 1, bytes.byteLength);
  Atomics.store(catchState, 0, 2);
  Atomics.notify(catchState, 0, 1);
}
(async () => {
const { Buffer } = await import('node:buffer');
const net = await import('node:net');
const { workerData } = await import('node:worker_threads');

const HEADER_BYTES = ${SHARED_HEADER_BYTES};
const MAX_BYTES = ${VAULT_IPC_MAX_MESSAGE_BYTES + 4};
const state = new Int32Array(workerData.shared, 0, ${SHARED_HEADER_INTS});
const output = new Uint8Array(workerData.shared, HEADER_BYTES);
catchState = state;
catchOutput = output;

function finish(status, bytes) {
  const payload = Buffer.from(bytes);
  if (payload.byteLength > output.byteLength) {
    return finish(2, Buffer.from(JSON.stringify({
      code: 'secure_storage_invalid_path',
      message: 'Vault IPC message is too large.'
    }), 'utf8'));
  }
  output.set(payload, 0);
  Atomics.store(state, 1, payload.byteLength);
  Atomics.store(state, 0, status);
  Atomics.notify(state, 0, 1);
}

function fail(code, message) {
  finish(2, Buffer.from(JSON.stringify({ code, message }), 'utf8'));
}

const body = Buffer.from(JSON.stringify(workerData.request), 'utf8');
if (body.byteLength > ${VAULT_IPC_MAX_MESSAGE_BYTES}) {
  fail('secure_storage_invalid_path', 'Vault IPC message is too large.');
} else {
  const frame = Buffer.alloc(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  const socket = net.createConnection(workerData.socketPath);
  const chunks = [];
  let total = 0;
  let settled = false;
  function settle(status, bytes) {
    if (settled) return;
    settled = true;
    socket.destroy();
    finish(status, bytes);
  }
  function tryResolve() {
    const buffer = Buffer.concat(chunks);
    if (buffer.byteLength < 4) return;
    const length = buffer.readUInt32BE(0);
    if (length > ${VAULT_IPC_MAX_MESSAGE_BYTES}) {
      settle(2, Buffer.from(JSON.stringify({
        code: 'secure_storage_invalid_path',
        message: 'Vault IPC message is too large.'
      }), 'utf8'));
      return;
    }
    if (buffer.byteLength >= length + 4) {
      settle(1, buffer.subarray(0, length + 4));
    }
  }
  socket.on('connect', () => {
    socket.write(frame);
  });
  socket.on('data', (chunk) => {
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total > MAX_BYTES) {
      fail('secure_storage_invalid_path', 'Vault IPC message is too large.');
      socket.destroy();
      return;
    }
    tryResolve();
  });
  socket.on('error', () => {
    fail('secure_storage_unavailable', 'The InFlow vault daemon is unavailable.');
  });
  socket.on('end', () => {
    tryResolve();
    fail('secure_storage_corrupt', 'Vault IPC frame is truncated.');
  });
}
})().catch(() => {
  finishFromCatch();
});
`;
