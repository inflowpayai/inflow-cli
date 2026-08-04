export function commandPath(argv: readonly string[]): string[] {
  const out: string[] = [];
  const valueFlags = new Set([
    '--api-base-url',
    '--api-key',
    '--auth',
    '--auth-base-url',
    '--base-url',
    '--environment',
    '--format',
    '--output',
    '--skill',
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--') break;
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && valueFlags.has(arg)) {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('-')) index += 1;
      }
      continue;
    }
    out.push(arg);
    if (out.length >= 2) break;
  }
  return out;
}

export function shouldStartVaultDaemon(argv: readonly string[], hasDirectApiKey = false): boolean {
  if (shouldBypassVault(argv)) return false;
  const [group, subcommand] = commandPath(argv);
  if (group === 'auth') return subcommand === 'login' || subcommand === 'logout';
  if (group === 'aep') return isOneOf(subcommand, 'enroll', 'fetch', 'grant', 'revoke', 'status');
  if (group === 'mpp' || group === 'x402') {
    return !hasDirectApiKey && isOneOf(subcommand, 'fetch', 'pay', 'status', 'supported');
  }
  return false;
}

const MCP_VAULT_TOOLS = new Set([
  'aep_enroll',
  'aep_fetch',
  'aep_grant',
  'aep_revoke',
  'aep_status',
  'auth_login',
  'auth_logout',
  'auth_status',
  'balances_list',
  'deposit_addresses_list',
  'mpp_fetch',
  'mpp_pay',
  'mpp_status',
  'mpp_supported',
  'user_get',
  'vault_lock',
  'vault_policy',
  'vault_set_policy',
  'x402_fetch',
  'x402_pay',
  'x402_status',
  'x402_supported',
]);

const MCP_DIRECT_API_KEY_TOOLS = new Set([
  'auth_status',
  'balances_list',
  'deposit_addresses_list',
  'mpp_fetch',
  'mpp_pay',
  'mpp_status',
  'mpp_supported',
  'x402_fetch',
  'x402_pay',
  'x402_status',
  'x402_supported',
  'user_get',
]);

export function shouldStartVaultDaemonForMcpTool(
  toolName: string,
  hasDirectApiKey = false,
  hasStoredSession = true,
): boolean {
  if (!MCP_VAULT_TOOLS.has(toolName)) return false;
  if (!MCP_DIRECT_API_KEY_TOOLS.has(toolName)) return true;
  return !hasDirectApiKey && hasStoredSession;
}

export function shouldReconcileVaultDaemon(argv: readonly string[], hasDirectApiKey = false): boolean {
  if (shouldBypassVault(argv)) return false;
  const [group, subcommand] = commandPath(argv);
  if (group === 'auth') {
    return isOneOf(subcommand, 'login', 'logout') || (!hasDirectApiKey && subcommand === 'status');
  }
  if (group === 'aep') return isOneOf(subcommand, 'enroll', 'fetch', 'grant', 'revoke', 'status');
  if (group === 'mpp' || group === 'x402') {
    return !hasDirectApiKey && isOneOf(subcommand, 'fetch', 'pay', 'status', 'supported');
  }
  if (hasDirectApiKey) return false;
  if (group === 'balances' || group === 'deposit-addresses') return subcommand === 'list';
  return group === 'user' && subcommand === 'get';
}

export function shouldUnlockVault(
  argv: readonly string[],
  options: { hasDirectApiKey?: boolean; isAgent?: boolean } = {},
): boolean {
  if (options.isAgent === true || shouldBypassVault(argv)) return false;
  const [group, subcommand] = commandPath(argv);
  if (group === 'auth') return subcommand === 'login';
  if (group === 'aep') return isOneOf(subcommand, 'enroll', 'fetch', 'grant', 'revoke', 'status');
  if (group === 'mpp' || group === 'x402') {
    return options.hasDirectApiKey !== true && isOneOf(subcommand, 'fetch', 'pay', 'status', 'supported');
  }
  if (options.hasDirectApiKey === true) return false;
  if (group === 'balances' || group === 'deposit-addresses') return subcommand === 'list';
  return group === 'user' && subcommand === 'get';
}

function shouldBypassVault(argv: readonly string[]): boolean {
  return argv.includes('--schema') || argv.includes('--help') || argv.includes('-h');
}

function isOneOf(value: string | undefined, ...choices: readonly string[]): boolean {
  return value !== undefined && choices.includes(value);
}
