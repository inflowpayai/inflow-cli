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
  if (hasDirectApiKey || argv.includes('--schema')) return false;
  const [group, subcommand] = commandPath(argv);
  if (group === 'auth') return subcommand === 'login' || subcommand === 'logout';
  if (group === 'aep') return subcommand !== 'inspect';
  if (group === 'mpp' || group === 'x402') {
    return subcommand === 'pay' || subcommand === 'fetch' || subcommand === 'status' || subcommand === 'supported';
  }
  return false;
}

export function shouldReconcileVaultDaemon(argv: readonly string[], hasDirectApiKey = false): boolean {
  if (hasDirectApiKey || argv.includes('--schema')) return false;
  const [group, subcommand] = commandPath(argv);
  if (group === 'auth') return subcommand === 'login' || subcommand === 'logout' || subcommand === 'status';
  if (group === 'aep') return subcommand !== 'inspect';
  if (group === 'mpp' || group === 'x402') {
    return subcommand === 'pay' || subcommand === 'fetch' || subcommand === 'status' || subcommand === 'supported';
  }
  return group === 'balances' || group === 'deposit-addresses' || group === 'user';
}

export function shouldUnlockVault(
  argv: readonly string[],
  options: { hasDirectApiKey?: boolean; isAgent?: boolean } = {},
): boolean {
  if (options.hasDirectApiKey === true || options.isAgent === true || argv.includes('--schema')) return false;
  const [group, subcommand] = commandPath(argv);
  if (group === 'auth') return subcommand === 'login';
  if (group === 'aep') return subcommand !== 'inspect';
  if (group === 'mpp' || group === 'x402') {
    return subcommand === 'pay' || subcommand === 'fetch' || subcommand === 'status' || subcommand === 'supported';
  }
  if (group === 'balances' || group === 'deposit-addresses' || group === 'user') return true;
  return false;
}
