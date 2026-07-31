import process from 'node:process';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, lstatSync } from 'node:fs';
import { createServer, Socket, type Server } from 'node:net';
import type { VaultBackend } from './vault-backend.js';
import { authenticateLinuxVaultBrokerClient, ensureLinuxVaultBrokerKey } from './vault-broker-auth.js';
import {
  LifetimeVaultBackend,
  VaultBackendLifetime,
  type VaultBackendLifetimeOptions,
} from './vault-backend-lifetime.js';
import { SecureStorageError } from './errors.js';
import { SecureSqliteRepository } from './sqlite.js';
import { LocalVaultBackend } from './vault-local-backend.js';
import {
  createVaultSocketPeerVerifier,
  shouldRequireVaultPeerVerification,
  verifyTransferredVaultSocketPeer,
  type VaultSocketPeer,
  type VaultSocketPeerVerifier,
} from './vault-peer-verifier.js';
import { vaultFilePaths } from './vault-files.js';
import { hardenVaultDaemonProcess } from './vault-protected-key.js';
import { createVaultSocketConnectionHandler, startVaultSocketServer, type VaultSocketServer } from './vault-socket.js';
import { MultiTenantVaultBackendManager } from './vault-tenant-manager.js';

export interface LocalVaultDaemonOptions {
  buildId?: string;
  cliVersion?: string;
  rootDirectory?: string;
  sleepCheckIntervalMilliseconds?: number;
  sleepDriftThresholdMilliseconds?: number;
}

export interface LinuxVaultServiceOptions {
  buildId?: string;
  cliVersion?: string;
  listenFd?: number;
  peerVerifier?: VaultSocketPeerVerifier;
  rootDirectory?: string;
  sleepCheckIntervalMilliseconds?: number;
  sleepDriftThresholdMilliseconds?: number;
  socketPath?: string;
}

export interface LinuxVaultBrokerOptions {
  buildId?: string;
  cliVersion?: string;
  listenFd?: number;
  serviceGroupId?: number;
  serviceUserId?: number;
  socketPath?: string;
}

export interface LocalVaultDaemon {
  close(): Promise<void>;
  closed: Promise<void>;
  socketPath: string;
}

export interface LocalVaultDaemonRuntime {
  exit(code: number): void;
  once(signal: 'SIGINT' | 'SIGTERM', handler: () => Promise<void>): void;
}

interface LinuxTransferredVaultServiceRuntime {
  exit(code: number): void;
  on(event: 'message', handler: (message: unknown, handle: unknown) => void): void;
  once(event: 'SIGINT' | 'SIGTERM' | 'disconnect', handler: () => void): void;
  send(message: unknown): void;
}

interface LinuxVaultBrokerDependencies {
  authenticateClient: typeof authenticateLinuxVaultBrokerClient;
  closeServer(server: Server): Promise<void>;
  createBrokerServer(listener: (socket: Socket) => void): Server;
  createPeerVerifier: typeof createVaultSocketPeerVerifier;
  ensureBrokerKey: typeof ensureLinuxVaultBrokerKey;
  listenServer(server: Server, fileDescriptor: number): Promise<void>;
  runtime: {
    once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  };
  spawnService(identity: { gid: number; uid: number }): ChildProcess;
}

export async function startLocalVaultDaemon(options: LocalVaultDaemonOptions = {}): Promise<LocalVaultDaemon> {
  const paths = vaultFilePaths(options.rootDirectory);
  const repository = new SecureSqliteRepository({ databasePath: paths.database });
  const backend = new LocalVaultBackend({ paths, repository });
  const lifetime = new VaultBackendLifetime(lifetimeOptions(options));
  const shutdown = { close: undefined as (() => Promise<void>) | undefined };
  let resolveClosed: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = await startVaultSocketServer(
    socketServerOptions(
      new LifetimeVaultBackend(backend, lifetime),
      paths.socket,
      options.cliVersion ?? null,
      options.buildId ?? null,
      () => {
        void shutdown.close?.();
      },
    ),
  );
  let isClosed = false;
  const close = async (): Promise<void> => {
    if (isClosed) return;
    isClosed = true;
    lifetime.clear();
    try {
      await closeLocalVaultDaemon(repository, server);
    } finally {
      resolveClosed();
    }
  };
  shutdown.close = close;
  lifetime.expireWith(close);
  return {
    close,
    closed: closedPromise,
    socketPath: paths.socket,
  };
}

