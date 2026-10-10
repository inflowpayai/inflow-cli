import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import path from 'node:path';
import process from 'node:process';
import { parentPort, Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { SecureStorageError } from './errors.js';
import { handleVaultIpcRequest } from './vault-daemon-handler.js';
import {
  clearVaultIpcBytes,
  decodeVaultIpcFrame,
  encodeVaultIpcMessage,
  type VaultIpcMessage,
  type VaultIpcResponse,
} from './vault-ipc.js';
import { hardenVaultDaemonProcess } from './vault-protected-key.js';
import { MultiTenantVaultBackendManager } from './vault-tenant-manager.js';
import { createPackagedWindowsVaultTransport } from './vault-windows-transport.js';

export interface WindowsVaultWorkerData {
  buildId: string | null;
  cliVersion: string | null;
  role: 'pipe' | 'runtime';
}

export interface WindowsVaultServiceOptions {
  buildId?: string;
  cliVersion?: string;
}

interface PipeRequestIdentity {
  slot: number;
  generation: number;
  sequence: number;
}

export function isWindowsVaultWorkerData(value: unknown): value is WindowsVaultWorkerData {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<WindowsVaultWorkerData>;
  return (
    (candidate.role === 'pipe' || candidate.role === 'runtime') &&
    (candidate.buildId === null || typeof candidate.buildId === 'string') &&
    (candidate.cliVersion === null || typeof candidate.cliVersion === 'string')
  );
}

export async function runWindowsVaultWorker(data: WindowsVaultWorkerData, entryUrl: URL): Promise<void> {
  if (data.role === 'pipe') {
    await runPipeWorker();
    return;
  }
  await runRuntimeWorker(data, entryUrl);
}

export async function runWindowsVaultService(entryUrl: URL, options: WindowsVaultServiceOptions = {}): Promise<void> {
  if (process.platform !== 'win32') throw new Error('The Windows vault service is available only on Windows.');
  const data: WindowsVaultWorkerData = {
    buildId: options.buildId ?? null,
    cliVersion: options.cliVersion ?? null,
    role: 'runtime',
  };
  const runtime = new Worker(entryUrl, { workerData: data });
  const transport = createPackagedWindowsVaultTransport();
  const runtimeExit = once(runtime, 'exit');
  try {
    transport.runServiceDispatcher();
    await runtimeExit;
  } finally {
    try {
      transport.requestServiceStop();
    } finally {
      await runtime.terminate();
    }
  }
}

async function runPipeWorker(): Promise<void> {
  if (parentPort === null) throw new Error('The Windows vault pipe worker requires a parent port.');
  const port = parentPort;
  const transport = createPackagedWindowsVaultTransport();
  let failure: Error | undefined;
  const state = { stopping: false };
  const onResponse = (message: unknown): void => {
    try {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'stop') {
        state.stopping = true;
        transport.stopDispatcher();
        return;
      }
      if (!isResponseMessage(message)) throw new Error('The Windows vault pipe response is malformed.');
      const frame = Buffer.from(message.frame.buffer, message.frame.byteOffset, message.frame.byteLength);
      transport.respond(message, frame);
    } catch (cause) {
      failure = cause instanceof Error ? cause : new Error('The Windows vault pipe response failed.');
      transport.stopDispatcher();
    } finally {
      if (typeof message === 'object' && message !== null && 'frame' in message && message.frame instanceof Uint8Array)
        message.frame.fill(0);
    }
  };
  port.on('message', onResponse);
  try {
    transport.startDispatcher('\\\\.\\pipe\\InFlowVault', (event) => {
      if (event.type === 'closed') {
        port.postMessage(event);
        return;
      }
      const transferredFrame = Uint8Array.from(event.frame);
      try {
        port.postMessage({ ...event, frame: transferredFrame }, [transferredFrame.buffer]);
      } finally {
        if (transferredFrame.byteLength !== 0) transferredFrame.fill(0);
      }
    });
    port.postMessage({ type: 'ready' });
    for (;;) {
      await delay(100);
      if (failure !== undefined) throw failure;
      if (state.stopping) return;
      if (!transport.dispatcherState().running)
        throw new Error('The Windows vault pipe dispatcher stopped unexpectedly.');
    }
  } finally {
    port.off('message', onResponse);
    transport.stopDispatcher();
  }
}

