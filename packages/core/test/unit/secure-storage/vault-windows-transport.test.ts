import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecureStorageError } from '../../../src/secure-storage/errors.js';
import type * as VaultPeerVerifierModule from '../../../src/secure-storage/vault-peer-verifier.js';

const mocks = vi.hoisted(() => {
  const realpath = vi.fn<(path: string) => string>();
  const native = {
    acceptPipeConnection: vi.fn(),
    beginPipeSession: vi.fn(),
    closePipeConnection: vi.fn(),
    completeServiceStop: vi.fn(),
    connectPipe: vi.fn(),
    exchangePipeRequest: vi.fn(),
    markServiceReady: vi.fn(),
    readPipeRequest: vi.fn(),
    runServiceDispatcher: vi.fn(),
    serviceControlState: vi.fn(),
    verifyAuthenticode: vi.fn(),
    writePipeResponse: vi.fn(),
  };
  return { native, realpath, verifyVaultNativeModule: vi.fn() };
});

vi.mock('node:fs', () => ({
  realpathSync: Object.assign(mocks.realpath, { native: mocks.realpath }),
}));
vi.mock('../../../src/secure-storage/runtime-require.js', () => ({
  runtimeRequire: () => () => mocks.native,
}));
vi.mock('../../../src/secure-storage/vault-peer-verifier.js', async (importOriginal) => {
  const original = await importOriginal<typeof VaultPeerVerifierModule>();
  return { ...original, verifyVaultNativeModule: mocks.verifyVaultNativeModule };
});

import {
  sendWindowsVaultIpcRequestWithTransport,
  WindowsVaultTransport,
} from '../../../src/secure-storage/vault-windows-transport.js';
import { encodeVaultIpcMessage } from '../../../src/secure-storage/vault-ipc.js';

const executablePath = 'C:\\Program Files\\InFlow\\inflow.exe';
const nativeModulePath = 'C:\\Program Files\\InFlow\\native\\vault_peer_windows.node';
const peer = { path: executablePath, pid: 42, principal: 'S-1-5-21-1000', uid: 0 };

