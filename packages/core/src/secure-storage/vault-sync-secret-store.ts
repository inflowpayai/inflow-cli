import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import process from 'node:process';
import { Worker } from 'node:worker_threads';
import { SecureStorageError, type SecureStorageErrorCode } from './errors.js';
import type { SecretReference, SyncSecureSecretStore } from './secret-store.js';
import { LINUX_VAULT_BROKER_PUBLIC_KEY } from './vault-broker-auth.js';
import {
  decodeVaultIpcFrame,
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
import { sendWindowsVaultIpcRequest } from './vault-windows-transport.js';

export interface SyncVaultSecretStoreOptions {
  rootDirectory?: string;
  timeoutMs?: number;
}

const SHARED_HEADER_INTS = 2;
const SHARED_HEADER_BYTES = SHARED_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
const DEFAULT_TIMEOUT_MS = 10_000;

interface PeerVerificationDependencies {
  createConfig(options: {
    allowUnavailableExecutablePath?: boolean;
    expectedUserId?: number;
    requireSameUser?: boolean;
  }): VaultPeerVerificationConfig;
  isLinux(): boolean;
  linuxServiceUserId(socketPath: string): number;
  shouldRequirePeerVerification(): boolean;
  usesLinuxService(): boolean;
  verifyConfig(configuration: VaultPeerVerificationConfig): void;
}

const peerVerificationDependencies: PeerVerificationDependencies = {
  createConfig: createVaultPeerVerificationConfig,
  isLinux: () => process.platform === 'linux',
  linuxServiceUserId: linuxVaultServiceUserId,
  shouldRequirePeerVerification: shouldRequireVaultPeerVerification,
  usesLinuxService: usesLinuxVaultService,
  verifyConfig: verifyVaultPeerVerificationConfig,
};

export class SyncVaultSecretStore implements SyncSecureSecretStore {
  private readonly rootDirectory: string | undefined;
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(options: SyncVaultSecretStoreOptions = {}) {
    this.rootDirectory = options.rootDirectory;
    this.socketPath = vaultFilePaths(options.rootDirectory).socket;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  create(reference: SecretReference, value: Uint8Array): void {
    this.request('secret.put', {
      expectedKind: kindForReference(reference),
      payload: value,
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
    if (!(payload instanceof Uint8Array)) {
      throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC secret response is malformed.');
    }
    return Buffer.from(payload);
  }

  private request(method: VaultIpcRequest['method'], params: Record<string, unknown>): Record<string, unknown> {
    const request: VaultIpcRequest = {
      id: `req_${randomUUID().replaceAll('-', '')}`,
      method,
      params,
      version: 1,
    };
    if (process.platform === 'win32' && this.rootDirectory === undefined) {
      return responseResult(sendWindowsVaultIpcRequest(this.socketPath, request));
    }
    const shared = new SharedArrayBuffer(SHARED_HEADER_BYTES + VAULT_IPC_MAX_MESSAGE_BYTES + 4);
    const state = new Int32Array(shared, 0, SHARED_HEADER_INTS);
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        request,
        peerVerification: createPeerVerification(this.socketPath, this.rootDirectory),
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
    try {
      const response = decodeVaultIpcFrame(bytes);
      if ('method' in response) {
        throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC response is malformed.');
      }
      return responseResult(response);
    } finally {
      bytes.fill(0);
    }
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
  dependencies: PeerVerificationDependencies = peerVerificationDependencies,
): (VaultPeerVerificationConfig & { linuxBrokerPublicKeyPath?: string }) | undefined {
  if (!dependencies.shouldRequirePeerVerification()) return undefined;
  const configuration =
    rootDirectory === undefined && dependencies.usesLinuxService()
      ? dependencies.createConfig({
          expectedUserId: dependencies.linuxServiceUserId(socketPath),
          requireSameUser: false,
        })
      : dependencies.createConfig({
          allowUnavailableExecutablePath: dependencies.isLinux(),
        });
  dependencies.verifyConfig(configuration);
  return rootDirectory === undefined && dependencies.usesLinuxService()
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
  createPeerVerification,
  errorFromWorker,
  kindForReference,
  responseResult,
  vaultReferenceFor,
};

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
const { createHash, createPublicKey, randomBytes, verify } = await import('node:crypto');
const { execFileSync } = await import('node:child_process');
const { lstatSync, readFileSync, realpathSync } = await import('node:fs');
const { createRequire } = await import('node:module');
const { resolve } = await import('node:path');
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
  if (peer.executablePathAvailable === false) {
    if (!config.allowUnavailableExecutablePath) throw new Error('peer executable unavailable');
  } else if (realpathSync(peer.path) !== config.expectedExecutablePath) throw new Error('peer executable mismatch');
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
      rejectRead(new Error('broker response truncated'));
    };
    const onError = (cause) => {
      cleanup();
      rejectRead(cause);
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
  });
}

const attachments = [];
function encodeAttachments(value) {
  if (value instanceof Uint8Array) {
    const index = attachments.push(value) - 1;
    return { $inflowVaultAttachment: index };
  }
  if (Array.isArray(value)) return value.map(encodeAttachments);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeAttachments(item)]));
}
const json = Buffer.from(JSON.stringify(encodeAttachments(workerData.request)), 'utf8');
const attachmentBytes = attachments.reduce(
  (total, attachment) => total + 4 + attachment.byteLength * 2,
  0,
);
const bodyLength = 8 + json.byteLength + attachmentBytes;
if (bodyLength > ${VAULT_IPC_MAX_MESSAGE_BYTES}) {
  fail('secure_storage_invalid_path', 'Vault IPC message is too large.');
} else {
  const frame = Buffer.alloc(4 + bodyLength);
  frame.writeUInt32BE(bodyLength, 0);
  frame.writeUInt32BE(json.byteLength, 4);
  frame.writeUInt32BE(attachments.length, 8);
  json.copy(frame, 12);
  let frameOffset = 12 + json.byteLength;
  for (const attachment of attachments) {
    frame.writeUInt32BE(attachment.byteLength * 2, frameOffset);
    frameOffset += 4;
    const mask = randomBytes(attachment.byteLength);
    mask.copy(frame, frameOffset);
    frameOffset += attachment.byteLength;
    for (let index = 0; index < attachment.byteLength; index += 1) {
      frame[frameOffset + index] = (attachment[index] ?? 0) ^ (mask[index] ?? 0);
    }
    frameOffset += attachment.byteLength;
    mask.fill(0);
  }
  json.fill(0);
  const socket = net.createConnection(workerData.socketPath);
  socket.on('error', () => {
    fail('secure_storage_unavailable', 'The InFlow vault daemon is unavailable.');
  });
  const chunks = [];
  let total = 0;
  let settled = false;
  function settle(status, bytes) {
    if (settled) return;
    settled = true;
    socket.destroy();
    finish(status, bytes);
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
    chunks.length = 0;
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
  socket.on('connect', async () => {
    try {
      await verifyPeer(socket);
      attachResponseListeners();
      socket.write(frame, () => {
        frame.fill(0);
        for (const attachment of attachments) attachment.fill(0);
      });
    } catch {
      fail('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
      socket.destroy();
    }
  });
  function attachResponseListeners() {
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
    socket.on('end', () => {
      tryResolve();
      fail('secure_storage_corrupt', 'Vault IPC frame is truncated.');
    });
  }
}
})().catch(() => {
  finishFromCatch();
});
`;
