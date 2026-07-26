import type { Buffer } from 'node:buffer';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { SecureStorageError } from './errors.js';
import { runtimeRequire } from './runtime-require.js';
import {
  decodeVaultIpcFrame,
  encodeVaultIpcMessage,
  type VaultIpcRequest,
  type VaultIpcResponse,
} from './vault-ipc.js';
import { verifyVaultNativeModule, type VaultSocketPeer } from './vault-peer-verifier.js';

declare const __VAULT_PEER_NATIVE_SHA256__: string | undefined;

const verifiedConnection = Symbol('verifiedWindowsVaultConnection');

interface WindowsVaultPipeConnection {
  readonly connection: unknown;
}

interface WindowsVaultNativeModule {
  acceptPipeConnection(path: string): { connection: unknown; peer: VaultSocketPeer };
  beginPipeSession(connection: unknown): void;
  closePipeConnection(connection: unknown): void;
  connectPipe(path: string): { connection: unknown; peer: VaultSocketPeer };
  exchangePipeRequest(connection: unknown, frame: Buffer): Buffer;
  readPipeRequest(connection: unknown): Buffer;
  runServiceDispatcher(): void;
  markServiceReady(): void;
  serviceControlState(): { lockRequested: boolean; stopRequested: boolean };
  completeServiceStop(): void;
  verifyAuthenticode(path: string): { publisher: string; thumbprint: string };
  writePipeResponse(connection: unknown, frame: Buffer): void;
}

export interface WindowsVaultTransportOptions {
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
  private readonly expectedPublisher: string;
  private readonly native: WindowsVaultNativeModule;

  constructor(options: WindowsVaultTransportOptions) {
    verifyVaultNativeModule(options.nativeModulePath, {
      expectedSha256: options.expectedNativeModuleSha256,
      expectedTeamId: '',
      requireSignature: false,
    });
    this.native = runtimeRequire()(options.nativeModulePath) as WindowsVaultNativeModule;
    this.expectedExecutablePath = canonicalWindowsPath(options.expectedExecutablePath);
    const selfSigner = this.native.verifyAuthenticode(this.expectedExecutablePath);
    if (!/^[0-9a-f]{64}$/u.test(selfSigner.thumbprint)) throw peerVerificationError();
    this.expectedPublisher = options.expectedPublisher ?? selfSigner.publisher;
  }

  accept(path: string): VerifiedWindowsVaultConnection {
    return this.verify(this.native.acceptPipeConnection(path));
  }

  connect(path: string): VerifiedWindowsVaultConnection {
    const connection = this.verify(this.native.connectPipe(path));
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

  read(connection: VerifiedWindowsVaultConnection): Buffer {
    return this.native.readPipeRequest(connection.connection);
  }

  write(connection: VerifiedWindowsVaultConnection, frame: Buffer): void {
    this.native.writePipeResponse(connection.connection, frame);
  }

  completeServiceStop(): void {
    this.native.completeServiceStop();
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
      const { peer } = candidate;
      if (
        peer.principal === undefined ||
        !/^S-\d+(?:-\d+)+$/u.test(peer.principal) ||
        canonicalWindowsPath(peer.path) !== this.expectedExecutablePath
      ) {
        throw peerVerificationError();
      }
      const signer = this.native.verifyAuthenticode(peer.path);
      if (signer.publisher !== this.expectedPublisher || !/^[0-9a-f]{64}$/u.test(signer.thumbprint)) {
        throw peerVerificationError();
      }
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
  const transport = createPackagedWindowsVaultTransport();
  const connection = transport.connect(path);
  const requestFrame = encodeVaultIpcMessage(request);
  let responseFrame: Buffer | undefined;
  try {
    responseFrame = transport.exchange(connection, requestFrame);
    const response = decodeVaultIpcFrame(responseFrame);
    if (!('ok' in response) || response.id !== request.id) {
      throw new SecureStorageError('secure_storage_corrupt', 'Vault IPC response is malformed.');
    }
    return response;
  } finally {
    requestFrame.fill(0);
    responseFrame?.fill(0);
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