async function runRuntimeWorker(data: WindowsVaultWorkerData, entryUrl: URL): Promise<void> {
  if (parentPort === null) throw new Error('The Windows vault runtime worker requires a parent port.');
  const programData = process.env['ProgramData'] ?? 'C:\\ProgramData';
  const manager = new MultiTenantVaultBackendManager({
    rootDirectory: path.join(programData, 'InFlow', 'vaults'),
  });
  const transport = createPackagedWindowsVaultTransport();
  const pipe = new Worker(entryUrl, { workerData: { ...data, role: 'pipe' } satisfies WindowsVaultWorkerData });
  const queue = new WindowsVaultRequestQueue();
  const requests = new Set<Promise<void>>();
  const connections = new Map<
    number,
    { generation: number; sequence: number; active: boolean; pending: boolean; principal: string }
  >();
  let ready = false;
  let closing = false;
  let failure: Error | undefined;
  const fail = (cause: Error): void => {
    failure = cause;
    closing = true;
    void queue.close();
  };
  pipe.on('error', (cause: Error) => {
    fail(cause);
  });
  pipe.on('exit', () => {
    if (!closing) fail(new Error('The Windows vault pipe worker stopped unexpectedly.'));
  });
  pipe.on('message', (message: unknown) => {
    if (closing) {
      if (typeof message === 'object' && message !== null && 'frame' in message && message.frame instanceof Uint8Array)
        message.frame.fill(0);
      return;
    }
    if (isReadyMessage(message)) {
      if (!ready) {
        try {
          transport.markServiceReady();
          ready = true;
        } catch (cause) {
          fail(cause instanceof Error ? cause : new Error('Windows vault service readiness failed.'));
        }
      }
      return;
    }
    if (isClosedMessage(message)) {
      const connection = connections.get(message.slot);
      if (connection?.generation === message.generation) {
        connection.active = false;
      }
      return;
    }
    if (isRequestMessage(message)) {
      const previous = connections.get(message.slot);
      if (
        ((previous === undefined || message.generation > previous.generation) && message.sequence !== 1) ||
        (previous !== undefined &&
          (message.generation < previous.generation ||
            (message.generation === previous.generation &&
              (!previous.active ||
                previous.pending ||
                message.sequence !== previous.sequence + 1 ||
                message.peer.principal !== previous.principal))))
      ) {
        message.frame.fill(0);
        fail(new Error('The Windows vault pipe request is out of sequence.'));
        return;
      }
      if (previous !== undefined) previous.active = false;
      const connection = {
        generation: message.generation,
        sequence: message.sequence,
        active: true,
        pending: true,
        principal: message.peer.principal,
      };
      connections.set(message.slot, connection);
      const isActive = (): boolean => !closing && connection.active;
      const request = handlePipeRequest(pipe, manager, queue, data, message, isActive)
        .catch((cause: unknown) => {
          fail(cause instanceof Error ? cause : new Error('The Windows vault pipe response failed.'));
        })
        .finally(() => {
          connection.pending = false;
          requests.delete(request);
        });
      requests.add(request);
      return;
    }
    if (typeof message === 'object' && message !== null && 'frame' in message && message.frame instanceof Uint8Array) {
      message.frame.fill(0);
      fail(new Error('The Windows vault pipe message is malformed.'));
    }
  });
  try {
    hardenVaultDaemonProcess();
    for (;;) {
      await delay(100);
      if (failure !== undefined) throw failure;
      const control = transport.serviceControlState();
      if (control.lockRequested) await queue.lockForSleep(() => manager.lockForSleep());
      if (control.stopRequested) break;
    }
  } finally {
    closing = true;
    const drained = queue.close();
    try {
      try {
        transport.requestServiceStop();
      } finally {
        try {
          pipe.postMessage({ type: 'stop' });
        } finally {
          await pipe.terminate();
        }
      }
    } finally {
      await drained;
      await Promise.all(requests);
      try {
        await manager.close();
      } finally {
        transport.completeServiceStop();
      }
    }
  }
}

