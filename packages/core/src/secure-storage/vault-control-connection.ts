import type { Buffer } from 'node:buffer';
import { createConnection, type Socket } from 'node:net';
import { SecureStorageError } from './errors.js';
import {
  clearVaultIpcBytes,
  decodeVaultIpcFrame,
  encodeVaultIpcMessage,
  VAULT_IPC_MAX_MESSAGE_BYTES,
  type VaultIpcRequest,
  type VaultIpcResponse,
} from './vault-ipc.js';
import type { VaultSocketPeerVerifier } from './vault-peer-verifier.js';
import { VaultSocketReader } from './vault-socket-reader.js';

const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const IDLE_TIMEOUT_MILLISECONDS = 60_000;
const MAX_WAITING_REQUESTS = 32;

interface Connection {
  socket: Socket;
  daemonChecked?: boolean;
  reader?: VaultSocketReader;
  idleTimer?: NodeJS.Timeout;
  error?: Error;
}

interface Request {
  id: string;
  method: VaultIpcRequest['method'];
  deadline: number;
  frame: Buffer;
  timer: NodeJS.Timeout;
  settled: boolean;
  resolve(response: VaultIpcResponse): void;
  reject(cause: Error): void;
}

/** @internal */
export class VaultControlConnection {
  private connection: Connection | undefined;
  private active: Request | undefined;
  private readonly waiting: Request[] = [];
  private waitingBytes = 0;
  private disposed = false;

  constructor(
    private readonly socketPath: string,
    private readonly createVerifier: () => VaultSocketPeerVerifier | undefined,
    private readonly validateDaemon?: (info: Record<string, unknown>) => void,
  ) {}

