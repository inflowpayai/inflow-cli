import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  methods: [] as string[],
  sendWindowsVaultIpcRequest: vi.fn(),
}));

vi.mock('node:process', () => ({ default: { platform: 'win32' } }));
vi.mock('../../../src/secure-storage/vault-files.js', () => ({
  linuxVaultServiceUserId: vi.fn(),
  usesLinuxVaultService: () => false,
  vaultFilePaths: () => ({ socket: '\\\\.\\pipe\\InFlowVault' }),
}));
vi.mock('../../../src/secure-storage/vault-windows-transport.js', () => ({
  sendWindowsVaultIpcRequest: mocks.sendWindowsVaultIpcRequest,
}));

import { SyncVaultSecretStore } from '../../../src/secure-storage/vault-sync-secret-store.js';

describe('SyncVaultSecretStore on Windows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.methods.length = 0;
  });

  it('uses the authenticated native Windows transport for synchronous secret operations', () => {
    mocks.sendWindowsVaultIpcRequest.mockImplementation((_path: string, request: { id: string; method: string }) => {
      mocks.methods.push(request.method);
      return {
        id: request.id,
        ok: true,
        result: request.method === 'secret.get' ? { payload: Buffer.from('stored-secret') } : {},
        version: 1,
      };
    });
    const store = new SyncVaultSecretStore();
    const reference = { purpose: 'api-key', reference: 'windows-api-key' } as const;

    store.create(reference, Buffer.from('stored-secret'));
    expect(Buffer.from(store.read(reference)).toString('utf8')).toBe('stored-secret');
    store.delete(reference);

    expect(mocks.sendWindowsVaultIpcRequest).toHaveBeenCalledTimes(3);
    expect(mocks.methods).toEqual(['secret.put', 'secret.get', 'secret.delete']);
    expect(mocks.sendWindowsVaultIpcRequest.mock.calls[0]?.[0]).toBe('\\\\.\\pipe\\InFlowVault');
  });
});