async function handlePipeRequest(
  pipe: Worker,
  manager: MultiTenantVaultBackendManager,
  queue: WindowsVaultRequestQueue,
  data: WindowsVaultWorkerData,
  message: PipeRequestIdentity & {
    frame: Uint8Array;
    peer: { path: string; pid: number; principal: string; uid: number };
  },
  isActive: () => boolean,
): Promise<void> {
  const frame = Buffer.from(message.frame.buffer, message.frame.byteOffset, message.frame.byteLength);
  let responseFrame: Buffer | undefined;
  let response: VaultIpcResponse | undefined;
  let request: VaultIpcMessage | undefined;
  let requestId = 'unknown';
  try {
    request = decodeVaultIpcFrame(frame);
    if (!('method' in request)) {
      throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC request is malformed.');
    }
    requestId = request.id;
    const operation = request;
    response = await queue.run(message.peer.principal, () => {
      if (!isActive()) throw unavailable();
      return handleVaultIpcRequest(
        manager.backendForPeer(message.peer),
        operation,
        {
          buildId: data.buildId,
          cliVersion: data.cliVersion,
          executablePath: process.execPath,
          pid: process.pid,
        },
        { allowDaemonShutdown: false },
      );
    });
    responseFrame = encodeVaultIpcMessage(response);
  } catch (cause) {
    responseFrame = encodeVaultIpcMessage({
      error: {
        code: cause instanceof SecureStorageError ? cause.secureStorageCode : 'secure_storage_io_error',
        message: cause instanceof SecureStorageError ? cause.message : 'The InFlow vault operation failed.',
      },
      id: requestId,
      ok: false,
      version: 1,
    });
  } finally {
    frame.fill(0);
    clearVaultIpcBytes(request);
    clearVaultIpcBytes(response);
  }
  if (!isActive()) {
    responseFrame.fill(0);
    return;
  }
  const transferredFrame = Uint8Array.from(responseFrame);
  responseFrame.fill(0);
  try {
    pipe.postMessage(
      {
        slot: message.slot,
        generation: message.generation,
        sequence: message.sequence,
        frame: transferredFrame,
        type: 'response',
      },
      [transferredFrame.buffer],
    );
  } finally {
    if (transferredFrame.byteLength !== 0) transferredFrame.fill(0);
  }
}

class WindowsVaultRequestQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private barrier: Promise<void> = Promise.resolve();
  private closing = false;
  private pending = 0;

  async run<T>(principal: string, operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.pending >= 32) throw unavailable();
    const previous = this.tails.get(principal) ?? Promise.resolve();
    const barrier = this.barrier;
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending += 1;
    this.tails.set(principal, current);
    try {
      await Promise.all([previous, barrier]);
      this.assertOpen();
      return await operation();
    } finally {
      this.pending -= 1;
      release();
      if (this.tails.get(principal) === current) this.tails.delete(principal);
    }
  }

  lockForSleep(operation: () => Promise<void>): Promise<void> {
    this.barrier = Promise.all([...this.tails.values(), this.barrier]).then(operation);
    return this.barrier;
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.tails.values(), this.barrier]);
  }

  private assertOpen(): void {
    if (this.closing) throw unavailable();
  }
}

function unavailable(): SecureStorageError {
  return new SecureStorageError('secure_storage_unavailable', 'The InFlow vault daemon is unavailable.');
}

function isReadyMessage(value: unknown): value is { type: 'ready' } {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'ready';
}

function isRequestMessage(value: unknown): value is PipeRequestIdentity & {
  frame: Uint8Array;
  peer: { path: string; pid: number; principal: string; uid: number };
  type: 'request';
} {
  if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'request') return false;
  if (!isPipeRequestIdentity(value)) return false;
  if (!('frame' in value) || !(value.frame instanceof Uint8Array) || !('peer' in value)) return false;
  const peer = value.peer;
  return (
    typeof peer === 'object' &&
    peer !== null &&
    'path' in peer &&
    typeof peer.path === 'string' &&
    'pid' in peer &&
    Number.isSafeInteger(peer.pid) &&
    'principal' in peer &&
    typeof peer.principal === 'string' &&
    'uid' in peer &&
    Number.isSafeInteger(peer.uid)
  );
}

function isResponseMessage(value: unknown): value is PipeRequestIdentity & { frame: Uint8Array; type: 'response' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'response' &&
    isPipeRequestIdentity(value) &&
    'frame' in value &&
    value.frame instanceof Uint8Array
  );
}

function isPipeRequestIdentity(value: object, minimumSequence = 1): value is PipeRequestIdentity {
  return (
    'slot' in value &&
    typeof value.slot === 'number' &&
    Number.isInteger(value.slot) &&
    value.slot >= 0 &&
    value.slot < 32 &&
    'generation' in value &&
    typeof value.generation === 'number' &&
    Number.isInteger(value.generation) &&
    value.generation > 0 &&
    value.generation <= 0xffffffff &&
    'sequence' in value &&
    typeof value.sequence === 'number' &&
    Number.isInteger(value.sequence) &&
    value.sequence >= minimumSequence &&
    value.sequence <= 0xffffffff
  );
}

function isClosedMessage(value: unknown): value is PipeRequestIdentity & { type: 'closed' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'closed' &&
    isPipeRequestIdentity(value, 0)
  );
}
