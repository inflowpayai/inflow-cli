import type { Buffer } from 'node:buffer';
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { SecureStorageError } from './errors.js';
import { runtimeRequire } from './runtime-require.js';
import { usesDevelopmentVault } from './vault-files.js';
import {
  clearVaultIpcBytes,
  decodeVaultIpcFrame,
  encodeVaultIpcMessage,
  type VaultIpcMessage,
  type VaultIpcRequest,
  type VaultIpcResponse,
} from './vault-ipc.js';
import { verifyVaultNativeModule, type VaultSocketPeer } from './vault-peer-verifier.js';

declare const __VAULT_PEER_NATIVE_SHA256__: string | undefined;
declare const __VAULT_PEER_NATIVE_RELATIVE_PATH__: string | undefined;

const verifiedConnection = Symbol('verifiedWindowsVaultConnection');

interface WindowsVaultPipeConnection {
  readonly connection: unknown;
}

interface WindowsVaultNativeModule {
  currentPrincipal(): string;
  prepareDevelopmentDirectory(path: string): void;
  connectDevelopmentPipe(path: string): { connection: unknown; peer: VaultSocketPeer };
  startDevelopmentPipeDispatcher(path: string, callback: (event: WindowsPipeEvent) => void): void;
  startPipeDispatcher(path: string, callback: (event: WindowsPipeEvent) => void): void;
  stopPipeDispatcher(): void;
  pipeDispatcherState(): { running: boolean; error: number };
  submitPipeDispatcher(
    slot: number,
    generation: number,
    sequence: number,
    authorized: boolean,
    frame: Buffer | null,
  ): boolean;
  beginPipeSession(connection: unknown): void;
  closePipeConnection(connection: unknown): void;
  connectPipe(path: string): { connection: unknown; peer: VaultSocketPeer };
  exchangePipeRequest(connection: unknown, frame: Buffer): Buffer;
  runServiceDispatcher(): void;
  markServiceReady(): void;
  serviceControlState(): { lockRequested: boolean; stopRequested: boolean };
  completeServiceStop(): void;
  requestServiceStop(): void;
  verifyAuthenticode(path: string): { publisher: string; thumbprint: string };
}

interface WindowsPipeIdentity {
  slot: number;
  generation: number;
  sequence: number;
}

type WindowsPipeEvent = WindowsPipeIdentity &
  ({ type: 'verify'; peer: VaultSocketPeer } | { type: 'request'; frame: Buffer } | { type: 'closed' });

export type VerifiedWindowsPipeEvent = WindowsPipeIdentity &
  ({ type: 'request'; frame: Buffer; peer: VaultSocketPeer & { principal: string } } | { type: 'closed' });

export interface WindowsVaultTransportOptions {
  development?: boolean;
  expectedExecutablePath: string;
  expectedNativeModuleSha256: string;
  expectedPublisher?: string;
  nativeModulePath: string;
}

export interface VerifiedWindowsVaultConnection extends WindowsVaultPipeConnection {
  readonly peer: VaultSocketPeer & { principal: string };
  readonly [verifiedConnection]: true;
}

export class WindowsVaultTransport {
  private readonly expectedExecutablePath: string;
  private readonly expectedPublisher: string | undefined;
  private readonly developmentPrincipal: string | undefined;
  private readonly native: WindowsVaultNativeModule;
  private readonly peers = new Map<number, { generation: number; peer: VaultSocketPeer & { principal: string } }>();

  constructor(options: WindowsVaultTransportOptions) {
    verifyVaultNativeModule(options.nativeModulePath, {
      expectedSha256: options.expectedNativeModuleSha256,
      expectedTeamId: '',
      requireSignature: false,
    });
    this.native = runtimeRequire()(options.nativeModulePath) as WindowsVaultNativeModule;
    this.expectedExecutablePath = canonicalWindowsPath(options.expectedExecutablePath);
    if (options.development === true) {
      if (!usesDevelopmentVault()) throw peerVerificationError();
      this.developmentPrincipal = this.native.currentPrincipal();
      if (!/^S-\d+(?:-\d+)+$/u.test(this.developmentPrincipal)) throw peerVerificationError();
    } else {
      const selfSigner = this.native.verifyAuthenticode(this.expectedExecutablePath);
      if (!/^[0-9a-f]{64}$/u.test(selfSigner.thumbprint)) throw peerVerificationError();
      this.expectedPublisher = options.expectedPublisher ?? selfSigner.publisher;
    }
  }

  prepareDevelopmentDirectory(path: string): void {
    if (this.developmentPrincipal === undefined) throw peerVerificationError();
    this.native.prepareDevelopmentDirectory(path);
  }