describe('Windows vault transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.realpath.mockImplementation((path) => path);
    mocks.native.verifyAuthenticode.mockReturnValue({
      publisher: 'InFlow Development Signing',
      thumbprint: 'a'.repeat(64),
    });
    mocks.native.serviceControlState.mockReturnValue({ lockRequested: false, stopRequested: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('verifies the native module and authenticates the daemon before beginning the session', () => {
    const connection = {};
    const order: string[] = [];
    mocks.native.connectPipe.mockImplementation(() => {
      order.push('connect');
      return { connection, peer };
    });
    mocks.native.verifyAuthenticode.mockImplementation(() => {
      order.push('verify');
      return { publisher: 'InFlow Development Signing', thumbprint: 'a'.repeat(64) };
    });
    mocks.native.beginPipeSession.mockImplementation(() => {
      order.push('handshake');
    });

    const transport = createTransport();

    expect(transport.connect('\\\\.\\pipe\\InFlowVault')).toMatchObject({ connection, peer });
    expect(order.slice(-3)).toEqual(['connect', 'verify', 'handshake']);
    expect(mocks.verifyVaultNativeModule).toHaveBeenCalledWith(nativeModulePath, {
      expectedSha256: 'b'.repeat(64),
      expectedTeamId: '',
      requireSignature: false,
    });
  });

  it('closes a verified connection when the authentication handshake fails', () => {
    const connection = {};
    mocks.native.connectPipe.mockReturnValue({ connection, peer });
    mocks.native.beginPipeSession.mockImplementation(() => {
      throw new Error('handshake failed');
    });
    const transport = createTransport();

    expect(() => transport.connect('\\\\.\\pipe\\InFlowVault')).toThrow('handshake failed');
    expect(mocks.native.closePipeConnection).toHaveBeenCalledWith(connection);
  });

  it('rejects and closes peers with the wrong path, principal, publisher, or thumbprint', () => {
    const candidates = [
      { ...peer, path: 'C:\\Temp\\inflow.exe' },
      { ...peer, principal: 'invalid' },
      { ...peer, path: executablePath },
      { ...peer, path: executablePath },
    ];
    const signerResults = [
      { publisher: 'Other Publisher', thumbprint: 'a'.repeat(64) },
      { publisher: 'InFlow Development Signing', thumbprint: 'invalid' },
    ];
    const transport = createTransport();

    for (const candidate of candidates.slice(0, 2)) {
      const connection = {};
      mocks.native.acceptPipeConnection.mockReturnValue({ connection, peer: candidate });
      expect(() => transport.accept('\\\\.\\pipe\\InFlowVault')).toThrow(SecureStorageError);
      expect(mocks.native.closePipeConnection).toHaveBeenLastCalledWith(connection);
    }
    for (const signer of signerResults) {
      const connection = {};
      mocks.native.acceptPipeConnection.mockReturnValue({ connection, peer });
      mocks.native.verifyAuthenticode.mockReturnValueOnce(signer);
      expect(() => transport.accept('\\\\.\\pipe\\InFlowVault')).toThrow(SecureStorageError);
      expect(mocks.native.closePipeConnection).toHaveBeenLastCalledWith(connection);
    }
  });

  it('delegates verified connection operations to the native module', () => {
    const connection = {};
    const frame = Buffer.from('request');
    const response = Buffer.from('response');
    mocks.native.acceptPipeConnection.mockReturnValue({ connection, peer });
    mocks.native.readPipeRequest.mockReturnValue(frame);
    mocks.native.exchangePipeRequest.mockReturnValue(response);
    const transport = createTransport();
    const verified = transport.accept('\\\\.\\pipe\\InFlowVault');

    expect(transport.read(verified)).toBe(frame);
    expect(transport.exchange(verified, frame)).toBe(response);
    transport.write(verified, response);
    transport.close(verified);
    transport.markServiceReady();
    transport.runServiceDispatcher();
    expect(transport.serviceControlState()).toEqual({ lockRequested: false, stopRequested: false });
    transport.completeServiceStop();

    expect(mocks.native.writePipeResponse).toHaveBeenCalledWith(connection, response);
    expect(mocks.native.closePipeConnection).toHaveBeenCalledWith(connection);
    expect(mocks.native.markServiceReady).toHaveBeenCalledOnce();
    expect(mocks.native.runServiceDispatcher).toHaveBeenCalledOnce();
    expect(mocks.native.completeServiceStop).toHaveBeenCalledOnce();
  });

  it('fails closed for an invalid self signature and an unreadable canonical path', () => {
    mocks.native.verifyAuthenticode.mockReturnValueOnce({
      publisher: 'InFlow Development Signing',
      thumbprint: 'invalid',
    });
    expect(() => createTransport()).toThrow(SecureStorageError);

    mocks.realpath.mockImplementationOnce(() => {
      throw new Error('unreadable');
    });
    expect(() => createTransport()).toThrow(SecureStorageError);
  });

  it('exchanges one Windows IPC request and clears request and response frames', () => {
    const connection = {};
    const responseFrame = encodeVaultIpcMessage({
      id: 'request-1',
      ok: true,
      result: { lockState: 'locked' },
      version: 1,
    });
    const transport = {
      close: vi.fn(),
      connect: vi.fn(() => ({ connection, peer })),
      exchange: vi.fn(() => responseFrame),
    };

    expect(
      sendWindowsVaultIpcRequestWithTransport(transport, '\\\\.\\pipe\\InFlowVault', {
        id: 'request-1',
        method: 'vault.status',
        params: {},
        version: 1,
      }),
    ).toMatchObject({ id: 'request-1', ok: true });
    expect(transport.connect).toHaveBeenCalledWith('\\\\.\\pipe\\InFlowVault');
    expect(transport.close).toHaveBeenCalledWith({ connection, peer });
    expect(responseFrame).toEqual(Buffer.alloc(responseFrame.byteLength));
  });

  it('rejects malformed Windows IPC responses and still clears their bytes', () => {
    for (const response of [
      { id: 'other', ok: true as const, result: {}, version: 1 as const },
      { id: 'request-1', method: 'vault.status' as const, params: {}, version: 1 as const },
    ]) {
      const responseFrame = encodeVaultIpcMessage(response);
      const transport = {
        close: vi.fn(),
        connect: vi.fn(() => ({ connection: {}, peer })),
        exchange: vi.fn(() => responseFrame),
      };
      expect(() =>
        sendWindowsVaultIpcRequestWithTransport(transport, '\\\\.\\pipe\\InFlowVault', {
          id: 'request-1',
          method: 'vault.status',
          params: {},
          version: 1,
        }),
      ).toThrow('Vault IPC response is malformed');
      expect(transport.close).toHaveBeenCalledOnce();
      expect(responseFrame).toEqual(Buffer.alloc(responseFrame.byteLength));
    }
  });
});

function createTransport(): WindowsVaultTransport {
  return new WindowsVaultTransport({
    expectedExecutablePath: executablePath,
    expectedNativeModuleSha256: 'b'.repeat(64),
    nativeModulePath,
  });
}
