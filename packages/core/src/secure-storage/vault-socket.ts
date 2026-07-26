import { Buffer } from 'node:buffer';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { SecureStorageError } from './errors.js';
import type { VaultBackend } from './vault-backend.js';
import { handleVaultIpcRequest, type VaultDaemonInfo } from './vault-daemon-handler.js';
import type { VaultSocketPeer, VaultSocketPeerVerifier } from './vault-peer-verifier.js';
import {
  VAULT_IPC_MAX_MESSAGE_BYTES,
  clearVaultIpcBytes,
  decodeVaultIpcFrame,
  encodeVaultIpcMessage,
  type VaultIpcRequest,
  type VaultIpcResponse,
} from './vault-ipc.js';

export interface VaultSocketServer {
  close(): Promise<void>;
  socketPath: string;
}

interface VaultSocketServerCommonOptions {
  daemonInfo?: VaultDaemonInfo;
  listenFd?: number;
  socketMode?: number;
  socketPath: string;
}

export interface StartSingleTenantVaultSocketServerOptions extends VaultSocketServerCommonOptions {
  backend: VaultBackend;
  backendForPeer?: never;
  onShutdown?: () => Promise<void> | void;
  peerVerifier?: VaultSocketPeerVerifier;
}

export interface StartMultiTenantVaultSocketServerOptions extends VaultSocketServerCommonOptions {
  backend?: never;
  backendForPeer(peer: VaultSocketPeer): VaultBackend;
  onShutdown?: never;
  peerVerifier: VaultSocketPeerVerifier;
}

export type StartVaultSocketServerOptions =
  StartMultiTenantVaultSocketServerOptions | StartSingleTenantVaultSocketServerOptions;

export function createVaultSocketConnectionHandler(
  options: StartVaultSocketServerOptions,
): (socket: Socket, peer?: VaultSocketPeer) => void {
  const requestQueue = new VaultBackendRequestQueue();
  return (socket, peer) => {
    void handleSocket(socket, options, requestQueue, peer);
  };
}

export async function startVaultSocketServer(options: StartVaultSocketServerOptions): Promise<VaultSocketServer> {
  if (options.listenFd === undefined) await prepareSocketPath(options.socketPath);
  const handleConnection = createVaultSocketConnectionHandler(options);
  const server = createServer(handleConnection);
  await listen(server, options);
  if (options.listenFd === undefined) await chmod(options.socketPath, options.socketMode ?? 0o600);
  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server, options.listenFd === undefined ? options.socketPath : undefined);
    },
    socketPath: options.socketPath,
  };
}

export async function sendVaultIpcRequest(
  socketPath: string,
  request: VaultIpcRequest,
  peerVerifier?: VaultSocketPeerVerifier,
): Promise<VaultIpcResponse> {
  const socket = createConnection(socketPath);
  await connectAndVerify(socket, peerVerifier);
  const response = readOneFrame(socket);
  const requestFrame = encodeVaultIpcMessage(request);
  await writeFrame(socket, requestFrame);
  return response.then((frame) => {
    try {
      const decoded = decodeVaultIpcFrame(frame);
      if (!('ok' in decoded)) {
        throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC response is malformed.');
      }
      socket.end();
      return decoded;
    } finally {
      frame.fill(0);
    }
  });
}

