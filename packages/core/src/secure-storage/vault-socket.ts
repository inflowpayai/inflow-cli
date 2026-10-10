import { Buffer } from 'node:buffer';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { SecureStorageError } from './errors.js';
import type { VaultBackend } from './vault-backend.js';
import { handleVaultIpcRequest, type VaultDaemonInfo } from './vault-daemon-handler.js';
import type { VaultSocketPeer, VaultSocketPeerVerifier } from './vault-peer-verifier.js';
import { VaultSocketReader } from './vault-socket-reader.js';
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
): ((socket: Socket, peer?: VaultSocketPeer) => void) & { close(): Promise<void> } {
  const requestQueue = new VaultBackendRequestQueue();
  const connections = new Map<Socket, Promise<void>>();
  const users = new Map<string, number>();
  let closed = false;
  const admit = (peer: VaultSocketPeer | undefined): (() => void) => {
    const key = peer === undefined ? 'local' : (peer.principal ?? `uid:${peer.uid}`);
    const count = users.get(key) ?? 0;
    if (count >= 32) {
      throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault connection limit was reached.');
    }
    users.set(key, count + 1);
    return () => {
      const remaining = (users.get(key) ?? 1) - 1;
      if (remaining === 0) users.delete(key);
      else users.set(key, remaining);
    };
  };
  return Object.assign(
    (socket: Socket, peer?: VaultSocketPeer): void => {
      if (closed || connections.size >= 128) {
        socket.destroy();
        return;
      }
      const operation = handleSocket(socket, options, requestQueue, admit, peer).finally(() => {
        connections.delete(socket);
      });
      connections.set(socket, operation);
    },
    {
      async close(): Promise<void> {
        closed = true;
        const active = [...connections.entries()];
        for (const [socket] of active) socket.destroy();
        await Promise.all(active.map(([, operation]) => operation));
      },
    },
  );
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
      await Promise.all([
        closeServer(server, options.listenFd === undefined ? options.socketPath : undefined),
        handleConnection.close(),
      ]);
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
  try {
    const [, frame] = await Promise.all([writeFrame(socket, requestFrame), response]);
    const decoded = decodeVaultIpcFrame(frame);
    if (!('ok' in decoded)) {
      throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC response is malformed.');
    }
    return decoded;
  } finally {
    socket.destroy();
    const frame = await response.catch(() => undefined);
    frame?.fill(0);
  }
}

export function inspectVaultSocketPeer(
  socketPath: string,
  peerVerifier: VaultSocketPeerVerifier,
): Promise<VaultSocketPeer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const settle = (result: { cause: unknown } | { peer: VaultSocketPeer }): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      void closeVaultSocket(socket).then(() => {
        if ('cause' in result) {
          reject(normalizePeerInspectionFailure(result.cause));
        } else resolve(result.peer);
      });
    };
    socket.setTimeout(250, () => {
      settle({
        cause: new SecureStorageError('secure_storage_unavailable', 'The InFlow vault daemon is unavailable.'),
      });
    });
    socket.once('error', (cause) => {
      settle({ cause });
    });
    socket.once('connect', () => {
      Promise.resolve()
        .then(() => peerVerifier(socket))
        .then(
          (peer) => settle({ peer }),
          (cause: unknown) => settle({ cause }),
        );
    });
  });
}

function normalizePeerInspectionFailure(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
}

