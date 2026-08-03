import { describe, expect, it } from 'vitest';
import {
  commandPath,
  shouldConfigureOdpServiceTransport,
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

  it('extracts a deeper command path when requested', () => {
    expect(commandPath(argv('--format', 'json', 'odp', 'collections', 'list', 'https://service.test'), 3)).toEqual([
      'odp',
      'collections',
      'list',
    ]);
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
    ['odp actions resolve', ['odp', 'actions', 'resolve', 'https://service.test', 'offering-1', 'action-1'], true],
    ['odp collections list', ['odp', 'collections', 'list', 'https://service.test'], true],
    ['odp offerings discover', ['odp', 'offerings', 'discover'], true],
    ['odp directory', ['odp', 'directory'], false],
    ['odp inspect', ['odp', 'inspect'], false],
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
    ['odp offerings list', ['odp', 'offerings', 'list', 'https://service.test'], true],
    ['odp directory', ['odp', 'directory'], false],
    ['odp inspect', ['odp', 'inspect'], false],
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
    ['odp actions resolve', ['odp', 'actions', 'resolve', 'https://service.test', 'offering-1', 'action-1'], true],
    ['odp collections search', ['odp', 'collections', 'search', 'https://service.test'], true],
    ['odp offerings get', ['odp', 'offerings', 'get', 'https://service.test', 'offering-1'], true],
    ['odp directory', ['odp', 'directory'], false],
    ['odp inspect', ['odp', 'inspect'], false],
    ['balances list', ['balances', 'list'], true],
    ['deposit-addresses list', ['deposit-addresses', 'list'], true],
    ['user get', ['user', 'get'], true],
    ['vault unlock', ['vault', 'unlock'], false],
    ['top inspect', ['inspect'], false],
  ] as const)('unlocks vault for human %s when required', (_label, args, expected) => {
    expect(shouldUnlockVault(argv(...args))).toBe(expected);
  });

  it('still uses the vault for local-state commands when a direct InFlow API key is present', () => {
    expect(shouldStartVaultDaemon(argv('aep', 'status'), true)).toBe(true);
    expect(shouldReconcileVaultDaemon(argv('aep', 'status'), true)).toBe(true);
    expect(shouldUnlockVault(argv('aep', 'status'), { hasDirectApiKey: true })).toBe(true);
    const odpArgs = argv('odp', 'offerings', 'list', 'https://service.test');
    expect(shouldStartVaultDaemon(odpArgs, true)).toBe(true);
    expect(shouldReconcileVaultDaemon(odpArgs, true)).toBe(true);
    expect(shouldUnlockVault(odpArgs, { hasDirectApiKey: true })).toBe(true);
    expect(shouldStartVaultDaemon(argv('auth', 'login'), true)).toBe(true);
    expect(shouldReconcileVaultDaemon(argv('auth', 'logout'), true)).toBe(true);
  });

  it('bypasses vault credentials that a direct InFlow API key replaces', () => {
    expect(shouldStartVaultDaemon(argv('mpp', 'pay'), true)).toBe(false);
    expect(shouldReconcileVaultDaemon(argv('balances', 'list'), true)).toBe(false);
    expect(shouldReconcileVaultDaemon(argv('auth', 'status'), true)).toBe(false);
    expect(shouldUnlockVault(argv('x402', 'fetch'), { hasDirectApiKey: true })).toBe(false);
  });

  it('does not touch the vault in schema mode', () => {
    expect(shouldStartVaultDaemon(argv('aep', 'status', '--schema'))).toBe(false);
    expect(shouldReconcileVaultDaemon(argv('aep', 'status', '--schema'))).toBe(false);
    expect(shouldUnlockVault(argv('aep', 'status', '--schema'))).toBe(false);
  });

  it.each(['auth', 'aep', 'balances', 'deposit-addresses', 'mpp', 'odp', 'user', 'vault', 'x402'])(
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
      ['odp', 'unknown'],
      ['balances', 'unknown'],
      ['deposit-addresses', 'unknown'],
      ['user', 'unknown'],
    ]) {
      expect(shouldStartVaultDaemon(argv(...args))).toBe(false);
      expect(shouldReconcileVaultDaemon(argv(...args))).toBe(false);
      expect(shouldUnlockVault(argv(...args))).toBe(false);
    }
  });

  it.each([
    ['odp collections', ['odp', 'collections']],
    ['odp offerings', ['odp', 'offerings']],
    ['odp actions', ['odp', 'actions']],
  ] as const)('does not touch the vault for incomplete %s', (_label, args) => {
    expect(shouldConfigureOdpServiceTransport(argv(...args))).toBe(false);
    expect(shouldStartVaultDaemon(argv(...args))).toBe(false);
    expect(shouldReconcileVaultDaemon(argv(...args))).toBe(false);
    expect(shouldUnlockVault(argv(...args))).toBe(false);
  });

  it.each([
    ['collections list', ['odp', 'collections', 'list', 'https://service.test']],
    ['collections search', ['odp', 'collections', 'search', 'https://service.test']],
    ['collections get', ['odp', 'collections', 'get', 'https://service.test', 'collection-1']],
    ['offerings list', ['odp', 'offerings', 'list', 'https://service.test']],
    ['offerings search', ['odp', 'offerings', 'search', 'https://service.test']],
    ['offerings get', ['odp', 'offerings', 'get', 'https://service.test', 'offering-1']],
    ['offerings discover', ['odp', 'offerings', 'discover']],
    ['actions resolve', ['odp', 'actions', 'resolve', 'https://service.test', 'offering-1', 'action-1']],
    ['collections list without service', ['odp', 'collections', 'list']],
    ['collections get without id', ['odp', 'collections', 'get', 'https://service.test']],
    ['offerings list without service', ['odp', 'offerings', 'list']],
    ['offerings get without id', ['odp', 'offerings', 'get', 'https://service.test']],
    ['actions resolve without action id', ['odp', 'actions', 'resolve', 'https://service.test', 'offering-1']],
  ] as const)('configures authenticated service access for recognized %s command paths', (_label, args) => {
    expect(shouldConfigureOdpServiceTransport(argv(...args))).toBe(true);
  });

  it('does not configure authenticated service access for an unknown ODP command path', () => {
    expect(shouldConfigureOdpServiceTransport(argv('odp', 'collections', 'unknown'))).toBe(false);
  });

  it('does not prompt agents or MCP callers before command handling', () => {
    expect(shouldUnlockVault(argv('aep', 'status'), { isAgent: true })).toBe(false);
    expect(shouldUnlockVault(argv('--mcp'), { isAgent: true })).toBe(false);
    expect(shouldUnlockVault(argv('mpp', 'pay', 'https://seller.test'), { isAgent: true })).toBe(false);
  });
});