  startDispatcher(path: string, callback: (event: VerifiedWindowsPipeEvent) => void): void {
    const start =
      this.developmentPrincipal === undefined
        ? this.native.startPipeDispatcher.bind(this.native)
        : this.native.startDevelopmentPipeDispatcher.bind(this.native);
    start(path, (event) => {
      if (event.type === 'verify') {
        let peer: VaultSocketPeer & { principal: string };
        try {
          peer = this.verifyPeer(event.peer);
        } catch {
          this.native.submitPipeDispatcher(event.slot, event.generation, 0, false, null);
          return;
        }
        if (this.native.submitPipeDispatcher(event.slot, event.generation, 0, true, null)) {
          this.peers.set(event.slot, { generation: event.generation, peer });
        }
        return;
      }
      const verified = this.peers.get(event.slot);
      if (event.type === 'closed') {
        if (verified?.generation === event.generation) this.peers.delete(event.slot);
        callback(event);
        return;
      }
      try {
        if (verified?.generation !== event.generation) throw peerVerificationError();
        callback({ ...event, peer: verified.peer });
      } finally {
        event.frame.fill(0);
      }
    });
  }

  stopDispatcher(): void {
    try {
      this.native.stopPipeDispatcher();
    } finally {
      this.peers.clear();
    }
  }

  dispatcherState(): { running: boolean; error: number } {
    return this.native.pipeDispatcherState();
  }

  respond(identity: WindowsPipeIdentity, frame: Buffer): boolean {
    return this.native.submitPipeDispatcher(identity.slot, identity.generation, identity.sequence, false, frame);
  }

  connect(path: string): VerifiedWindowsVaultConnection {
    const connection = this.verify(
      this.developmentPrincipal === undefined
        ? this.native.connectPipe(path)
        : this.native.connectDevelopmentPipe(path),
    );
    try {
      this.native.beginPipeSession(connection.connection);
      return connection;
    } catch (cause) {
      this.native.closePipeConnection(connection.connection);
      throw cause;
    }
  }

  close(connection: VerifiedWindowsVaultConnection): void {
    this.native.closePipeConnection(connection.connection);
  }

  exchange(connection: VerifiedWindowsVaultConnection, frame: Buffer): Buffer {
    return this.native.exchangePipeRequest(connection.connection, frame);
  }

  completeServiceStop(): void {
    this.native.completeServiceStop();
  }

  requestServiceStop(): void {
    this.native.requestServiceStop();
  }

  markServiceReady(): void {
    this.native.markServiceReady();
  }

  runServiceDispatcher(): void {
    this.native.runServiceDispatcher();
  }

  serviceControlState(): { lockRequested: boolean; stopRequested: boolean } {
    return this.native.serviceControlState();
  }

  private verify(candidate: { connection: unknown; peer: VaultSocketPeer }): VerifiedWindowsVaultConnection {
    try {
      const peer = this.verifyPeer(candidate.peer);
      return {
        connection: candidate.connection,
        peer: { ...peer, principal: peer.principal },
        [verifiedConnection]: true,
      };
    } catch {
      this.native.closePipeConnection(candidate.connection);
      throw peerVerificationError();
    }
  }

  private verifyPeer(peer: VaultSocketPeer): VaultSocketPeer & { principal: string } {
    if (
      peer.principal === undefined ||
      !/^S-\d+(?:-\d+)+$/u.test(peer.principal) ||
      canonicalWindowsPath(peer.path) !== this.expectedExecutablePath
    )
      throw peerVerificationError();
    if (this.developmentPrincipal !== undefined) {
      if (peer.principal !== this.developmentPrincipal) throw peerVerificationError();
    } else {
      const signer = this.native.verifyAuthenticode(peer.path);
      if (signer.publisher !== this.expectedPublisher || !/^[0-9a-f]{64}$/u.test(signer.thumbprint))
        throw peerVerificationError();
    }
    return { ...peer, principal: peer.principal };
  }
}

export function createPackagedWindowsVaultTransport(): WindowsVaultTransport {
  if (process.platform !== 'win32' || typeof __VAULT_PEER_NATIVE_SHA256__ !== 'string') {
    throw new SecureStorageError('secure_storage_unavailable', 'Windows vault transport is unavailable.');
  }
  return new WindowsVaultTransport({
    expectedExecutablePath: process.execPath,
    expectedNativeModuleSha256: __VAULT_PEER_NATIVE_SHA256__,
    nativeModulePath: resolve(dirname(process.execPath), 'native', 'vault_peer_windows.node'),
  });
}

export function sendWindowsVaultIpcRequest(path: string, request: VaultIpcRequest): VaultIpcResponse {
  return sendWindowsVaultIpcRequestWithTransport(createWindowsVaultTransport(), path, request);
}

export function windowsVaultNativeModulePath(): string {
  if (!usesDevelopmentVault()) return resolve(dirname(process.execPath), 'native', 'vault_peer_windows.node');
  const directory = dirname(fileURLToPath(import.meta.url));
  return resolve(
    directory,
    typeof __VAULT_PEER_NATIVE_RELATIVE_PATH__ === 'string'
      ? __VAULT_PEER_NATIVE_RELATIVE_PATH__
      : `${basename(directory) === 'dist' ? '..' : '../..'}/native/build/vault_peer_windows.node`,
  );
}

