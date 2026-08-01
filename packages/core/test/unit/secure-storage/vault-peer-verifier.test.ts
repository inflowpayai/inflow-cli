import { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecureStorageError } from '../../../src/secure-storage/errors.js';
import {
  __testing,
  createVaultSocketPeerVerifier,
  shouldRequireVaultPeerVerification,
  socketFileDescriptor,
  type VaultSocketPeer,
  type VaultPeerVerificationConfig,
  verifyVaultNativeModule,
  verifyTransferredVaultSocketPeerWithDependencies,
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

  it('requires peer verification on Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'execPath', { value: '/opt/inflow/bin/inflow' });

    expect(shouldRequireVaultPeerVerification()).toBe(true);
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

    expect(verifier(socketWithFd(42))).toEqual({
      path: '/Applications/InFlow.app/Contents/MacOS/inflow',
      pid: 123,
      uid: 501,
    });
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

    expect(verifier(socketWithFd(42))).toEqual({
      path: '/Applications/InFlow.app/Contents/MacOS/inflow',
      pid: 123,
      uid: 501,
    });
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
            throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
          },
        },
      ),
    ).toThrow(SecureStorageError);
  });

  it('uses stable secure storage error codes for rejected peers', () => {
    expect(peerVerifierError({ path: '/usr/bin/inflow', pid: 123, uid: 502 })).toMatchObject({
      secureStorageCode: 'secure_storage_peer_verification_failed',
    });
    expect(peerVerifierError({ path: '/tmp/fake-inflow', pid: 123, uid: 501 })).toMatchObject({
      secureStorageCode: 'secure_storage_peer_verification_failed',
    });
    expect(
      peerVerifierError(
        { path: '/usr/bin/inflow', pid: 123, uid: 501 },
        {
          verifySignature() {
            throw new SecureStorageError('secure_storage_peer_verification_failed', 'Vault peer verification failed.');
          },
        },
      ),
    ).toMatchObject({ secureStorageCode: 'secure_storage_peer_verification_failed' });
  });

  it('accepts same-user same-executable Linux peers without a signing check', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const verified = vi.fn();
    const verifier = createVaultSocketPeerVerifier(
      {
        expectedExecutablePath: '/opt/inflow/bin/inflow',
        nativeModulePath: '/opt/inflow/lib/inflow/native/vault_peer_linux.node',
      },
      dependencies({
        currentUserId: 1000,
        peer: { path: '/opt/inflow/bin/inflow', pid: 123, uid: 1000 },
        realpaths: new Map([['/opt/inflow/bin/inflow', '/opt/inflow/bin/inflow']]),
        verifySignature: verified,
      }),
    );

    expect(verifier(socketWithFd(42))).toEqual({
      path: '/opt/inflow/bin/inflow',
      pid: 123,
      uid: 1000,
    });
    expect(verified).not.toHaveBeenCalled();
  });

  it('binds a service peer to an explicit operating-system user identity', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const verifier = createVaultSocketPeerVerifier(
      {
        expectedExecutablePath: '/opt/inflow/bin/inflow',
        expectedUserId: 991,
        nativeModulePath: '/opt/inflow/lib/inflow/native/vault_peer_linux.node',
        requireSameUser: false,
      },
      dependencies({
        currentUserId: 1000,
        peer: { path: '/opt/inflow/bin/inflow', pid: 123, uid: 991 },
        realpaths: new Map([['/opt/inflow/bin/inflow', '/opt/inflow/bin/inflow']]),
      }),
    );

    expect(verifier(socketWithFd(42))).toMatchObject({ uid: 991 });
    expect(() =>
      createVaultSocketPeerVerifier(
        {
          expectedExecutablePath: '/opt/inflow/bin/inflow',
          expectedUserId: 991,
          nativeModulePath: '/opt/inflow/lib/inflow/native/vault_peer_linux.node',
          requireSameUser: false,
        },
        dependencies({
          currentUserId: 1000,
          peer: { path: '/opt/inflow/bin/inflow', pid: 123, uid: 1000 },
          realpaths: new Map([['/opt/inflow/bin/inflow', '/opt/inflow/bin/inflow']]),
        }),
      )(socketWithFd(42)),
    ).toThrow(SecureStorageError);
  });

  it('binds broker-transferred sockets to the attested executable, process, and user', () => {
    const config: VaultPeerVerificationConfig = {
      expectedExecutablePath: '/opt/inflow/bin/inflow',
      expectedTeamId: '',
      nativeModulePath: '/opt/inflow/lib/inflow/native/vault_peer_linux.node',
      requireSameUser: false,
      requireSignature: false,
    };
    const attested = { path: '/opt/inflow/bin/inflow', pid: 123, uid: 1000 };
    const transferredDependencies = (credentials: { pid: number; uid: number }) => ({
      loadNativeModule: () => ({
        peerCredentials: () => credentials,
        peerInfo: () => attested,
      }),
      realpath: (path: string) => path,
    });

    expect(
      verifyTransferredVaultSocketPeerWithDependencies(
        socketWithFd(42),
        attested,
        config,
        transferredDependencies({ pid: 123, uid: 1000 }),
      ),
    ).toEqual(attested);
    expect(() =>
      verifyTransferredVaultSocketPeerWithDependencies(
        socketWithFd(42),
        { ...attested, path: '/tmp/inflow' },
        config,
        transferredDependencies({ pid: 123, uid: 1000 }),
      ),
    ).toThrow(SecureStorageError);
    expect(() =>
      verifyTransferredVaultSocketPeerWithDependencies(
        socketWithFd(42),
        attested,
        config,
        transferredDependencies({ pid: 124, uid: 1000 }),
      ),
    ).toThrow(SecureStorageError);
    expect(() =>
      verifyTransferredVaultSocketPeerWithDependencies(
        socketWithFd(42),
        attested,
        config,
        transferredDependencies({ pid: 123, uid: 1001 }),
      ),
    ).toThrow(SecureStorageError);
  });

  it('rejects invalid explicit user identifiers and unavailable current-user identities', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    for (const expectedUserId of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        createVaultSocketPeerVerifier(
          {
            expectedExecutablePath: '/opt/inflow/bin/inflow',
            expectedUserId,
            nativeModulePath: '/native/vault_peer_linux.node',
          },
          dependencies({
            currentUserId: 1000,
            peer: { path: '/opt/inflow/bin/inflow', pid: 123, uid: 1000 },
            realpaths: new Map([['/opt/inflow/bin/inflow', '/opt/inflow/bin/inflow']]),
          }),
        ),
      ).toThrow('configuration is invalid');
    }

    const verifier = createVaultSocketPeerVerifier(
      {
        expectedExecutablePath: '/opt/inflow/bin/inflow',
        nativeModulePath: '/native/vault_peer_linux.node',
      },
      dependencies({
        currentUserId: undefined,
        peer: { path: '/opt/inflow/bin/inflow', pid: 123, uid: 1000 },
        realpaths: new Map([['/opt/inflow/bin/inflow', '/opt/inflow/bin/inflow']]),
      }),
    );
    expect(() => verifier(socketWithFd(42))).toThrow(SecureStorageError);
  });

  it('fails closed when a packaged executable has no embedded native module digest', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'execPath', { value: '/opt/inflow/bin/inflow' });

    expect(() =>
      createVaultSocketPeerVerifier(
        {},
        dependencies({
          currentUserId: 1000,
          peer: { path: '/opt/inflow/bin/inflow', pid: 123, uid: 1000 },
          realpaths: new Map([['/opt/inflow/bin/inflow', '/opt/inflow/bin/inflow']]),
        }),
      ),
    ).toThrow(SecureStorageError);
  });

  it('rejects unsupported platforms and sockets without exposed descriptors', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    expect(() => createVaultSocketPeerVerifier()).toThrow(SecureStorageError);
    expect(() => socketFileDescriptor(new Socket())).toThrow(SecureStorageError);
  });

  it('accepts a canonical non-writable native module with the expected digest', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'inflow-native-module-'));
    try {
      const nativeModule = join(tmpDir, 'vault_peer.node');
      const content = Buffer.from('native-module');
      writeFileSync(nativeModule, content, { mode: 0o755 });

      expect(() =>
        verifyVaultNativeModule(nativeModule, {
          expectedSha256: createHash('sha256').update(content).digest('hex'),
          expectedTeamId: 'TEAM123456',
          requireSignature: false,
        }),
      ).not.toThrow();
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it('uses the native module digest instead of POSIX mode bits on Windows', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'inflow-native-module-'));
    try {
      const nativeModule = join(tmpDir, 'vault_peer.node');
      const content = Buffer.from('native-module');
      writeFileSync(nativeModule, content, { mode: 0o777 });
      Object.defineProperty(process, 'platform', { value: 'win32' });

      expect(() =>
        verifyVaultNativeModule(nativeModule, {
          expectedSha256: createHash('sha256').update(content).digest('hex'),
          expectedTeamId: '',
          requireSignature: false,
        }),
      ).not.toThrow();
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it('rejects modified, writable, and symlinked native modules', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'inflow-native-module-'));
    try {
      const nativeModule = join(tmpDir, 'vault_peer.node');
      const linkedModule = join(tmpDir, 'linked.node');
      writeFileSync(nativeModule, 'native-module', { mode: 0o755 });
      symlinkSync(nativeModule, linkedModule);
      const options = {
        expectedSha256: createHash('sha256').update('different-module').digest('hex'),
        expectedTeamId: 'TEAM123456',
        requireSignature: false,
      };

      expect(() => verifyVaultNativeModule(nativeModule, options)).toThrow(SecureStorageError);
      chmodSync(nativeModule, 0o777);
      expect(() =>
        verifyVaultNativeModule(nativeModule, {
          ...options,
          expectedSha256: createHash('sha256').update('native-module').digest('hex'),
        }),
      ).toThrow(SecureStorageError);
      chmodSync(nativeModule, 0o755);
      expect(() => verifyVaultNativeModule(linkedModule, options)).toThrow(SecureStorageError);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it('uses operating-system defaults for user, path, native loading, and signature checks', () => {
    const executable = process.execPath;
    expect(__testing.defaultPeerVerifierDependencies.currentUserId()).toBe(process.getuid?.());
    expect(__testing.defaultPeerVerifierDependencies.realpath(executable)).toBe(executable);
    expect(() =>
      __testing.defaultPeerVerifierDependencies.loadNativeModule('/missing/inflow-vault-peer.node'),
    ).toThrow();
    expect(() => __testing.defaultPeerVerifierDependencies.verifySignature('/missing/inflow', 'TEAM123456')).toThrow(
      SecureStorageError,
    );
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
      peerCredentials: vi.fn(() => ({ pid: input.peer.pid, uid: input.peer.uid })),
      peerInfo: vi.fn(() => input.peer),
    })),
    realpath: vi.fn((path: string) => input.realpaths.get(path) ?? path),
    verifyNativeModule: vi.fn(),
    verifySignature: vi.fn(input.verifySignature ?? (() => undefined)),
  };
}