function connectAndVerify(socket: Socket, peerVerifier: VaultSocketPeerVerifier | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onConnect = (): void => {
      socket.off('error', onError);
      Promise.resolve()
        .then(() => peerVerifier?.(socket))
        .then(
          () => resolve(),
          (cause: unknown) => {
            socket.destroy();
            reject(
              cause instanceof Error
                ? cause
                : new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.'),
            );
          },
        );
    };
    const onError = (cause: Error): void => {
      socket.off('connect', onConnect);
      reject(cause);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

async function handleSocket(
  socket: Socket,
  options: StartVaultSocketServerOptions,
  requestQueue: VaultBackendRequestQueue,
  verifiedPeer?: VaultSocketPeer,
): Promise<void> {
  try {
    const peer = verifiedPeer ?? (await options.peerVerifier?.(socket));
    const multiTenant = options.backendForPeer !== undefined;
    const backend = resolveBackend(options, peer);
    const frame = await readOneFrame(socket);
    const decoded = decodeVaultIpcFrame(frame);
    if (!('method' in decoded)) {
      throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC request is malformed.');
    }
    try {
      const response = await requestQueue.run(backend, () =>
        handleVaultIpcRequest(backend, decoded, options.daemonInfo, {
          allowDaemonShutdown: !multiTenant,
        }),
      );
      const responseFrame = encodeVaultIpcMessage(response);
      clearVaultIpcBytes(response);
      socket.end(responseFrame, () => {
        responseFrame.fill(0);
        if (!multiTenant && response.ok && (decoded.method === 'daemon.shutdown' || decoded.method === 'vault.reset')) {
          void Promise.resolve(options.onShutdown?.()).catch(() => undefined);
        }
      });
    } finally {
      clearVaultIpcBytes(decoded);
      frame.fill(0);
    }
  } catch (cause) {
    const response: VaultIpcResponse = {
      error: {
        code: cause instanceof SecureStorageError ? cause.secureStorageCode : 'secure_storage_io_error',
        message: cause instanceof SecureStorageError ? cause.message : 'The InFlow vault operation failed.',
      },
      id: 'unknown',
      ok: false,
      version: 1,
    };
    const responseFrame = encodeVaultIpcMessage(response);
    socket.end(responseFrame, () => {
      responseFrame.fill(0);
      socket.destroy();
    });
  }
}

class VaultBackendRequestQueue {
  private readonly tails = new WeakMap<VaultBackend, Promise<void>>();

  async run<T>(backend: VaultBackend, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(backend) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(backend, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(backend) === current) this.tails.delete(backend);
    }
  }
}

function resolveBackend(options: StartVaultSocketServerOptions, peer: VaultSocketPeer | undefined): VaultBackend {
  if (options.backendForPeer === undefined) return options.backend;
  if (peer === undefined) {
    throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
  }
  return options.backendForPeer(peer);
}

function writeFrame(socket: Socket, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (cause: Error): void => {
      frame.fill(0);
      reject(cause);
    };
    socket.once('error', onError);
    socket.write(frame, () => {
      socket.off('error', onError);
      frame.fill(0);
      resolve();
    });
  });
}

function readOneFrame(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (result: Buffer | SecureStorageError | Error): void => {
      if (settled) return;
      settled = true;
      socket.off('data', onData);
      socket.off('end', onEnd);
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      if (result instanceof Error) {
        reject(result);
        return;
      }
      resolve(result);
    };
    const tryResolve = (): void => {
      const buffer = Buffer.concat(chunks);
      if (buffer.byteLength < 4) {
        buffer.fill(0);
        return;
      }
      const length = buffer.readUInt32BE(0);
      if (length > VAULT_IPC_MAX_MESSAGE_BYTES) {
        socket.destroy();
        buffer.fill(0);
        settle(new SecureStorageError('secure_storage_invalid_path', 'Vault IPC message is too large.'));
        return;
      }
      if (buffer.byteLength >= length + 4) {
        settle(buffer.subarray(0, length + 4));
        return;
      }
      buffer.fill(0);
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total > VAULT_IPC_MAX_MESSAGE_BYTES + 4) {
        socket.destroy();
        settle(new SecureStorageError('secure_storage_invalid_path', 'Vault IPC message is too large.'));
        return;
      }
      tryResolve();
    };
    const onError = (cause: Error): void => {
      settle(cause);
    };
    const onEnd = (): void => {
      tryResolve();
      settle(new SecureStorageError('secure_storage_corrupt', 'Vault IPC frame is truncated.'));
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
  });
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  await mkdir(path.dirname(socketPath), { mode: 0o700, recursive: true });
  try {
    const existing = await lstat(socketPath);
    if (existing.isSymbolicLink() || existing.isDirectory()) {
      throw new SecureStorageError('secure_storage_invalid_path', 'The vault socket path is unsafe.');
    }
    if (existing.isSocket() && (await isReachableSocket(socketPath))) {
      throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault daemon is already running.');
    }
    await rm(socketPath, { force: true });
  } catch (cause) {
    if (isMissingFileError(cause)) return;
    throw cause;
  }
}

function isReachableSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const settle = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(250, () => {
      settle(false);
    });
    socket.once('connect', () => {
      settle(true);
    });
    socket.once('error', () => {
      settle(false);
    });
  });
}

function listen(server: Server, options: StartVaultSocketServerOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.listenFd === undefined ? options.socketPath : { fd: options.listenFd }, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server, socketPath: string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((cause) => {
      if (cause !== undefined) {
        reject(cause);
        return;
      }
      if (socketPath === undefined) {
        resolve();
        return;
      }
      rm(socketPath, { force: true }).then(() => resolve(), reject);
    });
  });
}

function isMissingFileError(cause: unknown): boolean {
  return (
    typeof cause === 'object' && cause !== null && 'code' in cause && (cause as { code?: unknown }).code === 'ENOENT'
  );
}
