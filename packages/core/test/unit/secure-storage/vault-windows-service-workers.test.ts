import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeVaultIpcFrame, encodeVaultIpcMessage } from '../../../src/secure-storage/vault-ipc.js';
import type { VerifiedWindowsPipeEvent } from '../../../src/secure-storage/vault-windows-transport.js';

const mocks = vi.hoisted(() => {
  class Emitter {
    private readonly listeners = new Map<string, Array<(message: unknown) => void>>();

    on(event: string, listener: (message: unknown) => void): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: (message: unknown) => void): this {
      const wrapper = (message: unknown): void => {
        this.off(event, wrapper);
        listener(message);
      };
      return this.on(event, wrapper);
    }

    off(event: string, listener: (message: unknown) => void): this {
      const listeners = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        listeners.filter((candidate) => candidate !== listener),
      );
      return this;
    }

    emit(event: string, message: unknown): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(message);
    }
  }

  class Port extends Emitter {
    responseFrame = new Uint8Array([1]);

    readonly postMessage = vi.fn((message: unknown, _transferList?: readonly ArrayBuffer[]) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'request') {
        queueMicrotask(() => {
          this.emit('message', {
            ...message,
            frame: this.responseFrame,
            type: 'response',
          });
        });
      }
    });
  }
  class Worker extends Emitter {
    readonly postMessage = vi.fn<(message: unknown) => void>();
    readonly terminate = vi.fn(() => Promise.resolve(0));

    constructor() {
      super();
      workers.push(this);
      queueMicrotask(() => {
        this.emit('message', { type: 'ready' });
        if (state.workerMessage !== undefined) this.emit('message', state.workerMessage);
      });
    }
  }
  const state: { workerMessage: unknown } = { workerMessage: undefined };
  const backend = {};
  const manager = {
    backendForPeer: vi.fn(() => backend),
    close: vi.fn(() => Promise.resolve()),
    lockForSleep: vi.fn(() => Promise.resolve()),
  };
  const handleVaultIpcRequest = vi.fn((_backend: unknown, request: { id: string; params?: Record<string, unknown> }) =>
    Promise.resolve({
      id: request.id,
      ok: true as const,
      result: { lock_state: 'locked' as const },
      version: 1 as const,
    }),
  );
  const hardenVaultDaemonProcess = vi.fn();
  const parentPort = new Port();
  const transport = {
    startDispatcher: vi.fn<(path: string, callback: (event: VerifiedWindowsPipeEvent) => void) => void>(),
    stopDispatcher: vi.fn(),
    dispatcherState: vi.fn(),
    respond: vi.fn(),
    accept: vi.fn(),
    close: vi.fn(),
    completeServiceStop: vi.fn(),
    markServiceReady: vi.fn(),
    read: vi.fn(),
    requestServiceStop: vi.fn(),
    serviceControlState: vi.fn(),
    write: vi.fn(),
  };
  const workers: Worker[] = [];
  return {
    backend,
    handleVaultIpcRequest,
    hardenVaultDaemonProcess,
    manager,
    parentPort,
    state,
    transport,
    Worker,
    workers,
  };
});

vi.mock('node:worker_threads', () => ({
  parentPort: mocks.parentPort,
  Worker: mocks.Worker,
}));
vi.mock('../../../src/secure-storage/vault-tenant-manager.js', () => ({
  MultiTenantVaultBackendManager: class {
    backendForPeer = mocks.manager.backendForPeer;
    close = mocks.manager.close;
    lockForSleep = mocks.manager.lockForSleep;
  },
}));
vi.mock('../../../src/secure-storage/vault-daemon-handler.js', () => ({
  handleVaultIpcRequest: mocks.handleVaultIpcRequest,
}));
vi.mock('../../../src/secure-storage/vault-protected-key.js', () => ({
  hardenVaultDaemonProcess: mocks.hardenVaultDaemonProcess,
}));
vi.mock('../../../src/secure-storage/vault-windows-transport.js', () => ({
  createPackagedWindowsVaultTransport: () => mocks.transport,
}));

import { runWindowsVaultWorker } from '../../../src/secure-storage/vault-windows-service.js';