function closeVaultSocket(socket: Socket): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once('close', resolve);
    socket.destroy();
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
  admit: (peer: VaultSocketPeer | undefined) => () => void,
  verifiedPeer?: VaultSocketPeer,
): Promise<void> {
  socket.pause();
  const reader = new VaultSocketReader(socket);
  let release: (() => void) | undefined;
  try {
    const peer = verifiedPeer ?? (await verifyConnection(socket, options.peerVerifier));
    if (socket.destroyed) return;
    release = admit(peer);
    const multiTenant = options.backendForPeer !== undefined;
    if (multiTenant && peer === undefined) {
      throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
    }
    const queueKey = options.backendForPeer === undefined ? options.backend : (peer?.principal ?? `uid:${peer?.uid}`);
    for (;;) {
      const incoming = reader.read();
      socket.resume();
      const frame = await incoming;
      if (frame === undefined) break;
      let decoded: ReturnType<typeof decodeVaultIpcFrame> | undefined;
      try {
        decoded = decodeVaultIpcFrame(frame);
        if (!('method' in decoded)) {
          throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC request is malformed.');
        }
        const request = decoded;
        const response = await requestQueue.run(queueKey, () => {
          if (socket.destroyed) {
            throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault connection was closed.');
          }
          return handleVaultIpcRequest(resolveBackend(options, peer), request, options.daemonInfo, {
            allowDaemonShutdown: !multiTenant,
          });
        });
        let responseFrame: Buffer;
        try {
          responseFrame = encodeVaultIpcMessage(response);
        } finally {
          clearVaultIpcBytes(response);
        }
        await writeFrame(socket, responseFrame);
        if (!multiTenant && response.ok && (decoded.method === 'daemon.shutdown' || decoded.method === 'vault.reset')) {
          void Promise.resolve()
            .then(() => options.onShutdown?.())
            .catch(() => undefined);
          break;
        }
      } finally {
        if (decoded !== undefined) clearVaultIpcBytes(decoded);
        frame.fill(0);
      }
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
    if (!socket.destroyed) await writeFrame(socket, encodeVaultIpcMessage(response)).catch(() => undefined);
  } finally {
    reader.dispose();
    await finishSocket(socket);
    release?.();
  }
}

function finishSocket(socket: Socket): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise((resolve) => {
    const onError = (): void => {
      socket.destroy();
    };
    const discard = (bytes: Buffer): void => {
      bytes.fill(0);
    };
    const timer = setTimeout(() => socket.destroy(), 1_000);
    timer.unref();
    socket.on('error', onError);
    socket.on('data', discard);
    socket.once('close', () => {
      clearTimeout(timer);
      socket.off('error', onError);
      socket.off('data', discard);
      resolve();
    });
    socket.end();
    socket.resume();
  });
}

function verifyConnection(
  socket: Socket,
  verifier: VaultSocketPeerVerifier | undefined,
): Promise<VaultSocketPeer | undefined> {
  return new Promise((resolve, reject) => {
    const onClose = (): void => {
      finish(new SecureStorageError('secure_storage_unavailable', 'The InFlow vault connection was closed.'));
    };
    const timer = setTimeout(() => {
      finish(new SecureStorageError('secure_storage_unavailable', 'Vault peer verification timed out.'));
      socket.destroy();
    }, 10_000);
    timer.unref();
    const finish = (cause?: Error, peer?: VaultSocketPeer): void => {
      clearTimeout(timer);
      socket.off('close', onClose);
      if (cause !== undefined) reject(cause);
      else resolve(peer);
    };
    socket.once('close', onClose);
    Promise.resolve()
      .then(() => verifier?.(socket))
      .then(
        (peer) => finish(undefined, peer),
        (cause: unknown) =>
          finish(
            cause instanceof Error
              ? cause
              : new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.'),
          ),
      );
  });
}

class VaultBackendRequestQueue {
  private readonly tails = new Map<VaultBackend | string, Promise<void>>();

  async run<T>(backend: VaultBackend | string, operation: () => Promise<T>): Promise<T> {
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
    const finish = (cause?: Error | null): void => {
      clearTimeout(timer);
      socket.off('close', onClose);
      frame.fill(0);
      if (cause) reject(cause);
      else resolve();
    };
    const onClose = (): void =>
      finish(new SecureStorageError('secure_storage_unavailable', 'The InFlow vault connection was closed.'));
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new SecureStorageError('secure_storage_unavailable', 'The InFlow vault connection timed out.'));
    }, 10_000);
    timer.unref();
    socket.once('close', onClose);
    socket.write(frame, finish);
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
    socket.once('close', () => {
      settle(new SecureStorageError('secure_storage_unavailable', 'The InFlow vault connection was closed.'));
    });
  });
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  await mkdir(path.dirname(socketPath), { mode: 0o700, recursive: true });
  try {
    const existing = await lstat(socketPath);
    if (existing.isSymbolicLink() || existing.isDirectory()) {
      throw new SecureStorageError('secure_storage_invalid_path', 'The vault socket path is unsafe.');
    }
    if (existing.isSocket() && (await isReachableVaultSocket(socketPath))) {
      throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault daemon is already running.');
    }
    await rm(socketPath, { force: true });
  } catch (cause) {
    if (isMissingFileError(cause)) return;
    throw cause;
  }
}

export function isReachableVaultSocket(socketPath: string): Promise<boolean> {
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

export const __testing = { closeVaultSocket, normalizePeerInspectionFailure };
