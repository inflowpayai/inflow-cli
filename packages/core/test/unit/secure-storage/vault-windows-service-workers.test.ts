import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeVaultIpcMessage } from '../../../src/secure-storage/vault-ipc.js';

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
  const handleVaultIpcRequest = vi.fn((request: { id: string }) =>
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
    accept: vi.fn(),
    close: vi.fn(),
    completeServiceStop: vi.fn(),
    markServiceReady: vi.fn(),
    read: vi.fn(),
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

describe('Windows vault service workers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workers.length = 0;
    mocks.state.workerMessage = undefined;
  });

  it('accepts one verified request, clears transferred bytes, writes the response, and exits on stop', async () => {
    const connection = {
      connection: {},
      peer: { path: 'C:\\Program Files\\InFlow\\inflow.exe', pid: 42, principal: 'S-1-5-21-1000', uid: 0 },
    };
    const request = encodeVaultIpcMessage({
      id: 'request',
      method: 'vault.status',
      params: {},
      version: 1,
    });
    mocks.transport.accept.mockReturnValueOnce(connection).mockImplementationOnce(() => {
      throw new Error('cancelled');
    });
    mocks.transport.read.mockReturnValue(request);
    mocks.transport.serviceControlState.mockReturnValue({ lockRequested: false, stopRequested: true });

    await runWindowsVaultWorker({ buildId: null, cliVersion: null, role: 'pipe' }, new URL('file:///inflow.js'));

    expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({ type: 'ready' });
    const transferCall = mocks.parentPort.postMessage.mock.calls.find(([message]) => isRequest(message));
    const transferredMessage = transferCall?.[0];
    expect(isRequest(transferredMessage)).toBe(true);
    if (!isRequest(transferredMessage)) throw new Error('expected transferred request');
    expect(transferredMessage.peer).toEqual(connection.peer);
    expect(transferCall?.[1]).toEqual([transferredMessage.frame.buffer]);
    expect(request.every((byte) => byte === 0)).toBe(true);
    expect(mocks.transport.write).toHaveBeenCalledOnce();
  });

  it('closes a connection for a malformed worker response before stopping', async () => {
    const connection = {
      connection: {},
      peer: { path: 'C:\\Program Files\\InFlow\\inflow.exe', pid: 42, principal: 'S-1-5-21-1000', uid: 0 },
    };
    const request = Buffer.from(
      encodeVaultIpcMessage({
        id: 'request',
        method: 'vault.status',
        params: {},
        version: 1,
      }),
    );
    mocks.parentPort.postMessage
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        queueMicrotask(() => mocks.parentPort.emit('message', { type: 'invalid' }));
      });
    mocks.transport.accept.mockReturnValueOnce(connection).mockImplementationOnce(() => {
      throw new Error('cancelled');
    });
    mocks.transport.read.mockReturnValue(request);
    mocks.transport.serviceControlState.mockReturnValue({ lockRequested: false, stopRequested: true });

    await runWindowsVaultWorker({ buildId: null, cliVersion: null, role: 'pipe' }, new URL('file:///inflow.js'));

    expect(mocks.transport.close).toHaveBeenCalledWith(connection);
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
    mocks.state.workerMessage = { frame: request, peer, type: 'request' };
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
});

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

function isRequest(value: unknown): value is {
  frame: Uint8Array;
  peer: { path: string; pid: number; principal: string; uid: number };
  type: 'request';
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'request' &&
    'frame' in value &&
    value.frame instanceof Uint8Array &&
    'peer' in value &&
    typeof value.peer === 'object' &&
    value.peer !== null
  );
}
