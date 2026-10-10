import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import {
  VAULT_IPC_MAX_MESSAGE_BYTES,
  VAULT_IPC_METHODS,
  clearVaultIpcBytes,
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

  it('rejects malformed attachment framing and references', () => {
    expect(() =>
      encodeVaultIpcMessage({
        id: 'large',
        method: 'secret.put',
        params: { expectedKind: 'inflow_api_key', payload: Buffer.alloc(VAULT_IPC_MAX_MESSAGE_BYTES) },
        version: 1,
      }),
    ).toThrow('Vault IPC message is too large.');

    expect(() => decodeVaultIpcFrame(rawFrame({}, { jsonLength: 100 }))).toThrow(
      'Vault IPC frame attachments are malformed.',
    );
    expect(() => decodeVaultIpcFrame(rawFrame({}, { attachmentCount: 1 }))).toThrow(
      'Vault IPC frame attachments are malformed.',
    );
    expect(() =>
      decodeVaultIpcFrame(rawFrame({}, { attachment: Buffer.from([0, 0, 0, 4]), attachmentCount: 1 })),
    ).toThrow('Vault IPC frame attachments are malformed.');
    expect(() =>
      decodeVaultIpcFrame(rawFrame({}, { attachment: Buffer.from([0, 0, 0, 1, 0]), attachmentCount: 1 })),
    ).toThrow('Vault IPC attachment masking is malformed.');
    expect(() => decodeVaultIpcFrame(rawFrame({}, { attachment: Buffer.from([0]) }))).toThrow(
      'Vault IPC frame attachments are malformed.',
    );
    expect(() =>
      decodeVaultIpcFrame(rawFrame({ id: 'req', params: { payload: { $inflowVaultAttachment: 0 } }, version: 1 })),
    ).toThrow('Vault IPC attachment reference is malformed.');
  });

  it('clears nested mutable IPC byte values', () => {
    const first = Buffer.from('first');
    const second = Buffer.from('second');
    clearVaultIpcBytes({ nested: [first, { second }], scalar: 'unchanged' });
    expect(first).toEqual(Buffer.alloc(5));
    expect(second).toEqual(Buffer.alloc(6));
  });

  it.each(['framing', 'json', 'reference', 'message', 'request', 'response'])(
    'clears allocated attachments after a later %s failure without changing caller input',
    (failure) => {
      const value = { id: 'req', method: 'secret.put', params: { payload: { $inflowVaultAttachment: 0 } }, version: 1 };
      const frame = rawFrame(
        failure === 'reference'
          ? { ...value, extra: { $inflowVaultAttachment: 1 } }
          : failure === 'message'
            ? { ...value, version: 2 }
            : failure === 'request'
              ? { ...value, method: 'invalid' }
              : failure === 'response'
                ? { id: 'req', ok: true, version: 1 }
                : value,
        { attachment: Buffer.from([0, 0, 0, 4, 0, 0, 65, 66]), attachmentCount: failure === 'framing' ? 2 : 1 },
      );
      if (failure === 'json') frame[12] = 0;
      const original = Buffer.from(frame);
      const allocated: Buffer[] = [];
      const alloc = Buffer.alloc.bind(Buffer);
      const spy = vi.spyOn(Buffer, 'alloc').mockImplementation((size) => {
        const buffer = alloc(size);
        allocated.push(buffer);
        return buffer;
      });
      try {
        expect(() => decodeVaultIpcFrame(frame)).toThrow();
        expect(allocated).toHaveLength(1);
        expect([...(allocated[0] ?? [])]).toEqual([0, 0]);
        expect(frame).toEqual(original);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each(['request', 'success', 'error'])('clears discarded attachments in a valid %s', (kind) => {
    const marker = { $inflowVaultAttachment: 0 };
    const value =
      kind === 'request'
        ? {
            id: 'req',
            method: 'secret.put',
            params: { nested: [marker, marker], scalar: null },
            extra: { $inflowVaultAttachment: 1 },
            version: 1,
          }
        : kind === 'success'
          ? { id: 'req', ok: true, result: { nested: [marker] }, extra: { $inflowVaultAttachment: 1 }, version: 1 }
          : { id: 'req', ok: false, error: { code: 'error', message: 'failure', extra: marker }, version: 1 };
    const frame = rawFrame(value, {
      attachment: Buffer.from([0, 0, 0, 4, 0, 0, 65, 66, 0, 0, 0, 4, 0, 0, 67, 68, 0, 0, 0, 4, 0, 0, 69, 70]),
      attachmentCount: 3,
    });
    const original = Buffer.from(frame);
    const allocated: Buffer[] = [];
    const alloc = Buffer.alloc.bind(Buffer);
    const spy = vi.spyOn(Buffer, 'alloc').mockImplementation((size) => {
      const buffer = alloc(size);
      allocated.push(buffer);
      return buffer;
    });
    try {
      const message = decodeVaultIpcFrame(frame);
      expect(allocated).toHaveLength(3);
      expect([...(allocated[0] ?? [])]).toEqual(kind === 'error' ? [0, 0] : [65, 66]);
      expect([...(allocated[1] ?? [])]).toEqual([0, 0]);
      expect([...(allocated[2] ?? [])]).toEqual([0, 0]);
      expect(frame).toEqual(original);
      clearVaultIpcBytes(message);
      expect([...(allocated[0] ?? [])]).toEqual([0, 0]);
    } finally {
      spy.mockRestore();
    }
  });
});

function rawFrame(
  value: unknown,
  options: { attachment?: Buffer; attachmentCount?: number; jsonLength?: number } = {},
): Buffer {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  const attachment = options.attachment ?? Buffer.alloc(0);
  const frame = Buffer.alloc(12 + json.byteLength + attachment.byteLength);
  frame.writeUInt32BE(8 + json.byteLength + attachment.byteLength, 0);
  frame.writeUInt32BE(options.jsonLength ?? json.byteLength, 4);
  frame.writeUInt32BE(options.attachmentCount ?? 0, 8);
  json.copy(frame, 12);
  attachment.copy(frame, 12 + json.byteLength);
  return frame;
}