export function createWindowsVaultTransport(): WindowsVaultTransport {
  if (!usesDevelopmentVault()) return createPackagedWindowsVaultTransport();
  if (process.platform !== 'win32' || typeof __VAULT_PEER_NATIVE_SHA256__ !== 'string') {
    throw new SecureStorageError('secure_storage_unavailable', 'Windows development vault transport is unavailable.');
  }
  return new WindowsVaultTransport({
    development: true,
    expectedExecutablePath: process.execPath,
    expectedNativeModuleSha256: __VAULT_PEER_NATIVE_SHA256__,
    nativeModulePath: windowsVaultNativeModulePath(),
  });
}

export class WindowsVaultConnection {
  private transport: WindowsVaultTransport | undefined;
  private connection: VerifiedWindowsVaultConnection | undefined;
  private lastUsed = 0;
  private disposed = false;
  private checked = false;

  constructor(
    private readonly path: string,
    private readonly verifyDaemon?: (info: Record<string, unknown>) => void,
    private readonly createTransport = createWindowsVaultTransport,
  ) {}

  request(request: VaultIpcRequest): VaultIpcResponse {
    if (this.disposed)
      throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault connection is closed.');
    try {
      if (this.connection !== undefined && performance.now() - this.lastUsed >= 30_000) this.retire();
      this.transport ??= this.createTransport();
      if (this.connection === undefined) {
        this.connection = this.transport.connect(this.path);
      }
      if (
        !this.checked &&
        this.verifyDaemon !== undefined &&
        !['daemon.info', 'daemon.shutdown', 'vault.status'].includes(request.method)
      ) {
        const info = this.exchange({ ...request, id: `${request.id}_info`, method: 'daemon.info', params: {} });
        try {
          if (!info.ok)
            throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault daemon is unavailable.');
          this.verifyDaemon(info.result);
          this.checked = true;
        } finally {
          clearVaultIpcBytes(info);
        }
      }
      const response = this.exchange(request);
      try {
        if (request.method === 'vault.reset' || request.method === 'daemon.shutdown') this.retire();
        this.lastUsed = performance.now();
        return response;
      } catch (cause) {
        clearVaultIpcBytes(response);
        throw cause;
      }
    } catch (cause) {
      this.retire();
      if (
        cause instanceof Error &&
        'code' in cause &&
        (cause.code === 'EPIPEHANDSHAKE' || cause.code === 'EPIPEEXCHANGE') &&
        'windowsError' in cause &&
        // ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED.
        (cause.windowsError === 109 || cause.windowsError === 232 || cause.windowsError === 233)
      ) {
        throw new SecureStorageError('secure_storage_unavailable', 'The InFlow vault daemon is unavailable.', {
          cause,
        });
      }
      throw cause;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.retire();
  }

  private retire(): void {
    const connection = this.connection;
    this.connection = undefined;
    this.checked = false;
    if (connection !== undefined) this.transport?.close(connection);
  }

  private exchange(request: VaultIpcRequest): VaultIpcResponse {
    if (this.connection === undefined || this.transport === undefined) throw peerVerificationError();
    let outgoing: Buffer | undefined;
    let incoming: Buffer | undefined;
    let response: VaultIpcMessage | undefined;
    try {
      outgoing = encodeVaultIpcMessage(request);
      incoming = this.transport.exchange(this.connection, outgoing);
      response = decodeVaultIpcFrame(incoming);
      if (!('ok' in response) || response.id !== request.id) {
        throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC response is malformed.');
      }
      return response;
    } catch (cause) {
      clearVaultIpcBytes(response);
      throw cause;
    } finally {
      outgoing?.fill(0);
      incoming?.fill(0);
    }
  }
}

/** @internal */
export function sendWindowsVaultIpcRequestWithTransport<Connection>(
  transport: {
    close(connection: Connection): void;
    connect(path: string): Connection;
    exchange(connection: Connection, frame: Buffer): Buffer;
  },
  path: string,
  request: VaultIpcRequest,
): VaultIpcResponse {
  const connection = transport.connect(path);
  let requestFrame: Buffer | undefined;
  let responseFrame: Buffer | undefined;
  let response: VaultIpcMessage | undefined;
  try {
    try {
      requestFrame = encodeVaultIpcMessage(request);
      responseFrame = transport.exchange(connection, requestFrame);
      response = decodeVaultIpcFrame(responseFrame);
      if (!('ok' in response) || response.id !== request.id) {
        throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC response is malformed.');
      }
      return response;
    } finally {
      requestFrame?.fill(0);
      responseFrame?.fill(0);
      transport.close(connection);
    }
  } catch (cause) {
    clearVaultIpcBytes(response);
    throw cause;
  }
}

function canonicalWindowsPath(path: string): string {
  try {
    return realpathSync.native(path).toLowerCase();
  } catch {
    throw peerVerificationError();
  }
}

function peerVerificationError(): SecureStorageError {
  return new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
}