const running: Promise<void>[] = [];
const gates: Array<() => void> = [];
let requestNumber = 0;

describe('Windows vault service workers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transport.startDispatcher.mockReset();
    mocks.transport.dispatcherState.mockReturnValue({ running: true, error: 0 });
    mocks.transport.serviceControlState.mockReturnValue({ lockRequested: false, stopRequested: false });
    mocks.parentPort.responseFrame = new Uint8Array([1]);
    requestNumber = 0;
    mocks.workers.length = 0;
    mocks.state.workerMessage = undefined;
    mocks.transport.serviceControlState.mockReset().mockReturnValue({ lockRequested: false, stopRequested: false });
    mocks.transport.requestServiceStop.mockReset();
    mocks.transport.markServiceReady.mockReset();
    mocks.manager.close.mockReset().mockResolvedValue();
    mocks.manager.lockForSleep.mockReset().mockResolvedValue();
    mocks.hardenVaultDaemonProcess.mockReset();
    mocks.handleVaultIpcRequest
      .mockReset()
      .mockImplementation((_backend, request) =>
        Promise.resolve({ id: request.id, ok: true, result: { lock_state: 'locked' }, version: 1 }),
      );
  });

  afterEach(async () => {
    for (const release of gates.splice(0)) release();
    mocks.transport.serviceControlState.mockReturnValue({ lockRequested: false, stopRequested: true });
    await Promise.allSettled(running.splice(0));
  });

  it('routes native requests and clears transferred response bytes on stop', async () => {
    const message = requestMessage('native');
    mocks.transport.startDispatcher.mockImplementation((_path, callback) => {
      queueMicrotask(() => {
        callback(message);
        queueMicrotask(() => mocks.parentPort.emit('message', { type: 'stop' }));
      });
    });
    mocks.transport.serviceControlState.mockReturnValue({ lockRequested: false, stopRequested: true });
    await runWindowsVaultWorker({ buildId: null, cliVersion: null, role: 'pipe' }, new URL('file:///inflow.js'));
    expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({ type: 'ready' });
    expect(mocks.transport.respond).toHaveBeenCalledOnce();
    expect(mocks.parentPort.responseFrame.every((byte) => byte === 0)).toBe(true);
    expect(mocks.transport.stopDispatcher).toHaveBeenCalled();
    expect(mocks.transport.serviceControlState).not.toHaveBeenCalled();
  });

  it('stops the dispatcher on a malformed runtime response', async () => {
    mocks.transport.startDispatcher.mockImplementation(() => {
      queueMicrotask(() => mocks.parentPort.emit('message', { type: 'invalid' }));
    });
    await expect(
      runWindowsVaultWorker({ buildId: null, cliVersion: null, role: 'pipe' }, new URL('file:///inflow.js')),
    ).rejects.toThrow('response is malformed');
    expect(mocks.transport.stopDispatcher).toHaveBeenCalled();
  });

  it('fails closed if the native dispatcher stops without a service stop', async () => {
    mocks.transport.dispatcherState.mockReturnValue({ running: false, error: 1 });
    await expect(
      runWindowsVaultWorker({ buildId: null, cliVersion: null, role: 'pipe' }, new URL('file:///inflow.js')),
    ).rejects.toThrow('dispatcher stopped unexpectedly');
    expect(mocks.transport.stopDispatcher).toHaveBeenCalledOnce();
  });

  it('marks runtime readiness, applies lock control, and completes a clean stop', async () => {
    const request = encodeVaultIpcMessage({
      id: 'runtime-request',
      method: 'vault.status',
      params: {},
      version: 1,
    });
    const peer = {
      path: 'C:\\Program Files\\InFlow\\inflow.exe',
      pid: 42,
      principal: 'S-1-5-21-1000',
      uid: 0,
    };
    mocks.state.workerMessage = { slot: 0, generation: 1, sequence: 1, frame: request, peer, type: 'request' };
    mocks.transport.serviceControlState.mockReturnValueOnce({ lockRequested: true, stopRequested: true });

    await runWindowsVaultWorker(
      { buildId: 'build', cliVersion: '1.2.3', role: 'runtime' },
      new URL('file:///inflow.js'),
    );

    expect(mocks.transport.markServiceReady).toHaveBeenCalledOnce();
    expect(mocks.hardenVaultDaemonProcess).toHaveBeenCalledOnce();
    expect(mocks.manager.backendForPeer).toHaveBeenCalledWith(peer);
    expect(mocks.handleVaultIpcRequest).toHaveBeenCalledWith(
      mocks.backend,
      expect.objectContaining({ id: 'runtime-request', method: 'vault.status' }),
      expect.objectContaining({ buildId: 'build', cliVersion: '1.2.3' }),
      { allowDaemonShutdown: false },
    );
    expect(mocks.workers[0]?.postMessage.mock.calls.some(([message]) => isResponse(message))).toBe(true);
    expect(mocks.manager.lockForSleep).toHaveBeenCalledOnce();
    expect(mocks.workers[0]?.terminate).toHaveBeenCalledOnce();
    expect(mocks.manager.close).toHaveBeenCalledOnce();
    expect(mocks.transport.completeServiceStop).toHaveBeenCalledOnce();
  });

  it('returns a stable corruption response when a pipe sends a response frame as a request', async () => {
    mocks.state.workerMessage = {
      slot: 0,
      generation: 1,
      sequence: 1,
      frame: encodeVaultIpcMessage({
        id: 'malformed-request',
        ok: true,
        result: { lock_state: 'locked' },
        version: 1,
      }),
      peer: {
        path: 'C:\\Program Files\\InFlow\\inflow.exe',
        pid: 42,
        principal: 'S-1-5-21-1000',
        uid: 0,
      },
      type: 'request',
    };
    mocks.transport.serviceControlState.mockReturnValueOnce({
      lockRequested: false,
      stopRequested: true,
    });

    await runWindowsVaultWorker({ buildId: null, cliVersion: null, role: 'runtime' }, new URL('file:///inflow.js'));

    expect(mocks.handleVaultIpcRequest).not.toHaveBeenCalled();
    expect(mocks.workers[0]?.postMessage.mock.calls.some(([message]) => isResponse(message))).toBe(true);
    expect(mocks.transport.completeServiceStop).toHaveBeenCalledOnce();
  });

  it('serializes one user, resolves its backend at execution, and lets a different user proceed', async () => {
    const first = deferred();
    mocks.handleVaultIpcRequest.mockImplementation(async (_backend, request) => {
      if (request.id === 'first') await first.promise;
      return { id: request.id, ok: true, result: { lock_state: 'locked' }, version: 1 };
    });
    const { worker, finish } = startRuntime();
    worker.emit('message', requestMessage('first'));
    worker.emit('message', requestMessage('second'));
    worker.emit('message', requestMessage('other', 'S-1-5-21-2000'));
    await vi.waitFor(() => expect(mocks.handleVaultIpcRequest).toHaveBeenCalledTimes(2));
    expect(mocks.handleVaultIpcRequest.mock.calls.map(([, request]) => request.id)).toEqual(['first', 'other']);
    expect(mocks.manager.backendForPeer).toHaveBeenCalledTimes(2);
    first.resolve();
    await vi.waitFor(() => expect(mocks.handleVaultIpcRequest).toHaveBeenCalledTimes(3));
    expect(mocks.handleVaultIpcRequest.mock.calls[2]?.[1].id).toBe('second');
    expect(mocks.manager.backendForPeer).toHaveBeenCalledTimes(3);
    await finish();
  });

  it('drains an active operation and discards queued mutations before closing the manager', async () => {
    const first = deferred();
    mocks.handleVaultIpcRequest.mockImplementation(async (_backend, request) => {
      await first.promise;
      return { id: request.id, ok: true, result: { lock_state: 'locked' }, version: 1 };
    });
    const { worker, finish } = startRuntime();
    const queued = requestMessage('queued');
    worker.emit('message', requestMessage('active'));
    worker.emit('message', queued);
    await vi.waitFor(() => expect(mocks.handleVaultIpcRequest).toHaveBeenCalledOnce());
    const stopped = finish();
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
    expect(mocks.manager.close).not.toHaveBeenCalled();
    const late = requestMessage('late');
    worker.emit('message', late);
    expect(late.frame.every((byte) => byte === 0)).toBe(true);
    first.resolve();
    await stopped;
    expect(mocks.handleVaultIpcRequest).toHaveBeenCalledOnce();
    expect(queued.frame.every((byte) => byte === 0)).toBe(true);
    expect(mocks.manager.close).toHaveBeenCalledOnce();
    expect(mocks.transport.requestServiceStop).toHaveBeenCalledOnce();
    expect(mocks.transport.completeServiceStop).toHaveBeenCalledOnce();
  });

  it('rejects excess admission while retaining the bound for active and queued operations', async () => {
    const first = deferred();
    mocks.handleVaultIpcRequest.mockImplementation(async (_backend, request) => {
      if (request.id === '0') await first.promise;
      return { id: request.id, ok: true, result: { lock_state: 'locked' }, version: 1 };
    });
    const { worker, finish } = startRuntime();
    const responses: unknown[] = [];
    worker.postMessage.mockImplementation((message) => {
      if (hasFrame(message)) responses.push(decodeVaultIpcFrame(Buffer.from(message.frame)));
    });
    worker.emit('message', requestMessage('0'));
    await vi.waitFor(() => expect(mocks.handleVaultIpcRequest).toHaveBeenCalledOnce());
    for (let index = 1; index < 33; index++) worker.emit('message', requestMessage(String(index)));
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(responses[0]).toMatchObject({
      id: '32',
      ok: false,
      error: { code: 'secure_storage_unavailable' },
    });
    expect(mocks.handleVaultIpcRequest).toHaveBeenCalledOnce();
    first.resolve();
    await vi.waitFor(() => expect(responses).toHaveLength(32));
    expect(mocks.handleVaultIpcRequest).toHaveBeenCalledTimes(32);
    worker.emit('message', requestMessage('after-capacity'));
    await vi.waitFor(() => expect(mocks.handleVaultIpcRequest).toHaveBeenCalledTimes(33));
    await finish();
  });

  it('clears decoded credentials after handler failure and releases the user queue', async () => {
    let decoded: Record<string, unknown> | undefined;
    mocks.handleVaultIpcRequest.mockImplementationOnce((_backend, request) => {
      decoded = request.params;
      throw new Error('backend failed');
    });
    const { worker, finish } = startRuntime();
    const frame = encodeVaultIpcMessage({
      id: 'secret',
      method: 'secret.put',
      params: { value: Uint8Array.from([1, 2, 3]) },
      version: 1,
    });
    worker.emit('message', { ...requestMessage('secret'), frame });
    worker.emit('message', requestMessage('after-error'));
    await vi.waitFor(() => expect(mocks.handleVaultIpcRequest).toHaveBeenCalledTimes(2));
    expect(decoded?.['value']).toEqual(Buffer.from([0, 0, 0]));
    expect(frame.every((byte) => byte === 0)).toBe(true);
    await finish();
  });

  it('orders sleep locking after active work and before requests admitted during the lock', async () => {
    const first = deferred();
    const lock = deferred();
    const order: string[] = [];
    mocks.handleVaultIpcRequest.mockImplementation(async (_backend, request) => {
      order.push(request.id);
      if (request.id === 'first') await first.promise;
      return { id: request.id, ok: true, result: { lock_state: 'locked' }, version: 1 };
    });
    mocks.manager.lockForSleep.mockImplementation(async () => {
      order.push('lock');
      await lock.promise;
    });
    const { worker, finish } = startRuntime();
    worker.emit('message', requestMessage('first'));
    await vi.waitFor(() => expect(order).toEqual(['first']));
    let observed = false;
    mocks.transport.serviceControlState.mockImplementationOnce(() => {
      observed = true;
      return { lockRequested: true, stopRequested: false };
    });
    await vi.waitFor(() => expect(observed).toBe(true));
    worker.emit('message', requestMessage('second', 'S-1-5-21-2000'));
    first.resolve();
    await vi.waitFor(() => expect(order).toEqual(['first', 'lock']));
    lock.resolve();
    await vi.waitFor(() => expect(order).toEqual(['first', 'lock', 'second']));
    await finish();
  });

  it('cleans up after a pipe worker failure instead of leaving the service runtime waiting', async () => {
    const { worker, completion } = startRuntime();
    const rejected = expect(completion).rejects.toThrow('pipe failed');
    worker.emit('error', new Error('pipe failed'));
    await rejected;
    expect(mocks.manager.close).toHaveBeenCalledOnce();
    expect(mocks.transport.completeServiceStop).toHaveBeenCalledOnce();
  });

  it('wipes a response whose transfer fails and stops the runtime', async () => {
    const { worker, completion } = startRuntime();
    const rejected = expect(completion).rejects.toThrow('transfer failed');
    let response: Uint8Array | undefined;
    worker.postMessage.mockImplementation((message) => {
      if (hasFrame(message)) response = message.frame;
      throw new Error('transfer failed');
    });
    worker.emit('message', requestMessage('failure'));
    await rejected;
    expect(response?.every((byte) => byte === 0)).toBe(true);
    expect(mocks.manager.close).toHaveBeenCalledOnce();
  });

  it('treats unexpected pipe exit as a runtime failure', async () => {
    const { worker, completion } = startRuntime();
    const rejected = expect(completion).rejects.toThrow('The Windows vault pipe worker stopped unexpectedly.');
    worker.emit('exit', 1);
    await rejected;
    expect(mocks.manager.close).toHaveBeenCalledOnce();
  });

  it('stops admission immediately after a worker error, including queued operations', async () => {
    const gate = deferred();
    mocks.handleVaultIpcRequest.mockImplementation(async (_backend, request) => {
      await gate.promise;
      return { id: request.id, ok: true, result: { lock_state: 'locked' }, version: 1 };
    });
    const { worker, completion } = startRuntime();
    const rejected = expect(completion).rejects.toThrow('pipe failed');
    worker.emit('message', requestMessage('active'));
    worker.emit('message', requestMessage('queued'));
    await vi.waitFor(() => expect(mocks.handleVaultIpcRequest).toHaveBeenCalledOnce());
    worker.emit('error', new Error('pipe failed'));
    const late = requestMessage('late');
    worker.emit('message', late);
    expect(late.frame.every((byte) => byte === 0)).toBe(true);
    gate.resolve();
    await rejected;
    expect(mocks.handleVaultIpcRequest).toHaveBeenCalledOnce();
  });

  it('cleans up after readiness failure', async () => {
    mocks.transport.markServiceReady.mockImplementation(() => {
      throw new Error('readiness failed');
    });
    const { completion } = startRuntime();
    await expect(completion).rejects.toThrow('readiness failed');
    expect(mocks.manager.close).toHaveBeenCalledOnce();
    expect(mocks.transport.completeServiceStop).toHaveBeenCalledOnce();
  });

  it('still terminates workers and closes storage when hardening fails', async () => {
    mocks.hardenVaultDaemonProcess.mockImplementation(() => {
      throw new Error('hardening failed');
    });
    const { worker, completion } = startRuntime();
    await expect(completion).rejects.toThrow('hardening failed');
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(mocks.manager.close).toHaveBeenCalledOnce();
    expect(mocks.transport.completeServiceStop).toHaveBeenCalledOnce();
  });

  it('does not run requests behind a failed sleep-lock barrier', async () => {
    const lock = deferred();
    mocks.manager.lockForSleep.mockImplementation(async () => {
      await lock.promise;
      throw new Error('sleep lock failed');
    });
    const { worker, completion } = startRuntime();
    const rejected = expect(completion).rejects.toThrow('sleep lock failed');
    mocks.transport.serviceControlState.mockReturnValueOnce({ lockRequested: true, stopRequested: false });
    await vi.waitFor(() => expect(mocks.manager.lockForSleep).toHaveBeenCalledOnce());
    const queued = requestMessage('queued');
    worker.emit('message', queued);
    lock.resolve();
    await rejected;
    expect(mocks.handleVaultIpcRequest).not.toHaveBeenCalled();
    expect(queued.frame.every((byte) => byte === 0)).toBe(true);
    expect(mocks.manager.close).toHaveBeenCalledOnce();
  });

  it('still terminates the pipe when requesting native cancellation fails', async () => {
    const { worker, finish } = startRuntime();
    mocks.transport.requestServiceStop.mockImplementation(() => {
      throw new Error('stop failed');
    });
    await expect(finish()).rejects.toThrow('stop failed');
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(mocks.manager.close).toHaveBeenCalledOnce();
    expect(mocks.transport.completeServiceStop).toHaveBeenCalledOnce();
  });

  it('closes storage and signals completion after worker termination fails', async () => {
    const { worker, finish } = startRuntime();
    worker.terminate.mockRejectedValueOnce(new Error('termination failed'));
    await expect(finish()).rejects.toThrow('termination failed');
    expect(mocks.manager.close).toHaveBeenCalledOnce();
    expect(mocks.transport.completeServiceStop).toHaveBeenCalledOnce();
  });

  it('signals shutdown completion even if storage closure throws', async () => {
    const { finish } = startRuntime();
    mocks.manager.close.mockRejectedValueOnce(new Error('closure failed'));
    await expect(finish()).rejects.toThrow('closure failed');
    expect(mocks.transport.completeServiceStop).toHaveBeenCalledOnce();
  });

  it('skips disconnected queued work and does not send a late active response to a replacement generation', async () => {
    const gate = deferred();
    mocks.handleVaultIpcRequest.mockImplementation(async (_backend, request) => {
      if (request.id === 'active') await gate.promise;
      return { id: request.id, ok: true, result: { lock_state: 'locked' }, version: 1 };
    });
    const { worker, finish } = startRuntime();
    const active = requestMessage('active');
    const queued = requestMessage('queued');
    worker.emit('message', active);
    await vi.waitFor(() => expect(mocks.handleVaultIpcRequest).toHaveBeenCalledOnce());
    worker.emit('message', queued);
    worker.emit('message', { ...queued, type: 'closed' });
    worker.emit('message', { ...active, type: 'closed' });
    const replacement = { ...requestMessage('replacement'), slot: active.slot, generation: 2 };
    worker.emit('message', replacement);
    worker.emit('message', { ...active, type: 'closed' });
    gate.resolve();
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    expect(mocks.handleVaultIpcRequest.mock.calls.map(([, request]) => request.id)).toEqual(['active', 'replacement']);
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ slot: active.slot, generation: 2, sequence: 1 }),
      expect.any(Array),
    );
    expect(queued.frame.every((byte) => byte === 0)).toBe(true);
    await finish();
  });

  it('accepts the next sequential request on the same connection', async () => {
    const { worker, finish } = startRuntime();
    const first = requestMessage('first');
    worker.emit('message', first);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    worker.emit('message', {
      ...requestMessage('second'),
      slot: first.slot,
      generation: first.generation,
      sequence: 2,
    });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    expect(mocks.handleVaultIpcRequest.mock.calls.map(([, request]) => request.id)).toEqual(['first', 'second']);
    await finish();
  });

  it.each(['duplicate', 'closed', 'old-generation', 'principal', 'skipped-sequence'])(
    'rejects an invalid connection transition: %s',
    async (scenario) => {
      const { worker, completion } = startRuntime();
      const first = { ...requestMessage('first'), generation: 2 };
      worker.emit('message', first);
      await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
      if (scenario === 'closed') worker.emit('message', { ...first, type: 'closed' });
      const invalid = {
        ...requestMessage('invalid'),
        slot: first.slot,
        generation: scenario === 'old-generation' ? 1 : 2,
        sequence: scenario === 'duplicate' ? 1 : scenario === 'skipped-sequence' ? 3 : 2,
      };
      if (scenario === 'principal') invalid.peer.principal = 'S-1-5-21-2000';
      const rejected = expect(completion).rejects.toThrow('out of sequence');
      worker.emit('message', invalid);
      await rejected;
      expect(mocks.handleVaultIpcRequest).toHaveBeenCalledOnce();
      expect(invalid.frame.every((byte) => byte === 0)).toBe(true);
    },
  );

  it('rejects an out-of-range slot and clears its frame before any backend operation', async () => {
    const { worker, completion } = startRuntime();
    const rejected = expect(completion).rejects.toThrow('pipe message is malformed');
    const invalid = { ...requestMessage('invalid'), slot: 32 };
    worker.emit('message', invalid);
    await rejected;
    expect(invalid.frame.every((byte) => byte === 0)).toBe(true);
    expect(mocks.handleVaultIpcRequest).not.toHaveBeenCalled();
  });

  it('rejects another request while the same connection has active work', async () => {
    const gate = deferred();
    mocks.handleVaultIpcRequest.mockImplementation(async (_backend, request) => {
      await gate.promise;
      return { id: request.id, ok: true, result: { lock_state: 'locked' }, version: 1 };
    });
    const { worker, completion } = startRuntime();
    const first = requestMessage('first');
    worker.emit('message', first);
    await vi.waitFor(() => expect(mocks.handleVaultIpcRequest).toHaveBeenCalledOnce());
    const rejected = expect(completion).rejects.toThrow('out of sequence');
    const second = { ...requestMessage('second'), slot: first.slot, sequence: 2 };
    worker.emit('message', second);
    gate.resolve();
    await rejected;
    expect(mocks.handleVaultIpcRequest).toHaveBeenCalledOnce();
    expect(worker.postMessage.mock.calls.some(([message]) => isResponse(message))).toBe(false);
    expect(second.frame.every((byte) => byte === 0)).toBe(true);
  });

  it('requires the first sequence on a fresh connection', async () => {
    const { worker, completion } = startRuntime();
    const rejected = expect(completion).rejects.toThrow('out of sequence');
    worker.emit('message', { ...requestMessage('invalid'), sequence: 2 });
    await rejected;
    expect(mocks.handleVaultIpcRequest).not.toHaveBeenCalled();
  });

  it('clears late responses even when native correlation rejects them', async () => {
    const response = new Uint8Array([1, 2]);
    mocks.transport.startDispatcher.mockImplementation(() => {
      queueMicrotask(() => {
        mocks.parentPort.emit('message', { slot: 0, generation: 99, sequence: 1, frame: response, type: 'response' });
        mocks.parentPort.emit('message', { type: 'stop' });
      });
    });
    mocks.transport.respond.mockReturnValue(false);
    mocks.transport.serviceControlState.mockReturnValue({ lockRequested: false, stopRequested: true });
    await runWindowsVaultWorker({ buildId: null, cliVersion: null, role: 'pipe' }, new URL('file:///inflow.js'));
    expect(mocks.transport.respond).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 99 }),
      expect.any(Buffer),
    );
    expect(response).toEqual(new Uint8Array([0, 0]));
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  gates.push(resolve);
  return { promise, resolve };
}

