import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Windows protected-memory module loading', () => {
  const originalExecPath = process.execPath;
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'execPath', { value: originalExecPath });
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('verifies and loads the installed native module before hardening', async () => {
    const digest = 'a'.repeat(64);
    const hardenProcess = vi.fn();
    const loadNative = vi.fn(() => ({ hardenProcess }));
    const verifyVaultNativeModule = vi.fn();
    Object.defineProperty(process, 'execPath', { value: 'C:\\Program Files\\InFlow\\inflow.exe' });
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubGlobal('__VAULT_PEER_NATIVE_SHA256__', digest);
    vi.doMock('../../../src/secure-storage/runtime-require.js', () => ({
      runtimeRequire: () => loadNative,
    }));
    vi.doMock('../../../src/secure-storage/vault-peer-verifier.js', () => ({
      verifyVaultNativeModule,
    }));

    const { hardenVaultDaemonProcess } = await import('../../../src/secure-storage/vault-protected-key.js');
    hardenVaultDaemonProcess();

    const nativeModulePath = resolve(dirname(process.execPath), 'native', 'vault_peer_windows.node');
    expect(verifyVaultNativeModule).toHaveBeenCalledWith(nativeModulePath, {
      expectedSha256: digest,
      expectedTeamId: '',
      requireSignature: false,
    });
    expect(loadNative).toHaveBeenCalledWith(nativeModulePath);
    expect(hardenProcess).toHaveBeenCalledOnce();
  });

  it('fails closed without an embedded native-module digest', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubGlobal('__VAULT_PEER_NATIVE_SHA256__', undefined);

    const { hardenVaultDaemonProcess } = await import('../../../src/secure-storage/vault-protected-key.js');

    expect(() => hardenVaultDaemonProcess()).toThrow('Vault native module integrity is unavailable.');
  });
});
