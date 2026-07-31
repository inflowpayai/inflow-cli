import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import path from 'node:path';
import process from 'node:process';
import { parentPort, Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { SecureStorageError } from './errors.js';
import { handleVaultIpcRequest } from './vault-daemon-handler.js';
import { clearVaultIpcBytes, decodeVaultIpcFrame, encodeVaultIpcMessage, type VaultIpcResponse } from './vault-ipc.js';
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
    await runtime.terminate();
  }
}

async function runPipeWorker(): Promise<void> {
  if (parentPort === null) throw new Error('The Windows vault pipe worker requires a parent port.');
  const port = parentPort;
  const transport = createPackagedWindowsVaultTransport();
  port.postMessage({ type: 'ready' });
  for (;;) {
    try {
      const connection = transport.accept('\\\\.\\pipe\\InFlowVault');
      const frame = transport.read(connection);
      const transferredFrame = Uint8Array.from(frame);
      frame.fill(0);
      port.postMessage({ frame: transferredFrame, peer: connection.peer, type: 'request' }, [transferredFrame.buffer]);
      const message = await new Promise<unknown>((resolve) => {
        port.once('message', resolve);
      });
      if (!isResponseMessage(message)) {
        transport.close(connection);
        continue;
      }
      const response = Buffer.from(message.frame.buffer, message.frame.byteOffset, message.frame.byteLength);
      try {
        transport.write(connection, response);
      } finally {
        response.fill(0);
      }
    } catch {
      if (transport.serviceControlState().stopRequested) return;
      await delay(100);
    }
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
  let ready = false;
  pipe.on('message', (message: unknown) => {
    if (isReadyMessage(message)) {
      if (!ready) {
        ready = true;
        transport.markServiceReady();
      }
      return;
    }
    if (isRequestMessage(message)) void handlePipeRequest(pipe, manager, data, message);
  });
  hardenVaultDaemonProcess();
  try {
    for (;;) {
      await delay(100);
      const control = transport.serviceControlState();
      if (control.lockRequested) await manager.lockForSleep();
      if (control.stopRequested) break;
    }
  } finally {
    await pipe.terminate();
    await manager.close();
    transport.completeServiceStop();
  }
}

async function handlePipeRequest(
  pipe: Worker,
  manager: MultiTenantVaultBackendManager,
  data: WindowsVaultWorkerData,
  message: { frame: Uint8Array; peer: { path: string; pid: number; principal: string; uid: number } },
): Promise<void> {
  const frame = Buffer.from(message.frame.buffer, message.frame.byteOffset, message.frame.byteLength);
  let responseFrame: Buffer | undefined;
  let response: VaultIpcResponse | undefined;
  let requestId = 'unknown';
  try {
    const request = decodeVaultIpcFrame(frame);
    if (!('method' in request)) {
      throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC request is malformed.');
    }
    requestId = request.id;
    response = await handleVaultIpcRequest(
      manager.backendForPeer(message.peer),
      request,
      {
        buildId: data.buildId,
        cliVersion: data.cliVersion,
        executablePath: process.execPath,
        pid: process.pid,
      },
      { allowDaemonShutdown: false },
    );
    clearVaultIpcBytes(request);
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
    clearVaultIpcBytes(response);
  }
  const transferredFrame = Uint8Array.from(responseFrame);
  responseFrame.fill(0);
  pipe.postMessage({ frame: transferredFrame, type: 'response' }, [transferredFrame.buffer]);
}

function isReadyMessage(value: unknown): value is { type: 'ready' } {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'ready';
}

function isRequestMessage(value: unknown): value is {
  frame: Uint8Array;
  peer: { path: string; pid: number; principal: string; uid: number };
  type: 'request';
} {
  if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'request') return false;
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

function isResponseMessage(value: unknown): value is { frame: Uint8Array; type: 'response' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'response' &&
    'frame' in value &&
    value.frame instanceof Uint8Array
  );
}
