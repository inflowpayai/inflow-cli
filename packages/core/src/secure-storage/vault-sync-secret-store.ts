import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { Worker } from 'node:worker_threads';
import { SecureStorageError, type SecureStorageErrorCode } from './errors.js';
import type { SecretReference, SyncSecureSecretStore } from './secret-store.js';
import { LINUX_VAULT_BROKER_PUBLIC_KEY } from './vault-broker-auth.js';
import {
  clearVaultIpcBytes,
  decodeVaultIpcFrame,
  encodeVaultIpcMessage,
  VAULT_IPC_MAX_MESSAGE_BYTES,
  type VaultIpcRequest,
  type VaultIpcResponse,
} from './vault-ipc.js';
import { linuxVaultServiceUserId, usesLinuxVaultService, vaultFilePaths } from './vault-files.js';
import {
  createVaultPeerVerificationConfig,
  shouldRequireVaultPeerVerification,
  verifyVaultPeerVerificationConfig,
  type VaultPeerVerificationConfig,
} from './vault-peer-verifier.js';
import type { VaultSecretKind } from './vault-types.js';
import { WindowsVaultConnection } from './vault-windows-transport.js';
import type { LocalVaultDaemonInfo } from './vault-client.js';

export interface SyncVaultSecretStoreOptions {
  rootDirectory?: string;
  timeoutMs?: number;
  expectedDaemon?: Omit<LocalVaultDaemonInfo, 'pid'>;
}

const SHARED_HEADER_INTS = 2;
const SHARED_HEADER_BYTES = SHARED_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
const DEFAULT_TIMEOUT_MS = 10_000;

export class SyncVaultSecretStore implements SyncSecureSecretStore {
  private readonly rootDirectory: string | undefined;
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly expectedDaemon: Omit<LocalVaultDaemonInfo, 'pid'> | undefined;
  private session: { worker: Worker; closed: Int32Array; checked: boolean } | undefined;
  private disposed = false;
  private windowsConnection: WindowsVaultConnection | undefined;