export async function startLinuxVaultService(options: LinuxVaultServiceOptions = {}): Promise<LocalVaultDaemon> {
  const manager = new MultiTenantVaultBackendManager({
    rootDirectory: options.rootDirectory ?? '/var/lib/inflow/vaults',
    ...lifetimeOptions(options),
  });
  let resolveClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let server: VaultSocketServer;
  try {
    server = await startVaultSocketServer({
      backendForPeer: (peer) => manager.backendForPeer(peer),
      daemonInfo: {
        buildId: options.buildId ?? null,
        cliVersion: options.cliVersion ?? null,
        executablePath: process.execPath,
        pid: process.pid,
      },
      ...(options.listenFd === undefined ? {} : { listenFd: options.listenFd }),
      peerVerifier: options.peerVerifier ?? createVaultSocketPeerVerifier({ requireSameUser: false }),
      socketMode: 0o666,
      socketPath: options.socketPath ?? '/run/inflow/vault.sock',
    });
  } catch (cause) {
    await manager.close();
    throw cause;
  }
  let isClosed = false;
  const close = async (): Promise<void> => {
    if (isClosed) return;
    isClosed = true;
    try {
      await server.close();
    } finally {
      await manager.close();
      resolveClosed();
    }
  };
  return {
    close,
    closed,
    socketPath: server.socketPath,
  };
}

function socketServerOptions(
  backend: VaultBackend,
  socketPath: string,
  cliVersion: string | null,
  buildId: string | null,
  onShutdown: () => void,
) {
  const options: {
    backend: VaultBackend;
    daemonInfo: { buildId: string | null; cliVersion: string | null; executablePath: string; pid: number };
    onShutdown: () => void;
    peerVerifier?: VaultSocketPeerVerifier;
    socketPath: string;
  } = {
    backend,
    daemonInfo: {
      buildId,
      cliVersion,
      executablePath: process.execPath,
      pid: process.pid,
    },
    onShutdown,
    socketPath,
  };
  if (shouldRequireVaultPeerVerification()) options.peerVerifier = createVaultSocketPeerVerifier();
  return options;
}

export async function runLocalVaultDaemon(options: LocalVaultDaemonOptions = {}): Promise<void> {
  hardenVaultDaemonProcess();
  const daemon = await startLocalVaultDaemon(options);
  attachLocalVaultDaemonSignalHandlers(daemon, process);
  await daemon.closed;
}

export async function runLinuxVaultService(options: LinuxVaultServiceOptions = {}): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error('The Linux vault service is available only on Linux.');
  }
  hardenVaultDaemonProcess();
  const activationFileDescriptor = options.listenFd ?? systemdSocketFileDescriptor(process.env, process.pid);
  closeSync(activationFileDescriptor);
  const { listenFd: _activationFileDescriptor, ...serviceOptions } = options;
  const daemon = await startLinuxVaultService(serviceOptions);
  attachLocalVaultDaemonSignalHandlers(daemon, process);
  await daemon.closed;
}

export async function runLinuxVaultBroker(options: LinuxVaultBrokerOptions = {}): Promise<void> {
  await runLinuxVaultBrokerEntry(options, process.platform, {
    hardenProcess: hardenVaultDaemonProcess,
    resolveServiceIdentity: linuxVaultServiceIdentity,
    runBroker: runLinuxVaultBrokerWithDependencies,
  });
}

/** @internal */
export async function runLinuxVaultBrokerEntry(
  options: LinuxVaultBrokerOptions,
  platform: NodeJS.Platform,
  dependencies: {
    hardenProcess(): void;
    resolveServiceIdentity(stateDirectory: string): { gid: number; uid: number };
    runBroker(
      activationFileDescriptor: number,
      serviceIdentity: { gid: number; uid: number },
      dependencies: LinuxVaultBrokerDependencies,
    ): Promise<void>;
  },
): Promise<void> {
  if (platform !== 'linux') {
    throw new Error('The Linux vault broker is available only on Linux.');
  }
  dependencies.hardenProcess();
  const activationFileDescriptor = options.listenFd ?? systemdSocketFileDescriptor(process.env, process.pid);
  const serviceIdentity =
    options.serviceUserId === undefined || options.serviceGroupId === undefined
      ? dependencies.resolveServiceIdentity('/var/lib/inflow')
      : { gid: options.serviceGroupId, uid: options.serviceUserId };
  await dependencies.runBroker(activationFileDescriptor, serviceIdentity, {
    authenticateClient: authenticateLinuxVaultBrokerClient,
    closeServer: closeBroker,
    createBrokerServer: (listener) => createServer({ pauseOnConnect: true }, listener),
    createPeerVerifier: createVaultSocketPeerVerifier,
    ensureBrokerKey: ensureLinuxVaultBrokerKey,
    listenServer: listenBroker,
    runtime: process,
    spawnService: (identity) =>
      spawn(process.execPath, ['--daemon', 'vault-service'], {
        env: process.env,
        gid: identity.gid,
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        uid: identity.uid,
      }),
  });
}