  async request(request: VaultIpcRequest): Promise<VaultIpcResponse> {
    if (this.disposed) throw unavailable('The InFlow vault connection is closed.');
    const frame = encodeVaultIpcMessage(request);
    if (
      this.active !== undefined &&
      (this.waiting.length >= MAX_WAITING_REQUESTS || this.waitingBytes + frame.length > VAULT_IPC_MAX_MESSAGE_BYTES)
    ) {
      frame.fill(0);
      throw new SecureStorageError('vault_daemon_busy', 'The InFlow vault request queue is full.');
    }
    return new Promise((resolve, reject) => {
      const job: Request = {
        deadline: performance.now() + REQUEST_TIMEOUT_MILLISECONDS,
        frame,
        id: request.id,
        method: request.method,
        reject,
        resolve,
        settled: false,
        timer: setTimeout(() => {
          if (this.active === job) this.disconnect();
          this.finish(job, unavailable('The InFlow vault request timed out.'));
        }, REQUEST_TIMEOUT_MILLISECONDS),
      };
      this.waiting.push(job);
      this.waitingBytes += frame.length;
      this.pump();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    for (const job of [...this.waiting]) this.finish(job, unavailable('The InFlow vault connection is closed.'));
    if (this.active !== undefined) this.finish(this.active, unavailable('The InFlow vault connection is closed.'));
  }

  private disconnect(): void {
    const connection = this.connection;
    this.connection = undefined;
    if (connection === undefined) return;
    if (connection.idleTimer !== undefined) clearTimeout(connection.idleTimer);
    connection.socket.destroy();
    connection.reader?.dispose();
  }

  private finish(job: Request, result: Error | VaultIpcResponse): void {
    if (job.settled) {
      if (!(result instanceof Error)) clearVaultIpcBytes(result);
      return;
    }
    job.settled = true;
    clearTimeout(job.timer);
    job.frame.fill(0);
    const index = this.waiting.indexOf(job);
    if (index !== -1) {
      this.waiting.splice(index, 1);
      this.waitingBytes -= job.frame.length;
    }
    if (this.active === job) this.active = undefined;
    if (result instanceof Error) job.reject(result);
    else job.resolve(result);
    this.pump();
  }

  private pump(): void {
    if (this.active !== undefined || this.disposed) return;
    const job = this.waiting.shift();
    if (job === undefined) {
      const connection = this.connection;
      if (connection !== undefined) {
        if (connection.idleTimer !== undefined) clearTimeout(connection.idleTimer);
        connection.socket.unref();
        connection.idleTimer = setTimeout(() => {
          if (this.connection === connection) this.disconnect();
        }, IDLE_TIMEOUT_MILLISECONDS);
        connection.idleTimer.unref();
      }
      return;
    }
    this.waitingBytes -= job.frame.length;
    this.active = job;
    if (performance.now() >= job.deadline) {
      this.finish(job, unavailable('The InFlow vault request timed out.'));
      return;
    }
    void this.execute(job).then(
      (response) => this.finish(job, response),
      (cause: unknown) => {
        if (this.active === job) this.disconnect();
        this.finish(job, cause instanceof Error ? cause : unavailable('The InFlow vault request failed.'));
      },
    );
  }

  private async execute(job: Request): Promise<VaultIpcResponse> {
    let connection = this.connection;
    if (connection === undefined || connection.socket.destroyed || connection.socket.readableEnded) {
      this.disconnect();
      const verifier = this.createVerifier();
      this.assertActive(job);
      const socket = createConnection(this.socketPath);
      connection = { socket };
      this.connection = connection;
      const opened = connection;
      socket.on('error', (cause) => {
        opened.error = cause;
      });
      socket.once('close', () => {
        opened.reader?.dispose();
        if (opened.idleTimer !== undefined) clearTimeout(opened.idleTimer);
        if (this.connection === opened) this.connection = undefined;
      });
      await new Promise<void>((resolve, reject) => {
        const onConnect = (): void => {
          socket.off('close', onClose);
          resolve();
        };
        const onClose = (): void => {
          socket.off('connect', onConnect);
          reject(opened.error ?? unavailable('The InFlow vault connection was closed.'));
        };
        socket.once('connect', onConnect);
        socket.once('close', onClose);
      });
      this.assertActive(job);
      await verifier?.(socket);
      this.assertActive(job);
      if (socket.destroyed) throw opened.error ?? unavailable('The InFlow vault connection was closed.');
      socket.pause();
      opened.reader = new VaultSocketReader(socket);
    }
    if (connection.idleTimer !== undefined) clearTimeout(connection.idleTimer);
    connection.socket.ref();
    this.assertActive(job);
    if (this.validateDaemon !== undefined && !['daemon.info', 'daemon.shutdown', 'vault.status'].includes(job.method)) {
      if (connection.daemonChecked !== true) {
        const id = `${job.id}_info`;
        const frame = encodeVaultIpcMessage({ id, method: 'daemon.info', params: {}, version: 1 });
        try {
          const info = await this.exchange(connection, job, frame, id);
          try {
            if (!info.ok) throw unavailable('The InFlow vault daemon could not be identified.');
            this.validateDaemon(info.result);
            connection.daemonChecked = true;
          } finally {
            clearVaultIpcBytes(info);
          }
        } finally {
          frame.fill(0);
        }
      }
    }
    const response = await this.exchange(connection, job, job.frame, job.id);
    if (
      response.ok &&
      (job.method === 'vault.reset' || job.method === 'daemon.shutdown') &&
      this.connection === connection
    )
      this.disconnect();
    return response;
  }

  private async exchange(
    connection: Connection,
    job: Request,
    outgoing: Buffer,
    id: string,
  ): Promise<VaultIpcResponse> {
    this.assertActive(job);
    const reader = connection.reader;
    if (reader === undefined) throw unavailable('The InFlow vault connection was not verified.');
    const incoming = reader.read();
    const written = new Promise<void>((resolve, reject) => {
      connection.socket.write(outgoing, (cause) => {
        if (cause) reject(cause);
        else resolve();
      });
    });
    connection.socket.resume();
    try {
      const [, frame] = await Promise.all([written, incoming]);
      this.assertActive(job);
      if (frame === undefined) throw connection.error ?? unavailable('The InFlow vault connection was closed.');
      const response = decodeVaultIpcFrame(frame);
      if ('ok' in response && !response.ok && response.error.code === 'secure_storage_peer_verification_failed') {
        throw new SecureStorageError('secure_storage_peer_verification_failed', response.error.message);
      }
      if (!('ok' in response) || response.id !== id) {
        clearVaultIpcBytes(response);
        throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC response is malformed.');
      }
      return response;
    } catch (cause) {
      connection.socket.destroy();
      reader.dispose();
      throw cause;
    } finally {
      if (job.settled || connection.socket.destroyed) reader.dispose();
      const frame = await incoming.catch(() => undefined);
      frame?.fill(0);
    }
  }

  private assertActive(job: Request): void {
    if (job.settled || this.disposed) throw unavailable('The InFlow vault request was cancelled.');
    if (performance.now() >= job.deadline) throw unavailable('The InFlow vault request timed out.');
  }
}

function unavailable(message: string): SecureStorageError {
  return new SecureStorageError('secure_storage_unavailable', message);
}
