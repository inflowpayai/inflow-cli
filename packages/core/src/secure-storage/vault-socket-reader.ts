import { Buffer } from 'node:buffer';
import type { Socket } from 'node:net';
import { SecureStorageError } from './errors.js';
import { VAULT_IPC_MAX_MESSAGE_BYTES } from './vault-ipc.js';

const FRAME_TIMEOUT_MILLISECONDS = 10_000;
const IDLE_TIMEOUT_MILLISECONDS = 60_000;

/** @internal */
export class VaultSocketReader {
  private frame = Buffer.alloc(4);
  private offset = 0;
  private expected = 4;
  private timer: NodeJS.Timeout | undefined;
  private pending: { resolve(frame: Buffer | undefined): void; reject(cause: Error): void } | undefined;
  private ended = false;
  private failure: Error | undefined;

  constructor(private readonly socket: Socket) {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('end', this.onEnd);
    socket.on('close', this.onClose);
  }

  read(): Promise<Buffer | undefined> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ended || this.socket.destroyed) return Promise.resolve(undefined);
    if (this.pending !== undefined) return Promise.reject(new Error('A vault frame read is already pending.'));
    return new Promise((resolve, reject) => {
      this.pending = { reject, resolve };
      this.armTimeout(IDLE_TIMEOUT_MILLISECONDS);
    });
  }

  dispose(): void {
    this.onClose();
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('end', this.onEnd);
    this.socket.off('close', this.onClose);
  }

  private armTimeout(milliseconds: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.fail(new SecureStorageError('secure_storage_unavailable', 'The InFlow vault connection timed out.'));
    }, milliseconds);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private fail(cause: Error): void {
    this.failure ??= cause;
    this.clearTimer();
    this.frame.fill(0);
    this.pending?.reject(this.failure);
    this.pending = undefined;
    this.socket.destroy();
  }

  private readonly onClose = (): void => {
    this.ended = true;
    this.clearTimer();
    this.frame.fill(0);
    this.pending?.resolve(undefined);
    this.pending = undefined;
  };

  private readonly onData = (chunk: Buffer): void => {
    try {
      const pending = this.pending;
      if (pending === undefined) {
        this.fail(new SecureStorageError('secure_storage_corrupt', 'Vault IPC requests must be sequential.'));
        return;
      }
      if (this.offset === 0) this.armTimeout(FRAME_TIMEOUT_MILLISECONDS);
      let consumed = 0;
      while (consumed < chunk.length) {
        const count = Math.min(this.expected - this.offset, chunk.length - consumed);
        chunk.copy(this.frame, this.offset, consumed, consumed + count);
        this.offset += count;
        consumed += count;
        if (this.offset !== this.expected) continue;
        if (this.expected === 4) {
          const size = this.frame.readUInt32BE(0);
          if (size === 0 || size > VAULT_IPC_MAX_MESSAGE_BYTES) {
            this.fail(new SecureStorageError('secure_storage_corrupt', 'Vault IPC frame length is invalid.'));
            return;
          }
          const frame = Buffer.alloc(size + 4);
          this.frame.copy(frame);
          this.frame.fill(0);
          this.frame = frame;
          this.expected = frame.length;
          continue;
        }
        if (consumed !== chunk.length) {
          this.fail(new SecureStorageError('secure_storage_corrupt', 'Vault IPC requests must be sequential.'));
          return;
        }
        const frame = this.frame;
        this.frame = Buffer.alloc(4);
        this.offset = 0;
        this.expected = 4;
        this.clearTimer();
        pending.resolve(frame);
        this.pending = undefined;
      }
    } finally {
      chunk.fill(0);
    }
  };

  private readonly onEnd = (): void => {
    if (this.offset !== 0) {
      this.fail(new SecureStorageError('secure_storage_corrupt', 'Vault IPC frame is truncated.'));
      return;
    }
    this.onClose();
  };

  private readonly onError = (cause: Error): void => {
    this.fail(cause);
  };
}
