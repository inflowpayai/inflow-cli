import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecureStorageError } from '../../../src/secure-storage/errors.js';
import type * as VaultPeerVerifierModule from '../../../src/secure-storage/vault-peer-verifier.js';

const mocks = vi.hoisted(() => {
  const realpath = vi.fn<(path: string) => string>();
  const native = {
    startPipeDispatcher: vi.fn(),
    stopPipeDispatcher: vi.fn(),
    pipeDispatcherState: vi.fn(),
    submitPipeDispatcher: vi.fn(),
    beginPipeSession: vi.fn(),
    closePipeConnection: vi.fn(),
    completeServiceStop: vi.fn(),
    connectPipe: vi.fn(),
    exchangePipeRequest: vi.fn(),
    markServiceReady: vi.fn(),
    requestServiceStop: vi.fn(),
    runServiceDispatcher: vi.fn(),
    serviceControlState: vi.fn(),
    verifyAuthenticode: vi.fn(),
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
  WindowsVaultConnection,
} from '../../../src/secure-storage/vault-windows-transport.js';
import {
  decodeVaultIpcFrame,
  encodeVaultIpcMessage,
  VAULT_IPC_MAX_MESSAGE_BYTES,
} from '../../../src/secure-storage/vault-ipc.js';

const executablePath = 'C:\\Program Files\\InFlow\\inflow.exe';
const nativeModulePath = 'C:\\Program Files\\InFlow\\native\\vault_peer_windows.node';
const peer = { path: executablePath, pid: 42, principal: 'S-1-5-21-1000', uid: 0 };

describe('Windows vault transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.native.beginPipeSession.mockReset();
    mocks.native.submitPipeDispatcher.mockReset().mockReturnValue(true);
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
      mocks.native.connectPipe.mockReturnValue({ connection, peer: candidate });
      expect(() => transport.connect('\\\\.\\pipe\\InFlowVault')).toThrow(SecureStorageError);
      expect(mocks.native.closePipeConnection).toHaveBeenLastCalledWith(connection);
    }
    for (const signer of signerResults) {
      const connection = {};
      mocks.native.connectPipe.mockReturnValue({ connection, peer });
      mocks.native.verifyAuthenticode.mockReturnValueOnce(signer);
      expect(() => transport.connect('\\\\.\\pipe\\InFlowVault')).toThrow(SecureStorageError);
      expect(mocks.native.closePipeConnection).toHaveBeenLastCalledWith(connection);
    }
  });

  it('delegates verified connection operations to the native module', () => {
    const connection = {};
    const frame = Buffer.from('request');
    const response = Buffer.from('response');
    mocks.native.connectPipe.mockReturnValue({ connection, peer });
    mocks.native.exchangePipeRequest.mockReturnValue(response);
    const transport = createTransport();
    const verified = transport.connect('\\\\.\\pipe\\InFlowVault');

    expect(transport.exchange(verified, frame)).toBe(response);
    transport.close(verified);
    transport.markServiceReady();
    transport.runServiceDispatcher();
    expect(transport.serviceControlState()).toEqual({ lockRequested: false, stopRequested: false });
    transport.completeServiceStop();
    transport.requestServiceStop();

    expect(mocks.native.closePipeConnection).toHaveBeenCalledWith(connection);
    expect(mocks.native.markServiceReady).toHaveBeenCalledOnce();
    expect(mocks.native.runServiceDispatcher).toHaveBeenCalledOnce();
    expect(mocks.native.completeServiceStop).toHaveBeenCalledOnce();
    expect(mocks.native.requestServiceStop).toHaveBeenCalledOnce();
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

  it('authorizes native peers before routing frames and retires the exact generation', () => {
    const transport = createTransport();
    const callback = vi.fn();
    transport.startDispatcher('pipe', callback);
    const deliver = mocks.native.startPipeDispatcher.mock.calls[0]?.[1] as (event: object) => void;
    const identity = { slot: 0, generation: 1, sequence: 0 };
    deliver({ ...identity, type: 'verify', peer });
    expect(mocks.native.submitPipeDispatcher).toHaveBeenLastCalledWith(0, 1, 0, true, null);
    const frame = Buffer.from([1]);
    deliver({ ...identity, sequence: 1, type: 'request', frame });
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ peer, type: 'request' }));
    expect(frame).toEqual(Buffer.from([0]));
    deliver({ ...identity, generation: 2, type: 'closed' });
    deliver({ ...identity, sequence: 2, type: 'request', frame: Buffer.from([2]) });
    deliver({ ...identity, type: 'closed' });
    const rejected = Buffer.from([3]);
    expect(() => deliver({ ...identity, sequence: 3, type: 'request', frame: rejected })).toThrow(
      'peer verification failed',
    );
    expect(rejected).toEqual(Buffer.from([0]));
    transport.stopDispatcher();
    expect(mocks.native.stopPipeDispatcher).toHaveBeenCalledOnce();
  });

  it('rejects native authorization when the existing signature policy fails', () => {
    const transport = createTransport();
    transport.startDispatcher('pipe', vi.fn());
    const deliver = mocks.native.startPipeDispatcher.mock.calls[0]?.[1] as (event: object) => void;
    mocks.native.verifyAuthenticode.mockReturnValueOnce({ publisher: 'wrong', thumbprint: 'a'.repeat(64) });
    deliver({ slot: 0, generation: 1, sequence: 0, type: 'verify', peer });
    expect(mocks.native.submitPipeDispatcher).toHaveBeenLastCalledWith(0, 1, 0, false, null);
  });

  it('reuses a verified Windows connection and checks compatibility on each replacement', () => {
    const expected = vi.fn();
    mocks.native.connectPipe.mockReturnValue({ connection: {}, peer });
    const methods: string[] = [];
    mocks.native.exchangePipeRequest.mockImplementation((_connection, frame: Buffer) => {
      const request = decodeVaultIpcFrame(frame);
      if (!('method' in request)) throw new Error('expected request');
      methods.push(request.method);
      return encodeVaultIpcMessage({ id: request.id, ok: true, result: {}, version: 1 });
    });
    const connection = new WindowsVaultConnection('pipe', expected, createTransport);
    const request = { id: 'one', method: 'vault.getPolicy', params: {}, version: 1 } as const;
    connection.request(request);
    connection.request(request);
    expect(methods).toEqual(['daemon.info', 'vault.getPolicy', 'vault.getPolicy']);
    expect(mocks.native.connectPipe).toHaveBeenCalledOnce();
    expect(expected).toHaveBeenCalledOnce();
    mocks.native.exchangePipeRequest.mockImplementationOnce(() => {
      throw new Error('broken pipe');
    });
    expect(() => connection.request(request)).toThrow('broken pipe');
    expect(mocks.native.connectPipe).toHaveBeenCalledOnce();
    connection.request(request);
    expect(mocks.native.connectPipe).toHaveBeenCalledTimes(2);
    expect(expected).toHaveBeenCalledTimes(2);
    connection.dispose();
    expect(() => connection.request(request)).toThrow('connection is closed');
    expect(mocks.native.closePipeConnection).toHaveBeenCalledTimes(2);
  });

  it('does not send an operation when same-connection compatibility fails', () => {
    mocks.native.connectPipe.mockReturnValue({ connection: {}, peer });
    mocks.native.exchangePipeRequest.mockImplementation((_connection, frame: Buffer) => {
      const request = decodeVaultIpcFrame(frame);
      return encodeVaultIpcMessage({ id: request.id, ok: true, result: {}, version: 1 });
    });
    const connection = new WindowsVaultConnection(
      'pipe',
      () => {
        throw new Error('incompatible');
      },
      createTransport,
    );
    expect(() => connection.request({ id: 'status', method: 'vault.status', params: {}, version: 1 })).not.toThrow();
    mocks.native.exchangePipeRequest.mockClear();
    expect(() => connection.request({ id: 'one', method: 'secret.delete', params: {}, version: 1 })).toThrow(
      'incompatible',
    );
    expect(mocks.native.exchangePipeRequest).toHaveBeenCalledOnce();
    expect(mocks.native.closePipeConnection).toHaveBeenCalledOnce();
  });

  it.each(['idle', 'reset', 'malformed', 'encoding', 'close-failure', 'info-error'])(
    'retires the Windows connection safely: %s',
    (scenario) => {
      mocks.native.connectPipe.mockReturnValue({ connection: {}, peer });
      mocks.native.closePipeConnection.mockReset();
      let clock = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => clock);
      mocks.native.exchangePipeRequest.mockImplementation((_connection, frame: Buffer) => {
        const request = decodeVaultIpcFrame(frame);
        if (!('method' in request)) throw new Error('expected request');
        if (scenario === 'info-error')
          return encodeVaultIpcMessage({
            id: request.id,
            ok: false,
            error: { code: 'secure_storage_unavailable', message: 'Unavailable' },
            version: 1,
          });
        return encodeVaultIpcMessage({
          id: scenario === 'malformed' ? 'wrong' : request.id,
          ok: true,
          result: {},
          version: 1,
        });
      });
      const connection = new WindowsVaultConnection(
        'pipe',
        scenario === 'info-error' ? () => undefined : undefined,
        createTransport,
      );
      const request = {
        id: 'one',
        method: scenario === 'reset' || scenario === 'close-failure' ? 'vault.reset' : 'vault.getPolicy',
        params: {},
        version: 1,
      } as const;
      if (scenario === 'close-failure')
        mocks.native.closePipeConnection.mockImplementationOnce(() => {
          throw new Error('close failed');
        });
      if (scenario === 'encoding') {
        expect(() =>
          connection.request({ ...request, params: { payload: Buffer.alloc(VAULT_IPC_MAX_MESSAGE_BYTES) } }),
        ).toThrow('too large');
        expect(mocks.native.exchangePipeRequest).not.toHaveBeenCalled();
      } else if (['malformed', 'info-error', 'close-failure'].includes(scenario))
        expect(() => connection.request(request)).toThrow();
      else {
        connection.request(request);
        clock = 30_001;
        connection.request(request);
        expect(mocks.native.connectPipe).toHaveBeenCalledTimes(2);
      }
      connection.dispose();
      expect(mocks.native.closePipeConnection).toHaveBeenCalled();
    },
  );

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
    expect(transport.close).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledWith({ connection, peer });
    expect(responseFrame).toEqual(Buffer.alloc(responseFrame.byteLength));
  });

  it('closes a Windows IPC connection once when exchange fails', () => {
    const connection = { connection: {}, peer };
    const transport = {
      close: vi.fn(),
      connect: vi.fn(() => connection),
      exchange: vi.fn(() => {
        throw new Error('exchange failed');
      }),
    };

    expect(() =>
      sendWindowsVaultIpcRequestWithTransport(transport, '\\\\.\\pipe\\InFlowVault', {
        id: 'request-1',
        method: 'vault.status',
        params: {},
        version: 1,
      }),
    ).toThrow('exchange failed');
    expect(transport.close).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledWith(connection);
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

  it('closes the connection when real request encoding fails without sending anything', () => {
    const connection = {};
    const transport = { close: vi.fn(), connect: vi.fn(() => connection), exchange: vi.fn() };
    const payload = Buffer.alloc(VAULT_IPC_MAX_MESSAGE_BYTES, 65);
    expect(() =>
      sendWindowsVaultIpcRequestWithTransport(transport, 'pipe', {
        id: 'request-1',
        method: 'secret.put',
        params: { payload },
        version: 1,
      }),
    ).toThrow('Vault IPC message is too large.');
    expect(transport.exchange).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledWith(connection);
    expect(payload.every((byte) => byte === 65)).toBe(true);
  });

  it.each(['wrong-id', 'wrong-type', 'close-failure', 'success'])(
    'retains decoded bytes only when returned to the caller: %s',
    (scenario) => {
      const payload = Buffer.from([65, 66]);
      const frame = encodeVaultIpcMessage(
        scenario === 'wrong-type'
          ? { id: 'request-1', method: 'secret.put', params: { payload }, version: 1 }
          : { id: scenario === 'wrong-id' ? 'other' : 'request-1', ok: true, result: { payload }, version: 1 },
      );
      const connection = {};
      let sent: Buffer | undefined;
      const transport = {
        close: vi.fn(() => {
          if (scenario === 'close-failure') throw new Error('close failed');
        }),
        connect: vi.fn(() => connection),
        exchange: vi.fn((_connection: object, request: Buffer) => {
          sent = request;
          return frame;
        }),
      };
      const allocated: Buffer[] = [];
      const alloc = Buffer.alloc.bind(Buffer);
      vi.spyOn(Buffer, 'alloc').mockImplementation((size) => {
        const buffer = alloc(size);
        allocated.push(buffer);
        return buffer;
      });
      const run = () =>
        sendWindowsVaultIpcRequestWithTransport(transport, 'pipe', {
          id: 'request-1',
          method: 'secret.get',
          params: {},
          version: 1,
        });
      if (scenario === 'success') expect(run()).toMatchObject({ result: { payload } });
      else expect(run).toThrow(scenario === 'close-failure' ? 'close failed' : 'Vault IPC response is malformed.');
      expect(allocated).toHaveLength(2);
      expect([...(allocated[1] ?? [])]).toEqual(scenario === 'success' ? [65, 66] : [0, 0]);
      expect(sent).toBeDefined();
      expect(sent?.every((byte) => byte === 0)).toBe(true);
      expect(frame.every((byte) => byte === 0)).toBe(true);
      expect(payload).toEqual(Buffer.from([65, 66]));
      expect(transport.close).toHaveBeenCalledOnce();
      expect(transport.close).toHaveBeenCalledWith(connection);
    },
  );
});

function createTransport(): WindowsVaultTransport {
  return new WindowsVaultTransport({
    expectedExecutablePath: executablePath,
    expectedNativeModuleSha256: 'b'.repeat(64),
    nativeModulePath,
  });
}
