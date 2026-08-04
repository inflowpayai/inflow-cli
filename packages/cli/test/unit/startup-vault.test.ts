import { describe, expect, it } from 'vitest';
import { commandPath, shouldStartVaultDaemon, shouldUnlockVault } from '../../src/startup-vault.js';

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
    ['root command', [], false],
    ['aep parent', ['aep'], false],
    ['auth parent', ['auth'], false],
    ['mpp parent', ['mpp'], false],
    ['vault parent', ['vault'], false],
    ['x402 parent', ['x402'], false],
    ['unknown command', ['unknown'], false],
    ['aep status help', ['aep', 'status', '--help'], false],
    ['auth status help', ['auth', 'status', '--help'], false],
    ['auth login', ['auth', 'login'], true],
    ['auth logout', ['auth', 'logout'], true],
    ['auth status', ['auth', 'status'], true],
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
    ['top inspect', ['inspect'], true],
    ['top inspect with URL', ['inspect', 'https://seller.test'], true],
  ] as const)('starts daemon for %s when required', (_label, args, expected) => {
    expect(shouldStartVaultDaemon(argv(...args))).toBe(expected);
  });

  it.each([
    ['root command', [], false],
    ['aep parent', ['aep'], false],
    ['auth parent', ['auth'], false],
    ['mpp parent', ['mpp'], false],
    ['vault parent', ['vault'], false],
    ['x402 parent', ['x402'], false],
    ['unknown command', ['unknown'], false],
    ['aep status help', ['aep', 'status', '--help'], false],
    ['auth status help', ['auth', 'status', '--help'], false],
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
    ['top inspect with URL', ['inspect', 'https://seller.test'], false],
  ] as const)('unlocks vault for human %s when required', (_label, args, expected) => {
    expect(shouldUnlockVault(argv(...args))).toBe(expected);
  });

  it('starts the vault for commands that persist local state even when a direct API key authenticates InFlow', () => {
    expect(shouldStartVaultDaemon(argv('auth', 'login'), true)).toBe(true);
    expect(shouldStartVaultDaemon(argv('auth', 'logout'), true)).toBe(true);
    expect(shouldStartVaultDaemon(argv('aep', 'status'), true)).toBe(true);
    expect(shouldStartVaultDaemon(argv('inspect'), true)).toBe(true);
    expect(shouldUnlockVault(argv('auth', 'login'), { hasDirectApiKey: true })).toBe(true);
    expect(shouldUnlockVault(argv('aep', 'status'), { hasDirectApiKey: true })).toBe(true);
  });

  it('bypasses the vault for direct API key commands without local credential state and for schema mode', () => {
    expect(shouldStartVaultDaemon(argv('balances', 'list'), true)).toBe(false);
    expect(shouldStartVaultDaemon(argv('mpp', 'status'), true)).toBe(false);
    expect(shouldUnlockVault(argv('balances', 'list'), { hasDirectApiKey: true })).toBe(false);
    expect(shouldStartVaultDaemon(argv('aep', 'status', '--schema'))).toBe(false);
    expect(shouldUnlockVault(argv('aep', 'status', '--schema'))).toBe(false);
  });

  it('does not prompt agents or MCP callers before command handling', () => {
    expect(shouldUnlockVault(argv('aep', 'status'), { isAgent: true })).toBe(false);
    expect(shouldUnlockVault(argv('--mcp'), { isAgent: true })).toBe(false);
    expect(shouldUnlockVault(argv('mpp', 'pay', 'https://seller.test'), { isAgent: true })).toBe(false);
  });
});
