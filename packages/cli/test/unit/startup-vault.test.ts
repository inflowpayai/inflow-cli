import { describe, expect, it } from 'vitest';
import {
  commandPath,
  shouldReconcileVaultDaemon,
  shouldStartVaultDaemon,
  shouldUnlockVault,
} from '../../src/startup-vault.js';

function argv(...args: string[]): string[] {
  return ['node', 'inflow', ...args];
}

describe('vault startup decisions', () => {
  it.each([
    { args: ['--base-url', 'https://api.test', 'aep', 'status', 'https://seller.test'], path: ['aep', 'status'] },
    { args: ['--format=json', 'mpp', 'pay', 'https://seller.test'], path: ['mpp', 'pay'] },
    { args: ['--schema', 'x402', 'fetch'], path: ['x402', 'fetch'] },
    { args: ['--skill', 'agentic-payments'], path: [] },
    { args: ['inspect', '--', '--not-a-flag'], path: ['inspect'] },
  ])('extracts command path from $args', ({ args, path }) => {
    expect(commandPath(argv(...args))).toEqual(path);
  });

  it.each([
    ['auth login', ['auth', 'login'], true],
    ['auth logout', ['auth', 'logout'], true],
    ['auth status', ['auth', 'status'], false],
    ['aep enroll', ['aep', 'enroll'], true],
    ['aep fetch', ['aep', 'fetch'], true],
    ['aep grant', ['aep', 'grant'], true],
    ['aep inspect', ['aep', 'inspect'], false],
    ['aep revoke', ['aep', 'revoke'], true],
    ['aep status', ['aep', 'status'], true],
    ['mpp pay', ['mpp', 'pay'], true],
    ['mpp fetch', ['mpp', 'fetch'], true],
    ['mpp status', ['mpp', 'status'], true],
    ['mpp supported', ['mpp', 'supported'], true],
    ['mpp inspect', ['mpp', 'inspect'], false],
    ['x402 pay', ['x402', 'pay'], true],
    ['x402 fetch', ['x402', 'fetch'], true],
    ['x402 status', ['x402', 'status'], true],
    ['x402 supported', ['x402', 'supported'], true],
    ['x402 inspect', ['x402', 'inspect'], false],
    ['balances list', ['balances', 'list'], false],
    ['deposit-addresses list', ['deposit-addresses', 'list'], false],
    ['user get', ['user', 'get'], false],
    ['vault unlock', ['vault', 'unlock'], false],
    ['top inspect', ['inspect'], false],
  ] as const)('starts daemon for %s when required', (_label, args, expected) => {
    expect(shouldStartVaultDaemon(argv(...args))).toBe(expected);
  });

  it.each([
    ['auth status', ['auth', 'status'], true],
    ['balances list', ['balances', 'list'], true],
    ['aep status', ['aep', 'status'], true],
    ['mpp pay', ['mpp', 'pay'], true],
    ['x402 fetch', ['x402', 'fetch'], true],
    ['aep inspect', ['aep', 'inspect'], false],
    ['vault unlock', ['vault', 'unlock'], false],
    ['top inspect', ['inspect'], false],
  ] as const)('reconciles a running daemon for %s when required', (_label, args, expected) => {
    expect(shouldReconcileVaultDaemon(argv(...args))).toBe(expected);
  });

  it.each([
    ['auth login', ['auth', 'login'], true],
    ['auth logout', ['auth', 'logout'], false],
    ['auth status', ['auth', 'status'], false],
    ['aep enroll', ['aep', 'enroll'], true],
    ['aep fetch', ['aep', 'fetch'], true],
    ['aep grant', ['aep', 'grant'], true],
    ['aep inspect', ['aep', 'inspect'], false],
    ['aep revoke', ['aep', 'revoke'], true],
    ['aep status', ['aep', 'status'], true],
    ['mpp pay', ['mpp', 'pay'], true],
    ['mpp fetch', ['mpp', 'fetch'], true],
    ['mpp status', ['mpp', 'status'], true],
    ['mpp supported', ['mpp', 'supported'], true],
    ['mpp inspect', ['mpp', 'inspect'], false],
    ['x402 pay', ['x402', 'pay'], true],
    ['x402 fetch', ['x402', 'fetch'], true],
    ['x402 status', ['x402', 'status'], true],
    ['x402 supported', ['x402', 'supported'], true],
    ['x402 inspect', ['x402', 'inspect'], false],
    ['balances list', ['balances', 'list'], true],
    ['deposit-addresses list', ['deposit-addresses', 'list'], true],
    ['user get', ['user', 'get'], true],
    ['vault unlock', ['vault', 'unlock'], false],
    ['top inspect', ['inspect'], false],
  ] as const)('unlocks vault for human %s when required', (_label, args, expected) => {
    expect(shouldUnlockVault(argv(...args))).toBe(expected);
  });

  it('does not start or unlock the vault when a direct API key or schema mode is used', () => {
    expect(shouldStartVaultDaemon(argv('aep', 'status'), true)).toBe(false);
    expect(shouldReconcileVaultDaemon(argv('aep', 'status'), true)).toBe(false);
    expect(shouldUnlockVault(argv('aep', 'status'), { hasDirectApiKey: true })).toBe(false);
    expect(shouldStartVaultDaemon(argv('aep', 'status', '--schema'))).toBe(false);
    expect(shouldReconcileVaultDaemon(argv('aep', 'status', '--schema'))).toBe(false);
    expect(shouldUnlockVault(argv('aep', 'status', '--schema'))).toBe(false);
  });

  it.each(['auth', 'aep', 'balances', 'deposit-addresses', 'mpp', 'user', 'vault', 'x402'])(
    'does not touch the vault for %s group help',
    (group) => {
      for (const args of [[group], [group, '--help'], [group, '-h']]) {
        expect(shouldStartVaultDaemon(argv(...args))).toBe(false);
        expect(shouldReconcileVaultDaemon(argv(...args))).toBe(false);
        expect(shouldUnlockVault(argv(...args))).toBe(false);
      }
    },
  );

  it('does not touch the vault for help or unknown subcommands', () => {
    for (const args of [
      ['aep', 'status', '--help'],
      ['mpp', 'pay', '-h'],
      ['aep', 'unknown'],
      ['balances', 'unknown'],
      ['deposit-addresses', 'unknown'],
      ['user', 'unknown'],
    ]) {
      expect(shouldStartVaultDaemon(argv(...args))).toBe(false);
      expect(shouldReconcileVaultDaemon(argv(...args))).toBe(false);
      expect(shouldUnlockVault(argv(...args))).toBe(false);
    }
  });

  it('does not prompt agents or MCP callers before command handling', () => {
    expect(shouldUnlockVault(argv('aep', 'status'), { isAgent: true })).toBe(false);
    expect(shouldUnlockVault(argv('--mcp'), { isAgent: true })).toBe(false);
    expect(shouldUnlockVault(argv('mpp', 'pay', 'https://seller.test'), { isAgent: true })).toBe(false);
  });
});