/** @internal */
export async function runLinuxVaultBrokerWithDependencies(
  activationFileDescriptor: number,
  serviceIdentity: { gid: number; uid: number },
  dependencies: LinuxVaultBrokerDependencies,
): Promise<void> {
  const child = dependencies.spawnService(serviceIdentity);
  await waitForVaultServiceReady(child);
  const brokerPrivateKey = await dependencies.ensureBrokerKey();
  const verifyPeer = dependencies.createPeerVerifier({ requireSameUser: false });
  const server = dependencies.createBrokerServer((socket) => {
    void Promise.resolve()
      .then(() => verifyPeer(socket))
      .then(async (peer) => {
        socket.resume();
        await dependencies.authenticateClient(socket, peer, brokerPrivateKey);
        socket.pause();
        return peer;
      })
      .then(
        (peer) => transferSocketToVaultService(child, socket, peer),
        () => socket.destroy(),
      );
  });
  await dependencies.listenServer(server, activationFileDescriptor);
  const close = async (): Promise<void> => {
    await dependencies.closeServer(server);
    if (child.connected) child.disconnect();
  };
  dependencies.runtime.once('SIGINT', () => {
    void close();
  });
  dependencies.runtime.once('SIGTERM', () => {
    void close();
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      void dependencies.closeServer(server).finally(() => {
        if (code === 0 || signal === 'SIGTERM') resolve();
        else reject(new Error('The InFlow vault service exited unexpectedly.'));
      });
    });
  });
}

export async function runLinuxTransferredVaultService(options: LinuxVaultServiceOptions = {}): Promise<void> {
  if (process.platform !== 'linux' || typeof process.send !== 'function') {
    throw new Error('The Linux vault service requires its authenticated broker.');
  }
  const send = process.send.bind(process);
  await runLinuxTransferredVaultServiceWithRuntime(options, process.platform, {
    exit(code) {
      process.exit(code);
    },
    on(event, handler) {
      process.on(event, handler);
    },
    once(event, handler) {
      process.once(event, handler);
    },
    send(message) {
      send(message);
    },
  });
}

/** @internal */
export async function runLinuxTransferredVaultServiceWithRuntime(
  options: LinuxVaultServiceOptions,
  platform: NodeJS.Platform,
  runtime: LinuxTransferredVaultServiceRuntime,
  verifyPeer: typeof verifyTransferredVaultSocketPeer = verifyTransferredVaultSocketPeer,
): Promise<void> {
  if (platform !== 'linux') {
    throw new Error('The Linux vault service requires its authenticated broker.');
  }
  hardenVaultDaemonProcess();
  const manager = new MultiTenantVaultBackendManager({
    rootDirectory: options.rootDirectory ?? '/var/lib/inflow/vaults',
    ...lifetimeOptions(options),
  });
  const handleConnection = createVaultSocketConnectionHandler({
    backendForPeer: (peer) => manager.backendForPeer(peer),
    daemonInfo: {
      buildId: options.buildId ?? null,
      cliVersion: options.cliVersion ?? null,
      executablePath: process.execPath,
      pid: process.pid,
    },
    peerVerifier: () => {
      throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
    },
    socketPath: 'broker-transferred',
  });
  runtime.on('message', (message, handle) => {
    if (!isBrokerTransferMessage(message) || !isSocket(handle)) {
      if (isSocket(handle)) handle.destroy();
      return;
    }
    handle.pause();
    try {
      const peer = verifyPeer(handle, message.peer);
      handleConnection(handle, peer);
      handle.resume();
    } catch {
      handle.destroy();
    }
  });
  let closed = false;
  let resolveClosed: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await manager.close();
    resolveClosed();
    runtime.exit(0);
  };
  runtime.once('SIGINT', () => {
    void close();
  });
  runtime.once('SIGTERM', () => {
    void close();
  });
  runtime.once('disconnect', () => {
    void close();
  });
  runtime.send({ type: 'vault-service-ready' });
  await closedPromise;
}

