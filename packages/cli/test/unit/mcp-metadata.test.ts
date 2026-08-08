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
    ['mpp_pay', 'stored-session'],
    ['x402_fetch', 'stored-session'],
    ['aep_inspect', 'none'],
    ['inspect', 'none'],
    ['mpp_inspect', 'none'],
    ['odp_collections_list', 'none'],
    ['vault_status', 'none'],
    ['unknown_tool', 'none'],
  ] as const)('classifies %s as %s', (name, access) => {
    expect(mcpVaultAccess(name)).toBe(access);
  });

  it('uses direct API keys only in place of stored InFlow sessions', () => {
    expect(shouldEnsureVaultDaemonForMcpTool('mpp_pay', false)).toBe(true);
    expect(shouldEnsureVaultDaemonForMcpTool('mpp_pay', true)).toBe(false);
    expect(shouldEnsureVaultDaemonForMcpTool('aep_status', true)).toBe(true);
    expect(shouldEnsureVaultDaemonForMcpTool('inspect', false)).toBe(false);
  });
});
