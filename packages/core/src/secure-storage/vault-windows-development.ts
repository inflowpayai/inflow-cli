import { Buffer } from 'node:buffer';
import { SecureStorageError } from './errors.js';
import { handleVaultIpcRequest } from './vault-daemon-handler.js';
import { usesDevelopmentVault } from './vault-files.js';
import {
  clearVaultIpcBytes,
  decodeVaultIpcFrame,
  encodeVaultIpcMessage,
  type VaultIpcMessage,
  type VaultIpcResponse,
} from './vault-ipc.js';
import type { StartSingleTenantVaultSocketServerOptions, VaultSocketServer } from './vault-socket.js';
import { createWindowsVaultTransport } from './vault-windows-transport.js';

export function startWindowsDevelopmentVaultServer(
  options: StartSingleTenantVaultSocketServerOptions,
): VaultSocketServer {
  if (process.platform !== 'win32' || !usesDevelopmentVault()) throw unavailable();
  const transport = createWindowsVaultTransport();
  const connections = new Map<number, { generation: number; active: boolean; shutdown: boolean }>();
  let tail = Promise.resolve();
  let stopping = false;
  transport.startDispatcher(options.socketPath, (event) => {
    if (event.type === 'closed') {
      const connection = connections.get(event.slot);
      if (connection?.generation === event.generation) {
        connection.active = false;
        connections.delete(event.slot);
        // The client closes after receiving reset/shutdown; keep the response pipe alive until then.
        if (connection.shutdown) void options.onShutdown?.();
      }
      return;
    }
    const previous = connections.get(event.slot);
    const connection =
      previous?.generation === event.generation
        ? previous
        : { generation: event.generation, active: true, shutdown: false };
    if (previous !== undefined && previous !== connection) previous.active = false;
    connections.set(event.slot, connection);
    const frame = Buffer.from(event.frame);
    tail = tail
      .then(async () => {
        let request: VaultIpcMessage | undefined;
        let response: VaultIpcResponse | undefined;
        let outgoing: Buffer | undefined;
        try {
          if (!connection.active || stopping) throw unavailable();
          request = decodeVaultIpcFrame(frame);
          if (!('method' in request))
            throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC request is malformed.');
          response = await handleVaultIpcRequest(options.backend, request, options.daemonInfo);
          if (response.ok && (request.method === 'daemon.shutdown' || request.method === 'vault.reset')) {
            connection.shutdown = true;
            stopping = true;
          }
        } catch (cause) {
          response = {
            id: request?.id ?? 'unknown',
            version: 1,
            ok: false,
            error: {
              code: cause instanceof SecureStorageError ? cause.secureStorageCode : 'secure_storage_io_error',
              message: cause instanceof SecureStorageError ? cause.message : 'The InFlow vault operation failed.',
            },
          };
        }
        try {
          if (connection.active) {
            outgoing = encodeVaultIpcMessage(response);
            transport.respond(event, outgoing);
          } else if (connection.shutdown) {
            void options.onShutdown?.();
          }
        } finally {
          frame.fill(0);
          outgoing?.fill(0);
          clearVaultIpcBytes(request);
          clearVaultIpcBytes(response);
        }
      })
      .catch(() => {
        stopping = true;
        transport.stopDispatcher();
        void options.onShutdown?.();
      });
  });
  return {
    socketPath: options.socketPath,
    async close() {
      stopping = true;
      for (const connection of connections.values()) connection.active = false;
      transport.stopDispatcher();
      await tail;
    },
  };
}

function unavailable(): SecureStorageError {
  return new SecureStorageError('secure_storage_unavailable', 'The InFlow vault daemon is unavailable.');
}
