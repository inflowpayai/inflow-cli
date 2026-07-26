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

  it('keeps sensitive bytes out of immutable JSON values', () => {
    const secret = Buffer.from('binary-only-secret');
    const frame = encodeVaultIpcMessage({
      id: 'req_secret',
      method: 'secret.put',
      params: { expectedKind: 'inflow_api_key', payload: secret },
      version: 1,
    });
    const jsonLength = frame.readUInt32BE(4);
    const json = frame.subarray(12, 12 + jsonLength).toString('utf8');

    expect(json).not.toContain(secret.toString('utf8'));
    expect(decodeVaultIpcFrame(frame)).toMatchObject({
      params: { payload: secret },
    });
  });

  it('rejects malformed, trailing, oversized, and unknown-method frames', () => {
    const request = {
      id: 'req_1',
      method: 'vault.status' as const,
      params: {},
      version: 1 as const,
    };
    const frame = encodeVaultIpcMessage(request);
    const oversized = Buffer.alloc(12);
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
    const unknownVersionFrame = rawFrame({ id: 'req_1', params: {}, version: 2 });
    const malformedResponseFrame = rawFrame({ id: 'req_1', ok: false, version: 1 });

    expect(() => decodeVaultIpcFrame(unknownVersionFrame)).toThrow('Vault IPC message is malformed.');
    expect(() => decodeVaultIpcFrame(malformedResponseFrame)).toThrow('Vault IPC response is malformed.');
  });
});

function rawFrame(value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  const frame = Buffer.alloc(12 + json.byteLength);
  frame.writeUInt32BE(8 + json.byteLength, 0);
  frame.writeUInt32BE(json.byteLength, 4);
  frame.writeUInt32BE(0, 8);
  json.copy(frame, 12);
  return frame;
}
