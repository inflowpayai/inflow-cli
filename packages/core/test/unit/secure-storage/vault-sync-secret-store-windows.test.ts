import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultIpcResponse } from '../../../src/secure-storage/vault-ipc.js';

const mocks = vi.hoisted(() => ({
  methods: [] as string[],
  sendWindowsVaultIpcRequest: vi.fn<(path: string, request: { id: string; method: string }) => VaultIpcResponse>(),
  dispose: vi.fn(),
  construct: vi.fn(),
  verify: undefined as ((info: Record<string, unknown>) => void) | undefined,
}));

vi.mock('node:process', () => ({ default: { platform: 'win32' } }));
vi.mock('../../../src/secure-storage/vault-files.js', () => ({
  linuxVaultServiceUserId: vi.fn(),
  usesLinuxVaultService: () => false,
  vaultFilePaths: () => ({ socket: '\\\\.\\pipe\\InFlowVault' }),
}));
vi.mock('../../../src/secure-storage/vault-windows-transport.js', () => ({
  WindowsVaultConnection: class {
    constructor(
      private readonly path: string,
      verify?: (info: Record<string, unknown>) => void,
    ) {
      mocks.construct(path);
      mocks.verify = verify;
    }
    request(request: { id: string; method: string }) {
      return mocks.sendWindowsVaultIpcRequest(this.path, request);
    }
    dispose = mocks.dispose;
  },
}));

import { SyncVaultSecretStore } from '../../../src/secure-storage/vault-sync-secret-store.js';

describe('SyncVaultSecretStore on Windows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.methods.length = 0;
    mocks.sendWindowsVaultIpcRequest.mockImplementation((_path: string, request: { id: string; method: string }) => {
      mocks.methods.push(request.method);
      return {
        id: request.id,
        ok: true,
        result: request.method === 'secret.get' ? { payload: Buffer.from('stored-secret') } : {},
        version: 1,
      };
    });
  });

  it('uses the authenticated native Windows transport for synchronous secret operations', () => {
    const store = new SyncVaultSecretStore();
    const reference = { purpose: 'api-key', reference: 'windows-api-key' } as const;

    store.create(reference, Buffer.from('stored-secret'));
    expect(Buffer.from(store.read(reference)).toString('utf8')).toBe('stored-secret');
    store.delete(reference);

    expect(mocks.sendWindowsVaultIpcRequest).toHaveBeenCalledTimes(3);
    expect(mocks.methods).toEqual(['secret.put', 'secret.get', 'secret.delete']);
    expect(mocks.sendWindowsVaultIpcRequest.mock.calls[0]?.[0]).toBe('\\\\.\\pipe\\InFlowVault');
    expect(mocks.construct).toHaveBeenCalledOnce();
    store.dispose();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('validates the expected daemon on the retained Windows connection', () => {
    const expected = { buildId: 'one', cliVersion: '1.0.0', executablePath: process.execPath };
    const store = new SyncVaultSecretStore({ expectedDaemon: expected });
    store.delete({ purpose: 'api-key', reference: 'key' });
    expect(mocks.verify).toBeTypeOf('function');
    expect(() => mocks.verify?.({ ...expected, pid: 1 })).not.toThrow();
    for (const override of [
      { buildId: 'other' },
      { cliVersion: 'other' },
      { executablePath: '/other' },
      { pid: 'bad' },
    ]) {
      expect(() => mocks.verify?.({ ...expected, pid: 1, ...override })).toThrow('incompatible');
    }
    store.dispose();
  });
});
