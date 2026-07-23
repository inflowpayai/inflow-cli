import { Buffer } from 'node:buffer';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { SecureStorageError } from './errors.js';
import type { VaultBackend } from './vault-backend.js';
import { handleVaultIpcRequest, type VaultDaemonInfo } from './vault-daemon-handler.js';
import type { VaultSocketPeerVerifier } from './vault-peer-verifier.js';
import {
  VAULT_IPC_MAX_MESSAGE_BYTES,
  decodeVaultIpcFrame,
  encodeVaultIpcMessage,
  type VaultIpcRequest,
  type VaultIpcResponse,
} from './vault-ipc.js';

export interface VaultSocketServer {
  close(): Promise<void>;
  socketPath: string;
}

export interface StartVaultSocketServerOptions {
  backend: VaultBackend;
  daemonInfo?: VaultDaemonInfo;
  onShutdown?: () => Promise<void> | void;
  peerVerifier?: VaultSocketPeerVerifier;
  socketPath: string;
}

export async function startVaultSocketServer(options: StartVaultSocketServerOptions): Promise<VaultSocketServer> {
  await prepareSocketPath(options.socketPath);
  const server = createServer((socket) => {
    void handleSocket(socket, options.backend, options.peerVerifier, options.onShutdown, options.daemonInfo);
  });
  await listen(server, options.socketPath);
  await chmod(options.socketPath, 0o600);
  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server, options.socketPath);
    },
    socketPath: options.socketPath,
  };
}

export async function sendVaultIpcRequest(socketPath: string, request: VaultIpcRequest): Promise<VaultIpcResponse> {
  const socket = createConnection(socketPath);
  const response = readOneFrame(socket);
  socket.write(encodeVaultIpcMessage(request));
  return response.then((frame) => {
    const decoded = decodeVaultIpcFrame(frame);
    if (!('ok' in decoded)) {
      throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC response is malformed.');
    }
    socket.end();
    return decoded;
  });
}

async function handleSocket(
  socket: Socket,
  backend: VaultBackend,
  peerVerifier: VaultSocketPeerVerifier | undefined,
  onShutdown: (() => Promise<void> | void) | undefined,
  daemonInfo: VaultDaemonInfo | undefined,
): Promise<void> {
  try {
    await peerVerifier?.(socket);
    const frame = await readOneFrame(socket);
    const decoded = decodeVaultIpcFrame(frame);
    if (!('method' in decoded)) {
      throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC request is malformed.');
    }
    const response = await handleVaultIpcRequest(backend, decoded, daemonInfo);
    socket.end(encodeVaultIpcMessage(response), () => {
      if (response.ok && (decoded.method === 'daemon.shutdown' || decoded.method === 'vault.reset')) {
        void Promise.resolve(onShutdown?.()).catch(() => undefined);
      }
    });
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
    socket.end(encodeVaultIpcMessage(response), () => {
      socket.destroy();
    });
  }
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
      socket.off('error', onError);
      socket.off('end', onEnd);
      if (result instanceof Error) {
        reject(result);
        return;
      }
      resolve(result);
    };
    const tryResolve = (): void => {
      const buffer = Buffer.concat(chunks);
      if (buffer.byteLength < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length > VAULT_IPC_MAX_MESSAGE_BYTES) {
        socket.destroy();
        settle(new SecureStorageError('secure_storage_invalid_path', 'Vault IPC message is too large.'));
        return;
      }
      if (buffer.byteLength >= length + 4) {
        settle(buffer.subarray(0, length + 4));
      }
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

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((cause) => {
      if (cause !== undefined) {
        reject(cause);
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
