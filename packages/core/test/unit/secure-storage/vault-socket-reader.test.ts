import { Buffer } from 'node:buffer';
import { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultSocketReader } from '../../../src/secure-storage/vault-socket-reader.js';
import { encodeVaultIpcMessage, VAULT_IPC_MAX_MESSAGE_BYTES } from '../../../src/secure-storage/vault-ipc.js';

describe('vault socket frame reader', () => {
  const readers: VaultSocketReader[] = [];
  const sockets: Socket[] = [];

  function create(): { socket: Socket; reader: VaultSocketReader } {
    const socket = new Socket();
    const reader = new VaultSocketReader(socket);
    sockets.push(socket);
    readers.push(reader);
    return { reader, socket };
  }

  afterEach(() => {
    for (const reader of readers.splice(0)) reader.dispose();
    for (const socket of sockets.splice(0)) socket.destroy();
    vi.useRealTimers();
  });

  it('assembles fragmented headers and bodies and clears input buffers', async () => {
    const { reader, socket } = create();
    const expected = encodeVaultIpcMessage({ id: 'a', method: 'vault.status', params: {}, version: 1 });
    const response = reader.read();
    for (const byte of expected) {
      const fragment = Buffer.from([byte]);
      socket.emit('data', fragment);
      expect(fragment[0]).toBe(0);
    }
    await expect(response).resolves.toEqual(expected);
    const next = reader.read();
    socket.emit('data', Buffer.from(expected));
    await expect(next).resolves.toEqual(expected);
  });

  it('rejects overlapping reads without replacing the pending read', async () => {
    const { reader, socket } = create();
    const first = reader.read();
    await expect(reader.read()).rejects.toThrow('already pending');
    socket.emit('end');
    await expect(first).resolves.toBeUndefined();
    await expect(reader.read()).resolves.toBeUndefined();
  });

  it.each([0, VAULT_IPC_MAX_MESSAGE_BYTES + 1])('rejects invalid declared length %s', async (length) => {
    const { reader, socket } = create();
    const pending = expect(reader.read()).rejects.toThrow('length is invalid');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(length);
    socket.emit('data', header);
    await pending;
    expect(socket.destroyed).toBe(true);
    await expect(reader.read()).rejects.toThrow('length is invalid');
  });

  it('rejects coalesced frames and unsolicited bytes', async () => {
    const frame = encodeVaultIpcMessage({ id: 'a', method: 'vault.status', params: {}, version: 1 });
    const first = create();
    const pending = expect(first.reader.read()).rejects.toThrow('must be sequential');
    first.socket.emit('data', Buffer.concat([frame, frame]));
    await pending;
    const second = create();
    second.socket.emit('data', Buffer.from(frame));
    expect(second.socket.destroyed).toBe(true);
    await expect(second.reader.read()).rejects.toThrow('must be sequential');
  });

  it('rejects truncated frames and retains socket errors', async () => {
    const first = create();
    const truncated = expect(first.reader.read()).rejects.toThrow('truncated');
    first.socket.emit('data', Buffer.from([0, 0]));
    first.socket.emit('end');
    await truncated;
    const second = create();
    const failed = expect(second.reader.read()).rejects.toThrow('connection failed');
    second.socket.emit('error', new Error('connection failed'));
    await failed;
  });

  it('finishes a pending read on close or disposal and removes its listeners', async () => {
    const { reader, socket } = create();
    const pending = reader.read();
    reader.dispose();
    await expect(pending).resolves.toBeUndefined();
    expect(socket.listenerCount('data')).toBe(0);
    expect(socket.listenerCount('error')).toBe(0);
    await expect(reader.read()).resolves.toBeUndefined();
    const closed = create();
    const other = closed.reader.read();
    closed.socket.emit('close');
    await expect(other).resolves.toBeUndefined();
  });

  it('expires idle connections without a heartbeat or backend operation', async () => {
    vi.useFakeTimers();
    const { reader, socket } = create();
    const pending = expect(reader.read()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(socket.destroyed).toBe(true);
  });

  it('does not extend the frame deadline when more bytes arrive', async () => {
    vi.useFakeTimers();
    const { reader, socket } = create();
    const pending = expect(reader.read()).rejects.toThrow('timed out');
    socket.emit('data', Buffer.from([0]));
    await vi.advanceTimersByTimeAsync(9_000);
    socket.emit('data', Buffer.from([0]));
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(socket.destroyed).toBe(true);
  });
});