  constructor(options: SyncVaultSecretStoreOptions = {}) {
    this.rootDirectory = options.rootDirectory;
    this.socketPath = vaultFilePaths(options.rootDirectory).socket;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.expectedDaemon = options.expectedDaemon === undefined ? undefined : { ...options.expectedDaemon };
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new SecureStorageError('secure_storage_invalid_path', 'Vault request timeout must be positive.');
    }
  }

  dispose(): void {
    this.disposed = true;
    this.retire();
    this.windowsConnection?.dispose();
  }

  private retire(): void {
    const session = this.session;
    this.session = undefined;
    if (session !== undefined) {
      Atomics.store(session.closed, 0, 1);
      void session.worker.terminate();
    }
  }

  create(reference: SecretReference, value: Uint8Array): void {
    clearVaultIpcBytes(
      this.request('secret.put', {
        expectedKind: kindForReference(reference),
        payload: value,
        reference: vaultReferenceFor(reference),
      }),
    );
  }

  delete(reference: SecretReference): void {
    clearVaultIpcBytes(
      this.request('secret.delete', {
        expectedKind: kindForReference(reference),
        reference: vaultReferenceFor(reference),
      }),
    );
  }

  read(reference: SecretReference): Uint8Array {
    const result = this.request('secret.get', {
      expectedKind: kindForReference(reference),
      reference: vaultReferenceFor(reference),
    });
    try {
      const payload = result['payload'];
      if (!(payload instanceof Uint8Array)) {
        throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC secret response is malformed.');
      }
      return Buffer.from(payload);
    } finally {
      clearVaultIpcBytes(result);
    }
  }

  private request(method: VaultIpcRequest['method'], params: Record<string, unknown>): Record<string, unknown> {
    if (this.disposed) {
      throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault secret store is disposed.');
    }
    const request: VaultIpcRequest = {
      id: `req_${randomUUID().replaceAll('-', '')}`,
      method,
      params,
      version: 1,
    };
    if (process.platform === 'win32' && this.rootDirectory === undefined) {
      this.windowsConnection ??= new WindowsVaultConnection(
        this.socketPath,
        this.expectedDaemon === undefined
          ? undefined
          : (info) => {
              const expected = this.expectedDaemon;
              if (
                expected === undefined ||
                info['buildId'] !== expected.buildId ||
                info['cliVersion'] !== expected.cliVersion ||
                typeof info['executablePath'] !== 'string' ||
                !Number.isSafeInteger(info['pid']) ||
                executablePath(info['executablePath']) !== executablePath(expected.executablePath)
              ) {
                throw new SecureStorageError(
                  'secure_storage_unavailable',
                  'The InFlow vault daemon is incompatible with this CLI.',
                );
              }
            },
      );
      return responseResult(this.windowsConnection.request(request));
    }
    const deadline = performance.now() + this.timeoutMs;
    if (this.session !== undefined && Atomics.load(this.session.closed, 0) !== 0) this.retire();
    if (this.session === undefined) {
      const closed = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          closed: closed.buffer,
          peerVerification: createPeerVerification(this.socketPath, this.rootDirectory),
          socketPath: this.socketPath,
        },
      });
      worker.on('error', () => Atomics.store(closed, 0, 1));
      worker.on('exit', () => Atomics.store(closed, 0, 1));
      worker.unref();
      this.session = { worker, closed, checked: false };
    }
    let response: VaultIpcResponse;
    try {
      if (!this.session.checked && this.expectedDaemon !== undefined) {
        const info = responseResult(
          this.exchange({ ...request, id: `${request.id}_info`, method: 'daemon.info', params: {} }, deadline),
        );
        try {
          const expected = this.expectedDaemon;
          if (
            info['buildId'] !== expected.buildId ||
            info['cliVersion'] !== expected.cliVersion ||
            typeof info['executablePath'] !== 'string' ||
            !Number.isSafeInteger(info['pid']) ||
            executablePath(info['executablePath']) !== executablePath(expected.executablePath)
          ) {
            throw new SecureStorageError(
              'secure_storage_unavailable',
              'The InFlow vault daemon is incompatible with this CLI.',
            );
          }
          this.session.checked = true;
        } finally {
          clearVaultIpcBytes(info);
        }
      }
      response = this.exchange(request, deadline);
    } catch (cause) {
      this.retire();
      throw cause;
    }
    return responseResult(response);
  }

  private exchange(request: VaultIpcRequest, deadline: number): VaultIpcResponse {
    const session = this.session;
    if (session === undefined)
      throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault daemon is unavailable.');
    const frame = encodeVaultIpcMessage(request);
    const input = new Uint8Array(new SharedArrayBuffer(frame.byteLength));
    input.set(frame);
    frame.fill(0);
    const shared = new SharedArrayBuffer(SHARED_HEADER_BYTES + VAULT_IPC_MAX_MESSAGE_BYTES + 4);
    const state = new Int32Array(shared, 0, SHARED_HEADER_INTS);
    const output = new Uint8Array(shared, SHARED_HEADER_BYTES);
    try {
      if (performance.now() >= deadline) {
        throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault daemon did not respond.');
      }
      session.worker.ref();
      session.worker.postMessage({ input: input.buffer, shared });
      let status = Atomics.load(state, 0);
      while (status === 0 || status === 3) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          if (Atomics.compareExchange(state, 0, status, 4) !== status) {
            status = Atomics.load(state, 0);
            continue;
          }
          throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault daemon did not respond.');
        }
        Atomics.wait(state, 0, status, remaining);
        status = Atomics.load(state, 0);
      }
      const length = Atomics.load(state, 1);
      if (length < 0 || length > output.byteLength || (status !== 1 && status !== 2)) {
        throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC worker response is malformed.');
      }
      const bytes = output.subarray(0, length);
      if (status === 2) throw errorFromWorker(bytes);
      const response = decodeVaultIpcFrame(bytes);
      if (
        !('method' in response) &&
        !response.ok &&
        response.error.code === 'secure_storage_peer_verification_failed'
      ) {
        throw new SecureStorageError('secure_storage_peer_verification_failed', response.error.message);
      }
      if ('method' in response || response.id !== request.id) {
        clearVaultIpcBytes(response);
        throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC response is malformed.');
      }
      return response;
    } catch (cause) {
      Atomics.store(session.closed, 0, 1);
      void session.worker.terminate().then(() => {
        input.fill(0);
        output.fill(0);
      });
      throw cause;
    } finally {
      input.fill(0);
      output.fill(0);
      session.worker.unref();
    }
  }
}

