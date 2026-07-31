import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class Worker {
    readonly listeners = new Map<string, Array<(...arguments_: unknown[]) => void>>();
    readonly terminate = vi.fn(() => Promise.resolve(0));

    constructor(
      readonly entry: URL,
      readonly options: { workerData: unknown },
    ) {
      workers.push(this);
    }

    emit(event: string, ...arguments_: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...arguments_);
      this.listeners.delete(event);
    }

    on(event: string, listener: (...arguments_: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: (...arguments_: unknown[]) => void): this {
      return this.on(event, listener);
    }
  }
  const workers: Worker[] = [];
  const transport = {
    completeServiceStop: vi.fn(),
    markServiceReady: vi.fn(),
    runServiceDispatcher: vi.fn(),
    serviceControlState: vi.fn(),
  };
  return { transport, Worker, workers };
});

vi.mock('node:worker_threads', () => ({
  parentPort: null,
  Worker: mocks.Worker,
}));
vi.mock('../../../src/secure-storage/vault-windows-transport.js', () => ({
  createPackagedWindowsVaultTransport: () => mocks.transport,
}));

import {
  isWindowsVaultWorkerData,
  runWindowsVaultService,
  runWindowsVaultWorker,
} from '../../../src/secure-storage/vault-windows-service.js';

describe('Windows vault service orchestration', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workers.length = 0;
    mocks.transport.serviceControlState.mockReturnValue({ lockRequested: false, stopRequested: false });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('recognizes only complete Windows worker data', () => {
    expect(isWindowsVaultWorkerData({ buildId: null, cliVersion: null, role: 'pipe' })).toBe(true);
    expect(isWindowsVaultWorkerData({ buildId: 'build', cliVersion: '1.2.3', role: 'runtime' })).toBe(true);
    expect(isWindowsVaultWorkerData(null)).toBe(false);
    expect(isWindowsVaultWorkerData({ buildId: 1, cliVersion: null, role: 'pipe' })).toBe(false);
    expect(isWindowsVaultWorkerData({ buildId: null, cliVersion: 1, role: 'pipe' })).toBe(false);
    expect(isWindowsVaultWorkerData({ buildId: null, cliVersion: null, role: 'other' })).toBe(false);
  });

  it('rejects service execution outside Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    await expect(runWindowsVaultService(new URL('file:///inflow.js'))).rejects.toThrow(
      'The Windows vault service is available only on Windows.',
    );
  });

  it('starts the runtime worker, runs the dispatcher, and terminates after runtime exit', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mocks.transport.runServiceDispatcher.mockImplementation(() => {
      queueMicrotask(() => mocks.workers[0]?.emit('exit', 0));
    });

    await runWindowsVaultService(new URL('file:///inflow.js'), { buildId: 'build', cliVersion: '1.2.3' });

    expect(mocks.workers).toHaveLength(1);
    expect(mocks.workers[0]?.options.workerData).toEqual({
      buildId: 'build',
      cliVersion: '1.2.3',
      role: 'runtime',
    });
    expect(mocks.transport.runServiceDispatcher).toHaveBeenCalledOnce();
    expect(mocks.workers[0]?.terminate).toHaveBeenCalledOnce();
  });

  it('terminates the runtime worker when the dispatcher fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mocks.transport.runServiceDispatcher.mockImplementation(() => {
      throw new Error('dispatcher failed');
    });

    await expect(runWindowsVaultService(new URL('file:///inflow.js'))).rejects.toThrow('dispatcher failed');
    expect(mocks.workers[0]?.terminate).toHaveBeenCalledOnce();
  });

  it('fails closed when a pipe or runtime worker has no parent port', async () => {
    await expect(
      runWindowsVaultWorker({ buildId: null, cliVersion: null, role: 'pipe' }, new URL('file:///inflow.js')),
    ).rejects.toThrow('The Windows vault pipe worker requires a parent port.');
    await expect(
      runWindowsVaultWorker({ buildId: null, cliVersion: null, role: 'runtime' }, new URL('file:///inflow.js')),
    ).rejects.toThrow('The Windows vault runtime worker requires a parent port.');
  });
});
