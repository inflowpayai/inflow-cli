import { describe, expect, it } from 'vitest';
import { mcpVaultAccess, shouldEnsureVaultDaemonForMcpTool } from '../../src/mcp-metadata.js';

describe('MCP vault metadata', () => {
  it.each([
    ['aep_status', 'required'],
    ['auth_login', 'required'],
    ['vault_lock', 'required'],
    ['auth_status', 'stored-session'],
    ['balances_list', 'stored-session'],
    ['deposit-addresses_list', 'stored-session'],
    ['user_get', 'stored-session'],
    ['mpp_pay', 'required'],
    ['x402_fetch', 'required'],
    ['aep_inspect', 'required'],
    ['inspect', 'required'],
    ['mpp_inspect', 'required'],
    ['x402_inspect', 'required'],
    ['odp_collections_list', 'required'],
    ['vault_status', 'none'],
    ['unknown_tool', 'none'],
  ] as const)('classifies %s as %s', (name, access) => {
    expect(mcpVaultAccess(name)).toBe(access);
  });

  it('uses direct API keys only in place of stored InFlow sessions', () => {
    expect(shouldEnsureVaultDaemonForMcpTool('mpp_pay', false)).toBe(true);
    expect(shouldEnsureVaultDaemonForMcpTool('mpp_pay', true)).toBe(true);
    expect(shouldEnsureVaultDaemonForMcpTool('aep_status', true)).toBe(true);
    expect(shouldEnsureVaultDaemonForMcpTool('inspect', false)).toBe(true);
    expect(shouldEnsureVaultDaemonForMcpTool('mpp_inspect', false)).toBe(true);
    expect(shouldEnsureVaultDaemonForMcpTool('x402_inspect', true)).toBe(true);
    expect(shouldEnsureVaultDaemonForMcpTool('user_get', false)).toBe(true);
    expect(shouldEnsureVaultDaemonForMcpTool('user_get', true)).toBe(false);
  });
});
