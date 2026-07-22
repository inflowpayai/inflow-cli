import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  VAULT_IPC_MAX_MESSAGE_BYTES,
  VAULT_IPC_METHODS,
  decodeVaultIpcFrame,
  encodeVaultIpcMessage,
  type VaultIpcMethod,
} from '../../../src/secure-storage/vault-ipc.js';

describe('vault IPC framing', () => {
  it('round-trips length-prefixed requests and responses', () => {
    const request = {
      id: 'req_1',
      method: 'vault.status' as const,
      params: {},
      version: 1 as const,
    };
    const success = {
      id: 'req_1',
      ok: true as const,
      result: { lockState: 'locked' },
      version: 1 as const,
    };
    const failure = {
      error: { code: 'VAULT_LOCKED', message: 'The InFlow vault is locked.' },
      id: 'req_1',
      ok: false as const,
      version: 1 as const,
    };

    expect(decodeVaultIpcFrame(encodeVaultIpcMessage(request))).toEqual(request);
    expect(decodeVaultIpcFrame(encodeVaultIpcMessage(success))).toEqual(success);
    expect(decodeVaultIpcFrame(encodeVaultIpcMessage(failure))).toEqual(failure);
  });

  it('keeps the method list generic and protocol-free', () => {
    const methods = VAULT_IPC_METHODS satisfies readonly VaultIpcMethod[];

    expect(methods).toContain('secret.get');
    expect(methods).not.toContain('aep.grant' as VaultIpcMethod);
    expect(methods).not.toContain('mpp.pay' as VaultIpcMethod);
    expect(methods).not.toContain('x402.pay' as VaultIpcMethod);
    expect(methods).not.toContain('fetch' as VaultIpcMethod);
    expect(methods).not.toContain('sign' as VaultIpcMethod);
  });

  it('rejects malformed, trailing, oversized, and unknown-method frames', () => {
    const request = {
      id: 'req_1',
      method: 'vault.status' as const,
      params: {},
      version: 1 as const,
    };
    const frame = encodeVaultIpcMessage(request);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(VAULT_IPC_MAX_MESSAGE_BYTES + 1, 0);

    expect(() => decodeVaultIpcFrame(frame.subarray(0, 3))).toThrow('Vault IPC frame is truncated.');
    expect(() => decodeVaultIpcFrame(Buffer.concat([frame, Buffer.from([0])]))).toThrow(
      'Vault IPC frame length is invalid.',
    );
    expect(() => decodeVaultIpcFrame(oversized)).toThrow('Vault IPC message is too large.');
    expect(() =>
      decodeVaultIpcFrame(
        encodeVaultIpcMessage({
          ...request,
          method: 'aep.grant' as VaultIpcMethod,
        }),
      ),
    ).toThrow('Vault IPC request is malformed.');
  });

  it('rejects unknown versions and malformed responses', () => {
    const unknownVersion = Buffer.from(JSON.stringify({ id: 'req_1', params: {}, version: 2 }), 'utf8');
    const malformedResponse = Buffer.from(JSON.stringify({ id: 'req_1', ok: false, version: 1 }), 'utf8');
    const unknownVersionFrame = Buffer.alloc(4 + unknownVersion.byteLength);
    const malformedResponseFrame = Buffer.alloc(4 + malformedResponse.byteLength);
    unknownVersionFrame.writeUInt32BE(unknownVersion.byteLength, 0);
    malformedResponseFrame.writeUInt32BE(malformedResponse.byteLength, 0);
    unknownVersion.copy(unknownVersionFrame, 4);
    malformedResponse.copy(malformedResponseFrame, 4);

    expect(() => decodeVaultIpcFrame(unknownVersionFrame)).toThrow('Vault IPC message is malformed.');
    expect(() => decodeVaultIpcFrame(malformedResponseFrame)).toThrow('Vault IPC response is malformed.');
  });
});