function requestMessage(id: string, principal = 'S-1-5-21-1000') {
  const number = requestNumber++;
  return {
    slot: number % 32,
    generation: Math.floor(number / 32) + 1,
    sequence: 1,
    frame: encodeVaultIpcMessage({ id, method: 'vault.status', params: {}, version: 1 }),
    peer: { path: 'C:\\Program Files\\InFlow\\inflow.exe', pid: 42, principal, uid: 0 },
    type: 'request' as const,
  };
}

function startRuntime() {
  mocks.transport.serviceControlState.mockReturnValue({ lockRequested: false, stopRequested: false });
  const completion = runWindowsVaultWorker(
    { buildId: null, cliVersion: null, role: 'runtime' },
    new URL('file:///inflow.js'),
  );
  running.push(completion);
  const worker = mocks.workers[0];
  if (worker === undefined) throw new Error('expected pipe worker');
  return {
    worker,
    completion,
    finish: async (): Promise<void> => {
      mocks.transport.serviceControlState.mockReturnValue({ lockRequested: false, stopRequested: true });
      await completion;
    },
  };
}

function hasFrame(value: unknown): value is { frame: Uint8Array } {
  return typeof value === 'object' && value !== null && 'frame' in value && value.frame instanceof Uint8Array;
}

function isResponse(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'response' &&
    'frame' in value &&
    value.frame instanceof Uint8Array
  );
}