function executablePath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

function responseResult(response: VaultIpcResponse): Record<string, unknown> {
  if (!response.ok) {
    throw new SecureStorageError(codeFromResponse(response.error.code), response.error.message);
  }
  return response.result;
}

function createPeerVerification(
  socketPath: string,
  rootDirectory: string | undefined,
): (VaultPeerVerificationConfig & { linuxBrokerPublicKeyPath?: string }) | undefined {
  if (!shouldRequireVaultPeerVerification()) return undefined;
  const configuration =
    rootDirectory === undefined && usesLinuxVaultService()
      ? createVaultPeerVerificationConfig({
          expectedUserId: linuxVaultServiceUserId(socketPath),
          requireSameUser: false,
        })
      : createVaultPeerVerificationConfig();
  verifyVaultPeerVerificationConfig(configuration);
  return rootDirectory === undefined && usesLinuxVaultService()
    ? { ...configuration, linuxBrokerPublicKeyPath: LINUX_VAULT_BROKER_PUBLIC_KEY }
    : configuration;
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
    case 'secure_storage_peer_verification_failed':
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

/** @internal */
export const __testing = {
  codeFromResponse,
  errorFromWorker,
  kindForReference,
  responseResult,
  vaultReferenceFor,
};

const WORKER_SOURCE = `
(async () => {
const { Buffer } = await import('node:buffer');
const { createHash, createPublicKey, randomBytes, verify } = await import('node:crypto');
const { execFileSync } = await import('node:child_process');
const { lstatSync, readFileSync, realpathSync } = await import('node:fs');
const { createRequire } = await import('node:module');
const { resolve } = await import('node:path');
const net = await import('node:net');
const { workerData, parentPort } = await import('node:worker_threads');

const HEADER_BYTES = ${SHARED_HEADER_BYTES};
const MAX_BYTES = ${VAULT_IPC_MAX_MESSAGE_BYTES + 4};
const closed = new Int32Array(workerData.closed);
let socket;
let active;
let authenticated = false;
let idleTimer;
let requestTimer;
const prefix = Buffer.alloc(4);
let incoming;
let total = 0;
let response;
let written = false;

function clearIncoming() {
  prefix.fill(0);
  incoming?.fill(0);
  incoming = undefined;
  total = 0;
}

function finish(status, bytes) {
  const job = active;
  active = undefined;
  clearTimeout(requestTimer);
  if (job !== undefined) {
    job.input.fill(0);
    if (Atomics.compareExchange(job.state, 0, 0, 3) === 0) {
      job.output.set(bytes);
      Atomics.store(job.state, 1, bytes.byteLength);
      if (Atomics.compareExchange(job.state, 0, 3, status) !== 3) job.output.fill(0);
      Atomics.notify(job.state, 0);
    }
  }
  bytes.fill(0);
}

function close(code = 'secure_storage_unavailable', message = 'The InFlow vault daemon is unavailable.') {
  Atomics.store(closed, 0, 1);
  clearTimeout(idleTimer);
  clearTimeout(requestTimer);
  socket?.destroy();
  clearIncoming();
  response?.fill(0);
  response = undefined;
  finish(2, Buffer.from(JSON.stringify({ code, message })));
  parentPort.close();
}

function complete() {
  if (!written || response === undefined || active === undefined) return;
  const bytes = response;
  response = undefined;
  socket.unref();
  idleTimer = setTimeout(() => close(), 60_000);
  idleTimer.unref();
  finish(1, bytes);
}

function onData(chunk) {
  try {
    if (active === undefined || response !== undefined) {
      close('secure_storage_corrupt', 'Vault IPC response is unexpected.');
      return;
    }
    let offset = 0;
    if (incoming === undefined) {
      offset = Math.min(4 - total, chunk.byteLength);
      chunk.copy(prefix, total, 0, offset);
      total += offset;
      if (total < 4) return;
      const length = prefix.readUInt32BE(0) + 4;
      if (length < 12 || length > MAX_BYTES) {
        close('secure_storage_corrupt', 'Vault IPC frame length is invalid.');
        return;
      }
      incoming = Buffer.alloc(length);
      prefix.copy(incoming);
      prefix.fill(0);
    }
    if (chunk.byteLength - offset > incoming.byteLength - total) {
      close('secure_storage_corrupt', 'Vault IPC frame length is invalid.');
      return;
    }
    chunk.copy(incoming, total, offset);
    total += chunk.byteLength - offset;
    if (total === incoming.byteLength) {
      response = incoming;
      incoming = undefined;
      total = 0;
      complete();
    }
  } finally {
    chunk.fill(0);
  }
}

async function receive(message) {
  const job = {
    input: new Uint8Array(message.input),
    state: new Int32Array(message.shared, 0, ${SHARED_HEADER_INTS}),
    output: new Uint8Array(message.shared, HEADER_BYTES),
  };
  if (active !== undefined || Atomics.load(closed, 0) !== 0) {
    job.input.fill(0);
    Atomics.compareExchange(job.state, 0, 0, 2);
    Atomics.notify(job.state, 0);
    close();
    return;
  }
  active = job;
  written = false;
  clearTimeout(idleTimer);
  requestTimer = setTimeout(() => close(), 10_000);
  try {
    if (socket === undefined) {
      socket = net.createConnection(workerData.socketPath);
      socket.on('error', () => close());
      socket.on('end', () => close());
      socket.on('close', () => close());
      await new Promise((resolveConnect, rejectConnect) => {
        socket.once('connect', resolveConnect);
        socket.once('error', rejectConnect);
      });
      try {
        await verifyPeer(socket);
      } catch {
        close('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
        return;
      }
      if (Atomics.load(closed, 0) !== 0) return;
      authenticated = true;
      socket.on('data', onData);
    }
    if (!authenticated || Atomics.load(job.state, 0) !== 0 || Atomics.load(closed, 0) !== 0) {
      close();
      return;
    }
    socket.ref();
    socket.write(job.input, (cause) => {
      job.input.fill(0);
      if (cause != null) {
        close();
        return;
      }
      written = true;
      complete();
    });
  } catch {
    close();
  }
}
parentPort.on('message', (message) => { void receive(message); });
async function verifyPeer(socket) {
  const config = workerData.peerVerification;
  if (config === undefined) return;
  const stat = lstatSync(config.nativeModulePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error('unsafe native module');
  if (config.nativeModulePath !== resolve(config.nativeModulePath)) throw new Error('unsafe native module path');
  if (config.expectedNativeModuleSha256 !== undefined) {
    const actual = createHash('sha256').update(readFileSync(config.nativeModulePath)).digest('hex');
    if (actual !== config.expectedNativeModuleSha256) throw new Error('native module digest mismatch');
  }
  const requirement = \`anchor apple generic and certificate leaf[subject.OU] = "\${config.expectedTeamId}"\`;
  if (config.requireSignature) {
    execFileSync('/usr/bin/codesign', [
      '--verify',
      '--strict',
      \`--test-requirement==\${requirement}\`,
      config.nativeModulePath
    ], { stdio: 'ignore' });
  }
  const native = createRequire(process.execPath)(config.nativeModulePath);
  const fd = socket._handle?.fd;
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error('peer descriptor unavailable');
  if (config.linuxBrokerPublicKeyPath !== undefined) {
    const peer = native.peerCredentials(fd);
    if (peer.uid !== config.expectedUserId) throw new Error('peer user mismatch');
    await waitForPath(config.linuxBrokerPublicKeyPath);
    const keyDirectory = resolve(config.linuxBrokerPublicKeyPath, '..');
    const directoryStat = lstatSync(keyDirectory);
    const keyStat = lstatSync(config.linuxBrokerPublicKeyPath);
    if (
      directoryStat.uid !== 0 ||
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      (directoryStat.mode & 0o022) !== 0 ||
      realpathSync(keyDirectory) !== keyDirectory ||
      keyStat.uid !== 0 ||
      !keyStat.isFile() ||
      keyStat.isSymbolicLink() ||
      (keyStat.mode & 0o022) !== 0 ||
      realpathSync(config.linuxBrokerPublicKeyPath) !== config.linuxBrokerPublicKeyPath
    ) throw new Error('unsafe broker public key');
    const nonce = randomBytes(32);
    const challenge = Buffer.concat([Buffer.from('IFB1'), nonce]);
    await new Promise((resolveWrite, rejectWrite) => {
      socket.write(challenge, (cause) => cause == null ? resolveWrite() : rejectWrite(cause));
    });
    challenge.fill(0);
    const response = await readExact(socket, 68);
    const identity = Buffer.alloc(8);
    identity.writeUInt32BE(process.pid, 0);
    identity.writeUInt32BE(process.getuid(), 4);
    const signed = Buffer.concat([Buffer.from('inflow-vault-broker-auth-v1\\0'), nonce, identity]);
    nonce.fill(0);
    identity.fill(0);
    const publicKey = createPublicKey({
      format: 'der',
      key: readFileSync(config.linuxBrokerPublicKeyPath),
      type: 'spki'
    });
    const valid =
      response.subarray(0, 4).equals(Buffer.from('IFR1')) &&
      verify(null, signed, publicKey, response.subarray(4));
    signed.fill(0);
    response.fill(0);
    if (!valid) throw new Error('broker authentication failed');
    return;
  }
  const peer = native.peerInfo(fd);
  if (typeof process.getuid !== 'function' || peer.uid !== process.getuid()) throw new Error('peer user mismatch');
  if (realpathSync(peer.path) !== config.expectedExecutablePath) throw new Error('peer executable mismatch');
  if (config.requireSignature) {
    execFileSync('/usr/bin/codesign', [
      '--verify',
      '--strict',
      \`--test-requirement==\${requirement}\`,
      peer.path
    ], { stdio: 'ignore' });
  }
}

async function waitForPath(filePath) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      lstatSync(filePath);
      return;
    } catch (cause) {
      if (cause?.code !== 'ENOENT') throw cause;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('broker public key unavailable');
}

function readExact(socket, length) {
  return new Promise((resolveRead, rejectRead) => {
    const chunks = [];
    let total = 0;
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
      socket.off('close', onEnd);
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total < length) return;
      cleanup();
      const bytes = Buffer.concat(chunks);
      for (const item of chunks) item.fill(0);
      if (bytes.byteLength !== length) {
        bytes.fill(0);
        rejectRead(new Error('broker response length mismatch'));
      } else {
        resolveRead(bytes);
      }
    };
    const onEnd = () => {
      cleanup();
      for (const chunk of chunks) chunk.fill(0);
      rejectRead(new Error('broker response truncated'));
    };
    const onError = (cause) => {
      cleanup();
      for (const chunk of chunks) chunk.fill(0);
      rejectRead(cause);
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.once('close', onEnd);
  });
}

})().catch(() => process.exit(1));
`;