function linuxVaultServiceIdentity(stateDirectory: string): { gid: number; uid: number } {
  const stat = lstatSync(stateDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid === 0 || stat.gid === 0 || (stat.mode & 0o077) !== 0) {
    throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault service identity is invalid.');
  }
  return { gid: stat.gid, uid: stat.uid };
}

function waitForVaultServiceReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (cause: Error): void => {
      child.off('message', onMessage);
      child.off('exit', onExit);
      reject(cause);
    };
    const onExit = (): void => {
      child.off('error', onError);
      child.off('message', onMessage);
      reject(new Error('The InFlow vault service did not start.'));
    };
    const onMessage = (message: unknown): void => {
      if (!isReadyMessage(message)) return;
      child.off('error', onError);
      child.off('exit', onExit);
      resolve();
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
}

function transferSocketToVaultService(child: ChildProcess, socket: Socket, peer: VaultSocketPeer): void {
  if (!child.connected) {
    socket.destroy();
    return;
  }
  child.send({ peer, type: 'vault-client' }, socket, { keepOpen: true }, () => {
    socket.destroy();
  });
}

function listenBroker(server: Server, fileDescriptor: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ fd: fileDescriptor }, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeBroker(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((cause) => {
      if (cause !== undefined) {
        reject(cause);
        return;
      }
      resolve();
    });
  });
}

function isSocket(handle: unknown): handle is Socket {
  return handle instanceof Socket;
}

function isReadyMessage(message: unknown): boolean {
  return typeof message === 'object' && message !== null && 'type' in message && message.type === 'vault-service-ready';
}

function isBrokerTransferMessage(message: unknown): message is { peer: VaultSocketPeer; type: 'vault-client' } {
  if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'vault-client') {
    return false;
  }
  if (!('peer' in message) || typeof message.peer !== 'object' || message.peer === null) return false;
  const peer = message.peer as Record<string, unknown>;
  return (
    typeof peer['path'] === 'string' &&
    Number.isSafeInteger(peer['pid']) &&
    Number.isSafeInteger(peer['uid']) &&
    (peer['pid'] as number) > 0 &&
    (peer['uid'] as number) >= 0
  );
}

export function attachLocalVaultDaemonSignalHandlers(daemon: LocalVaultDaemon, runtime: LocalVaultDaemonRuntime): void {
  const close = async (): Promise<void> => {
    await daemon.close();
    runtime.exit(0);
  };
  runtime.once('SIGINT', close);
  runtime.once('SIGTERM', close);
}

async function closeLocalVaultDaemon(repository: SecureSqliteRepository, server: VaultSocketServer): Promise<void> {
  await server.close();
  repository.close();
}

function lifetimeOptions(options: LocalVaultDaemonOptions | LinuxVaultServiceOptions): VaultBackendLifetimeOptions {
  const result: VaultBackendLifetimeOptions = {};
  if (options.sleepCheckIntervalMilliseconds !== undefined) {
    result.sleepCheckIntervalMilliseconds = options.sleepCheckIntervalMilliseconds;
  }
  if (options.sleepDriftThresholdMilliseconds !== undefined) {
    result.sleepDriftThresholdMilliseconds = options.sleepDriftThresholdMilliseconds;
  }
  return result;
}

/** @internal */
export const __testing = {
  closeBroker,
  isBrokerTransferMessage,
  isReadyMessage,
  linuxVaultServiceIdentity,
  listenBroker,
  lifetimeOptions,
  parseNonNegativeInteger,
  runLinuxVaultBrokerEntry,
  runLinuxVaultBrokerWithDependencies,
  transferSocketToVaultService,
  waitForVaultServiceReady,
};

export function systemdSocketFileDescriptor(environment: NodeJS.ProcessEnv, processId: number): number {
  const listenProcessId = parseNonNegativeInteger(environment['LISTEN_PID']);
  const descriptorCount = parseNonNegativeInteger(environment['LISTEN_FDS']);
  const descriptorNames = environment['LISTEN_FDNAMES'];
  if (
    listenProcessId !== processId ||
    descriptorCount !== 1 ||
    (descriptorNames !== undefined && descriptorNames !== 'inflow-vault')
  ) {
    throw new SecureStorageError('secure_storage_unavailable', 'Vault socket activation is unavailable.');
  }
  return 3;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
