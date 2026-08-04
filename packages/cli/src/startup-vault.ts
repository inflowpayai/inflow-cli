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
  if (shouldBypassVault(argv, hasDirectApiKey)) return false;
  const [group, subcommand] = commandPath(argv);
  if (group === 'auth') return subcommand === 'login' || subcommand === 'logout';
  if (group === 'aep') return isOneOf(subcommand, 'enroll', 'fetch', 'grant', 'revoke', 'status');
  if (group === 'mpp' || group === 'x402') {
    return isOneOf(subcommand, 'fetch', 'pay', 'status', 'supported');
  }
  return false;
}

export function shouldReconcileVaultDaemon(argv: readonly string[], hasDirectApiKey = false): boolean {
  if (shouldBypassVault(argv, hasDirectApiKey)) return false;
  const [group, subcommand] = commandPath(argv);
  if (group === 'auth') return isOneOf(subcommand, 'login', 'logout', 'status');
  if (group === 'aep') return isOneOf(subcommand, 'enroll', 'fetch', 'grant', 'revoke', 'status');
  if (group === 'mpp' || group === 'x402') {
    return isOneOf(subcommand, 'fetch', 'pay', 'status', 'supported');
  }
  if (group === 'balances' || group === 'deposit-addresses') return subcommand === 'list';
  return group === 'user' && subcommand === 'get';
}

export function shouldUnlockVault(
  argv: readonly string[],
  options: { hasDirectApiKey?: boolean; isAgent?: boolean } = {},
): boolean {
  if (options.isAgent === true || shouldBypassVault(argv, options.hasDirectApiKey === true)) return false;
  const [group, subcommand] = commandPath(argv);
  if (group === 'auth') return subcommand === 'login';
  if (group === 'aep') return isOneOf(subcommand, 'enroll', 'fetch', 'grant', 'revoke', 'status');
  if (group === 'mpp' || group === 'x402') {
    return isOneOf(subcommand, 'fetch', 'pay', 'status', 'supported');
  }
  if (group === 'balances' || group === 'deposit-addresses') return subcommand === 'list';
  return group === 'user' && subcommand === 'get';
}

function shouldBypassVault(argv: readonly string[], hasDirectApiKey: boolean): boolean {
  return hasDirectApiKey || argv.includes('--schema') || argv.includes('--help') || argv.includes('-h');
}

function isOneOf(value: string | undefined, ...choices: readonly string[]): boolean {
  return value !== undefined && choices.includes(value);
}
