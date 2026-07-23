import { Socket } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecureStorageError } from '../../../src/secure-storage/errors.js';
import {
  createVaultSocketPeerVerifier,
  shouldRequireVaultPeerVerification,
  socketFileDescriptor,
  type VaultSocketPeer,
} from '../../../src/secure-storage/vault-peer-verifier.js';

describe('vault peer verifier', () => {
  const originalPlatform = process.platform;
  const originalExecPath = process.execPath;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'execPath', { value: originalExecPath });
  });

  it('requires peer verification for packaged macOS app execution', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'execPath', { value: '/Applications/InFlow.app/Contents/MacOS/inflow' });

    expect(shouldRequireVaultPeerVerification()).toBe(true);
  });

  it('requires peer verification when the executable path is a symlink into the macOS app', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'inflow-peer-symlink-'));
    try {
      const appExecutable = join(tmpDir, 'InFlow.app', 'Contents', 'MacOS', 'inflow');
      const symlink = join(tmpDir, 'bin', 'inflow');
      mkdirSync(join(tmpDir, 'InFlow.app', 'Contents', 'MacOS'), { recursive: true });
      mkdirSync(join(tmpDir, 'bin'));
      writeFileSync(appExecutable, '');
      symlinkSync(appExecutable, symlink);
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      Object.defineProperty(process, 'execPath', { value: symlink });

      expect(shouldRequireVaultPeerVerification()).toBe(true);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it('accepts same-user same-executable peers and verifies release signatures', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const verified: { path: string; teamId: string }[] = [];
    const verifier = createVaultSocketPeerVerifier(
      {
        expectedExecutablePath: '/Applications/InFlow.app/Contents/MacOS/inflow',
        nativeModulePath: '/native/vault_peer_darwin.node',
        requireSignature: true,
      },
      dependencies({
        currentUserId: 501,
        peer: { path: '/Applications/InFlow.app/Contents/MacOS/inflow', pid: 123, uid: 501 },
        realpaths: new Map([['/Applications/InFlow.app/Contents/MacOS/inflow', '/signed/inflow']]),
        verifySignature(path, teamId) {
          verified.push({ path, teamId });
        },
      }),
    );

    expect(() => verifier(socketWithFd(42))).not.toThrow();
    expect(verified).toEqual([{ path: '/Applications/InFlow.app/Contents/MacOS/inflow', teamId: 'B96U57DTR2' }]);
  });

  it('accepts an explicit expected Team ID for tests and future packaging variants', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const verified: { path: string; teamId: string }[] = [];
    const verifier = createVaultSocketPeerVerifier(
      {
        expectedExecutablePath: '/Applications/InFlow.app/Contents/MacOS/inflow',
        expectedTeamId: 'TEAM123456',
        nativeModulePath: '/native/vault_peer_darwin.node',
        requireSignature: true,
      },
      dependencies({
        currentUserId: 501,
        peer: { path: '/Applications/InFlow.app/Contents/MacOS/inflow', pid: 123, uid: 501 },
        realpaths: new Map([['/Applications/InFlow.app/Contents/MacOS/inflow', '/signed/inflow']]),
        verifySignature(path, teamId) {
          verified.push({ path, teamId });
        },
      }),
    );

    expect(() => verifier(socketWithFd(42))).not.toThrow();
    expect(verified).toEqual([{ path: '/Applications/InFlow.app/Contents/MacOS/inflow', teamId: 'TEAM123456' }]);
  });

  it('rejects wrong-user, wrong-executable, and signature-failed peers', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    expect(() => peerVerifierFor({ path: '/usr/bin/inflow', pid: 123, uid: 502 })).toThrow(SecureStorageError);
    expect(() => peerVerifierFor({ path: '/tmp/fake-inflow', pid: 123, uid: 501 })).toThrow(SecureStorageError);
    expect(() =>
      peerVerifierFor(
        { path: '/usr/bin/inflow', pid: 123, uid: 501 },
        {
          verifySignature() {
            throw new SecureStorageError('secure_storage_unavailable', 'Vault peer verification failed.');
          },
        },
      ),
    ).toThrow(SecureStorageError);
  });

  it('uses stable secure storage error codes for rejected peers', () => {
    expect(peerVerifierError({ path: '/usr/bin/inflow', pid: 123, uid: 502 })).toMatchObject({
      secureStorageCode: 'secure_storage_unavailable',
    });
    expect(peerVerifierError({ path: '/tmp/fake-inflow', pid: 123, uid: 501 })).toMatchObject({
      secureStorageCode: 'secure_storage_unavailable',
    });
    expect(
      peerVerifierError(
        { path: '/usr/bin/inflow', pid: 123, uid: 501 },
        {
          verifySignature() {
            throw new SecureStorageError('secure_storage_unavailable', 'Vault peer verification failed.');
          },
        },
      ),
    ).toMatchObject({ secureStorageCode: 'secure_storage_unavailable' });
  });

  it('rejects unsupported platforms and sockets without exposed descriptors', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });

    expect(() => createVaultSocketPeerVerifier()).toThrow(SecureStorageError);
    expect(() => socketFileDescriptor(new Socket())).toThrow(SecureStorageError);
  });
});

function peerVerifierFor(peer: VaultSocketPeer, overrides: Partial<TestDependencyInput> = {}): void {
  const verifier = createVaultSocketPeerVerifier(
    {
      expectedExecutablePath: '/usr/bin/inflow',
      nativeModulePath: '/native/vault_peer_darwin.node',
      requireSignature: true,
    },
    dependencies({
      currentUserId: 501,
      peer,
      realpaths: new Map([
        ['/usr/bin/inflow', '/usr/bin/inflow'],
        ['/tmp/fake-inflow', '/tmp/fake-inflow'],
      ]),
      ...overrides,
    }),
  );
  void verifier(socketWithFd(42));
}

function peerVerifierError(peer: VaultSocketPeer, overrides: Partial<TestDependencyInput> = {}): unknown {
  try {
    peerVerifierFor(peer, overrides);
    return undefined;
  } catch (cause) {
    return cause;
  }
}

function socketWithFd(fd: number): Socket {
  const socket = new Socket() as Socket & { _handle?: { fd?: number } };
  socket._handle = { fd };
  return socket;
}

interface TestDependencyInput {
  currentUserId: number | undefined;
  peer: VaultSocketPeer;
  realpaths: Map<string, string>;
  verifySignature?: (path: string, teamId: string) => void;
}

function dependencies(input: TestDependencyInput) {
  return {
    currentUserId: vi.fn(() => input.currentUserId),
    loadNativeModule: vi.fn(() => ({
      peerInfo: vi.fn(() => input.peer),
    })),
    realpath: vi.fn((path: string) => input.realpaths.get(path) ?? path),
    verifySignature: vi.fn(input.verifySignature ?? (() => undefined)),
  };
}
