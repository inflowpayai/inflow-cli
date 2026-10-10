import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultControlConnection } from '../../../src/secure-storage/vault-control-connection.js';
import {
  decodeVaultIpcFrame,
  encodeVaultIpcMessage,
  type VaultIpcRequest,
} from '../../../src/secure-storage/vault-ipc.js';
import type { VaultSocketPeerVerifier } from '../../../src/secure-storage/vault-peer-verifier.js';
import { VaultSocketReader } from '../../../src/secure-storage/vault-socket-reader.js';
import { startLocalVaultDaemon } from '../../../src/secure-storage/vault-daemon.js';

const peer = { path: '/test/inflow', pid: 123, uid: 501 };

function request(id: string, params: Record<string, unknown> = {}): VaultIpcRequest {
  return { id, method: 'vault.status', params, version: 1 };
}

describe('vault control connection', () => {
  const cleanup: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const close of cleanup.reverse()) await close();
    cleanup.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function setup(
    respond: (message: VaultIpcRequest, socket: Socket) => void = (message, socket) => {
      socket.write(encodeVaultIpcMessage({ id: message.id, ok: true, result: {}, version: 1 }));
    },
    verifier: VaultSocketPeerVerifier | undefined = vi.fn(() => peer),
  ): Promise<{
    client: VaultControlConnection;
    received: VaultIpcRequest[];
    sockets: Set<Socket>;
    verify: ReturnType<typeof vi.fn>;
  }> {
    const directory = mkdtempSync(join(tmpdir(), 'vault-control-'));
    cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
    const path = join(directory, 'control.sock');
    const sockets = new Set<Socket>();
    const received: VaultIpcRequest[] = [];
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      const reader = new VaultSocketReader(socket);
      socket.on('close', () => {
        sockets.delete(socket);
        reader.dispose();
      });
      void (async () => {
        while (!socket.destroyed) {
          const frame = await reader.read();
          if (frame === undefined) return;
          const message = decodeVaultIpcFrame(frame);
          frame.fill(0);
          if (!('method' in message)) throw new Error('Expected request');
          received.push(message);
          respond(message, socket);
        }
      })().catch(() => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
    const verify = vi.fn(() => verifier);
    const client = new VaultControlConnection(path, verify);
    cleanup.push(() => client.dispose());
    return { client, received, sockets, verify };
  }

  it('serializes requests over one verified connection without changing caller buffers', async () => {
    const verifier = vi.fn(() => peer);
    const { client, received, verify } = await setup(undefined, verifier);
    const payload = Buffer.from('caller owned');
    const replies = await Promise.all(
      Array.from({ length: 12 }, (_, index) => client.request(request(String(index), { payload }))),
    );
    expect(replies.map((reply) => reply.id)).toEqual(Array.from({ length: 12 }, (_, index) => String(index)));
    expect(received).toHaveLength(12);
    expect(payload.toString()).toBe('caller owned');
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  it('does not send request bytes when authentication fails', async () => {
    const { client, received } = await setup(undefined, () => {
      throw new Error('peer rejected');
    });
    await expect(client.request(request('a'))).rejects.toThrow('peer rejected');
    expect(received).toHaveLength(0);
  });

  it('prepares the verifier before opening a socket', async () => {
    const connect = vi.spyOn(Socket.prototype, 'connect');
    const client = new VaultControlConnection('/unused-vault.sock', () => {
      expect(connect).not.toHaveBeenCalled();
      throw new Error('native module rejected');
    });
    cleanup.push(() => client.dispose());
    await expect(client.request(request('a'))).rejects.toThrow('native module rejected');
    expect(connect).not.toHaveBeenCalled();
  });

  it('does not replay a request after the peer closes without a response', async () => {
    const { client, received, verify } = await setup((message, socket) => {
      if (message.id === 'a') socket.destroy();
      else socket.write(encodeVaultIpcMessage({ id: message.id, ok: true, result: {}, version: 1 }));
    });
    await expect(client.request(request('a'))).rejects.toThrow('closed');
    await expect(client.request(request('b'))).resolves.toMatchObject({ id: 'b', ok: true });
    expect(received.map((message) => message.id)).toEqual(['a', 'b']);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it.each(['wrong-id', 'request', 'coalesced'])('rejects %s responses', async (mode) => {
    const { client } = await setup((message, socket) => {
      const frame = encodeVaultIpcMessage(
        mode === 'request'
          ? request(message.id)
          : { id: mode === 'wrong-id' ? 'other' : message.id, ok: true, result: {}, version: 1 },
      );
      socket.write(mode === 'coalesced' ? Buffer.concat([frame, frame]) : frame);
    });
    await expect(client.request(request('a'))).rejects.toThrow(mode === 'coalesced' ? 'sequential' : 'malformed');
  });

  it('bounds the waiting queue by count', async () => {
    const { client, received } = await setup(() => undefined);
    const pending = Array.from({ length: 33 }, (_, index) =>
      expect(client.request(request(String(index)))).rejects.toThrow('closed'),
    );
    await expect(client.request(request('overflow'))).rejects.toMatchObject({ code: 'vault_daemon_busy' });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    client.dispose();
    await Promise.all(pending);
    client.dispose();
    await expect(client.request(request('disposed'))).rejects.toThrow('closed');
    expect(received).toHaveLength(1);
  });

  it('bounds waiting encoded bytes independently of count', async () => {
    const { client } = await setup(() => undefined);
    const active = expect(client.request(request('a'))).rejects.toThrow('closed');
    const waiting = expect(client.request(request('b', { text: 'x'.repeat(600_000) }))).rejects.toThrow('closed');
    await expect(client.request(request('c', { text: 'x'.repeat(600_000) }))).rejects.toMatchObject({
      code: 'vault_daemon_busy',
    });
    client.dispose();
    await Promise.all([active, waiting]);
  });

  it('times out without replay and authenticates the next connection', async () => {
    const { client, received, verify } = await setup((message, socket) => {
      if (message.id !== 'a') socket.write(encodeVaultIpcMessage({ id: message.id, ok: true, result: {}, version: 1 }));
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = expect(client.request(request('a'))).rejects.toThrow('timed out');
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    await expect(client.request(request('b'))).resolves.toMatchObject({ id: 'b' });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(received.map((message) => message.id)).toEqual(['a', 'b']);
  });

  it('does not let a late verifier write to or close a replacement connection', async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { client, received } = await setup(undefined, async () => {
      if (++calls === 1) await blocked;
      return peer;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = expect(client.request(request('a'))).rejects.toThrow('timed out');
    await vi.waitFor(() => expect(calls).toBe(1));
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    await expect(client.request(request('b'))).resolves.toMatchObject({ id: 'b' });
    release();
    await expect(client.request(request('c'))).resolves.toMatchObject({ id: 'c' });
    expect(received.map((message) => message.id)).toEqual(['b', 'c']);
    expect(calls).toBe(2);
  });

  it('closes idle connections and verifies again for later requests', async () => {
    const { client, verify } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await client.request(request('a'));
    await vi.advanceTimersByTimeAsync(60_000);
    await client.request(request('b'));
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('reports a failed connection without leaking pending work', async () => {
    const client = new VaultControlConnection('/no-such-directory/vault.sock', () => undefined);
    cleanup.push(() => client.dispose());
    await expect(client.request(request('a'))).rejects.toThrow('ENOENT');
  });

  it.each(['vault.reset', 'daemon.shutdown'] as const)('retires the connection after successful %s', async (method) => {
    const { client, verify, received } = await setup();
    await client.request({ ...request('terminal'), method });
    await client.request(request('after'));
    expect(verify).toHaveBeenCalledTimes(2);
    expect(received.map((message) => message.id)).toEqual(['terminal', 'after']);
  });

  it('does not retire a connection when a terminal operation is rejected', async () => {
    const { client, verify } = await setup((message, socket) => {
      socket.write(
        encodeVaultIpcMessage({
          id: message.id,
          ok: false,
          error: { code: 'secure_storage_unavailable', message: 'not permitted' },
          version: 1,
        }),
      );
    });
    await client.request({ ...request('terminal'), method: 'daemon.shutdown' });
    await client.request(request('after'));
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('never dispatches queued requests whose deadline has elapsed', async () => {
    const { client, received } = await setup(() => undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const pending = Array.from({ length: 4 }, (_, index) =>
      expect(client.request(request(String(index)))).rejects.toThrow('timed out'),
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(pending);
    expect(received).toHaveLength(1);
  });

  it('checks elapsed time after a synchronous verifier returns', async () => {
    const { client, received } = await setup(undefined, () => {
      vi.spyOn(performance, 'now').mockReturnValue(20_000);
      return peer;
    });
    vi.spyOn(performance, 'now').mockReturnValue(0);
    await expect(client.request(request('a'))).rejects.toThrow('timed out');
    expect(received).toHaveLength(0);
  });

  it('returns application errors without reconnecting or caching authorization', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'vault-control-real-'));
    cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
    const daemon = await startLocalVaultDaemon({ rootDirectory: directory });
    cleanup.push(() => daemon.close());
    const verify = vi.fn(() => undefined);
    const client = new VaultControlConnection(daemon.socketPath, verify);
    const other = new VaultControlConnection(daemon.socketPath, () => undefined);
    cleanup.push(() => {
      client.dispose();
      other.dispose();
    });
    await expect(
      client.request({
        ...request('unlock'),
        method: 'vault.unlock',
        params: { salt: Buffer.alloc(16), wrappingKey: Buffer.alloc(32) },
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(client.request(request('before'))).resolves.toMatchObject({ result: { lockState: 'unlocked' } });
    await other.request({ ...request('lock'), method: 'vault.lock' });
    await expect(client.request(request('after'))).resolves.toMatchObject({ result: { lockState: 'locked' } });
    await expect(
      client.request({
        ...request('put'),
        method: 'secret.put',
        params: { expectedKind: 'inflow_api_key', payload: Buffer.from('not stored') },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'vault_locked' } });
    await expect(client.request(request('still-connected'))).resolves.toMatchObject({
      result: { lockState: 'locked' },
    });
    expect(verify).toHaveBeenCalledTimes(1);
  });
});
