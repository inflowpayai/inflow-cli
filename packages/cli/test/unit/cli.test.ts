import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  isNpmShimAgentMode,
  renderNpmShimAgentPayload,
  renderNpmShimHumanMessage,
  runNpmShim,
} from '../../src/npm-shim.js';

vi.setConfig({ testTimeout: 15_000 });

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '../../');
const DIST_CLI = resolve(PACKAGE_ROOT, 'dist/cli.js');
const DIST_NPM_SHIM = resolve(PACKAGE_ROOT, 'dist/npm-shim.js');
const PKG_VERSION: string = (
  JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8')) as { version: string }
).version;
const AEP_COMMANDS = ['aep enroll', 'aep fetch', 'aep grant', 'aep inspect', 'aep revoke', 'aep status'] as const;
const AEP_MCP_TOOLS = AEP_COMMANDS.map((command) => command.replace(' ', '_'));
const PAYMENT_FETCH_MCP_TOOLS = ['mpp_fetch', 'x402_fetch'];
const VAULT_COMMANDS = [
  'vault change-passphrase',
  'vault lock',
  'vault policy',
  'vault reset',
  'vault set-policy',
  'vault status',
  'vault unlock',
] as const;
const VAULT_MCP_TOOLS = VAULT_COMMANDS.map((command) => command.replace(' ', '_'));
const MCP_TOOL_EXPECTATIONS = [
  ['aep_enroll', 'AEP: Enroll Service', false, false],
  ['aep_fetch', 'AEP: Fetch Resource', false, false],
  ['aep_grant', 'AEP: Grant Credential', false, false],
  ['aep_inspect', 'AEP: Inspect Service', true, false],
  ['aep_revoke', 'AEP: Revoke Credentials', false, true],
  ['aep_status', 'AEP: Check Status', true, false],
  ['auth_login', 'InFlow Account: Log In', false, false],
  ['auth_logout', 'InFlow Account: Log Out', false, true],
  ['auth_status', 'InFlow Account: Check Login', true, false],
  ['balances_list', 'Balances: List Balances', true, false],
  ['deposit-addresses_list', 'Deposit Addresses: List Deposit Addresses', true, false],
  ['inspect', 'Inspect: Inspect Resource', true, false],
  ['mpp_cancel', 'MPP: Cancel Approval', false, true],
  ['mpp_decode', 'MPP: Decode Header', true, false],
  ['mpp_fetch', 'MPP: Fetch Resource', false, false],
  ['mpp_inspect', 'MPP: Inspect Resource', true, false],
  ['mpp_pay', 'MPP: Pay Resource', false, true],
  ['mpp_status', 'MPP: Check Payment', true, false],
  ['mpp_supported', 'MPP: List Payment Methods', true, false],
  ['odp_actions_resolve', 'ODP: Resolve Action', true, false],
  ['odp_collections_get', 'ODP: Get Collection', true, false],
  ['odp_collections_list', 'ODP: List Collections', true, false],
  ['odp_collections_search', 'ODP: Search Collections', true, false],
  ['odp_directory_search', 'ODP: Search Directory', true, false],
  ['odp_directory_suggest', 'ODP: Suggest Keywords', true, false],
  ['odp_inspect', 'ODP: Inspect Service', true, false],
  ['odp_offerings_capabilities', 'ODP: Offering Search Capabilities', true, false],
  ['odp_offerings_discover', 'ODP: Discover Offerings', true, false],
  ['odp_offerings_get', 'ODP: Get Offering', true, false],
  ['odp_offerings_list', 'ODP: List Offerings', true, false],
  ['odp_offerings_search', 'ODP: Search Offerings', true, false],
  ['vault_change-passphrase', 'Vault: Change Passphrase', false, true],
  ['vault_lock', 'Vault: Lock Vault', false, false],
  ['vault_policy', 'Vault: Show Policy', true, false],
  ['vault_reset', 'Vault: Reset Vault', false, true],
  ['vault_set-policy', 'Vault: Set Policy', false, false],
  ['vault_status', 'Vault: Check Status', true, false],
  ['vault_unlock', 'Vault: Unlock Vault', false, false],
  ['x402_cancel', 'x402: Cancel Approval', false, true],
  ['x402_decode', 'x402: Decode Header', true, false],
  ['x402_fetch', 'x402: Fetch Resource', false, false],
  ['x402_inspect', 'x402: Inspect Resource', true, false],
  ['x402_pay', 'x402: Pay Resource', false, true],
  ['x402_status', 'x402: Check Payment', true, false],
  ['x402_supported', 'x402: List Payment Methods', true, false],
] as const;
const CLI_SCHEMA_COMMANDS = [
  'aep enroll',
  'aep fetch',
  'aep grant',
  'aep inspect',
  'aep revoke',
  'aep status',
  'auth login',
  'auth logout',
  'auth status',
  'balances list',
  'deposit-addresses list',
  'inspect',
  'mpp cancel',
  'mpp decode',
  'mpp fetch',
  'mpp inspect',
  'mpp pay',
  'mpp status',
  'mpp supported',
  'odp actions resolve',
  'odp directory search',
  'odp directory suggest',
  'odp collections get',
  'odp collections list',
  'odp collections search',
  'odp inspect',
  'odp offerings discover',
  'odp offerings get',
  'odp offerings list',
  'odp offerings search',
  'vault change-passphrase',
  'vault lock',
  'vault policy',
  'vault reset',
  'vault set-policy',
  'vault status',
  'vault unlock',
  'x402 cancel',
  'x402 decode',
  'x402 fetch',
  'x402 inspect',
  'x402 pay',
  'x402 status',
  'x402 supported',
] as const;
const RAW_SECRET_SCHEMA_FIELDS = new Set([
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'authorization',
  'Authorization',
  'password',
  'refreshToken',
  'refresh_token',
  'secret',
]);

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RunOptions extends SpawnOptionsWithoutStdio {
  stdin?: string;
}

class CapturingWritable {
  public text = '';

  write(text: string, callback: () => void): boolean {
    this.text += text;
    callback();
    return true;
  }
}

function run(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return runScript(DIST_CLI, args, options);
}

function runScript(script: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { stdin, ...spawnOptions } = options;
  const stdio: ['ignore' | 'pipe', 'pipe', 'pipe'] = [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'];
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script, ...args], {
      ...spawnOptions,
      stdio,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

describe.skipIf(!existsSync(DIST_NPM_SHIM))(
  'published npm shim (requires `pnpm --filter @inflowpayai/inflow build` first)',
  () => {
    it('prints the signed-native install message for humans and exits non-zero', async () => {
      const { exitCode, stdout, stderr } = await runScript(DIST_NPM_SHIM, ['--help'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('InFlow CLI is distributed as a signed native application.');
      expect(stderr).toContain('https://inflowcli.ai/');
      expect(stderr).toContain('does not run commands, start MCP, or manage credentials');
    });

    it('prints a stable JSON envelope for agent-mode invocations', async () => {
      const { exitCode, stdout, stderr } = await runScript(DIST_NPM_SHIM, ['--format', 'json'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(1);
      expect(stderr).toBe('');
      expect(JSON.parse(stdout) as Record<string, unknown>).toEqual({
        ok: false,
        code: 'NPM_CLI_DEPRECATED',
        message: 'The npm package no longer runs InFlow commands. Install the signed native InFlow CLI.',
        install_url: 'https://inflowcli.ai/',
        package_version: PKG_VERSION,
      });
    });

    it('blocks the legacy npm MCP command path before any credential store can be opened', async () => {
      const { exitCode, stdout, stderr } = await runScript(DIST_NPM_SHIM, ['--mcp'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(1);
      expect(stderr).toBe('');
      expect(JSON.parse(stdout) as Record<string, unknown>).toMatchObject({
        ok: false,
        code: 'NPM_CLI_DEPRECATED',
        install_url: 'https://inflowcli.ai/',
      });
    });
  },
);

describe('npm shim source contract', () => {
  it('detects human and agent execution modes', () => {
    expect(isNpmShimAgentMode(['node', 'npm-shim.js', '--help'], false)).toBe(false);
    expect(isNpmShimAgentMode(['node', 'npm-shim.js', '-h'], false)).toBe(false);
    expect(isNpmShimAgentMode(['node', 'npm-shim.js', '--mcp'], true)).toBe(true);
    expect(isNpmShimAgentMode(['node', 'npm-shim.js', '--format', 'json'], true)).toBe(true);
    expect(isNpmShimAgentMode(['node', 'npm-shim.js', '--format=json'], true)).toBe(true);
    expect(isNpmShimAgentMode(['node', 'npm-shim.js'], false)).toBe(true);
    expect(isNpmShimAgentMode(['node', 'npm-shim.js'], true)).toBe(false);
  });

  it('renders stable human and agent payloads', () => {
    expect(JSON.parse(renderNpmShimAgentPayload(PKG_VERSION)) as Record<string, unknown>).toEqual({
      ok: false,
      code: 'NPM_CLI_DEPRECATED',
      message: 'The npm package no longer runs InFlow commands. Install the signed native InFlow CLI.',
      install_url: 'https://inflowcli.ai/',
      package_version: PKG_VERSION,
    });
    const human = renderNpmShimHumanMessage();
    expect(human).toContain('InFlow CLI is distributed as a signed native application.');
    expect(human).toContain('https://inflowcli.ai/');
    expect(human).toContain('does not run commands, start MCP, or manage credentials');
  });

  it('writes agent payloads to stdout', async () => {
    const stdout = new CapturingWritable();
    const stderr = new CapturingWritable();
    const exitCode = await runNpmShim({
      args: ['node', 'npm-shim.js', '--mcp'],
      packageVersion: PKG_VERSION,
      stderr,
      stdout,
      stdoutIsTty: true,
    });
    expect(exitCode).toBe(1);
    expect(stderr.text).toBe('');
    expect(JSON.parse(stdout.text) as Record<string, unknown>).toMatchObject({
      code: 'NPM_CLI_DEPRECATED',
      package_version: PKG_VERSION,
    });
  });

  it('writes human messages to stderr', async () => {
    const stdout = new CapturingWritable();
    const stderr = new CapturingWritable();
    const exitCode = await runNpmShim({
      args: ['node', 'npm-shim.js', '--help'],
      packageVersion: PKG_VERSION,
      stderr,
      stdout,
      stdoutIsTty: false,
    });
    expect(exitCode).toBe(1);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('InFlow CLI is distributed as a signed native application.');
  });
});

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectSchemaPropertyNames(schema: unknown): string[] {
  if (!isJsonObject(schema)) return [];
  const properties = schema['properties'];
  const names = isJsonObject(properties) ? Object.keys(properties) : [];
  const nested = isJsonObject(properties)
    ? Object.values(properties).flatMap((property) => collectSchemaPropertyNames(property))
    : [];
  const items = collectSchemaPropertyNames(schema['items']);
  const combinators = ['allOf', 'anyOf', 'oneOf'].flatMap((key) => {
    const values = schema[key];
    return Array.isArray(values) ? values.flatMap((value) => collectSchemaPropertyNames(value)) : [];
  });
  return [...names, ...nested, ...items, ...combinators];
}

describe.skipIf(!existsSync(DIST_CLI))(
  'inflow binary (requires `pnpm --filter @inflowpayai/inflow build` first)',
  () => {
    it('package.json publishes the compatibility shim instead of the credential-running CLI', () => {
      const manifest = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8')) as {
        bin?: { inflow?: string };
        files?: string[];
        main?: string;
        types?: string;
      };
      expect(manifest.bin?.inflow).toBe('./dist/npm-shim.js');
      expect(manifest.main).toBe('./dist/npm-shim.js');
      expect(manifest.types).toBe('./dist/npm-shim.d.ts');
      expect(manifest.files).toEqual(['dist/npm-shim.js', 'dist/npm-shim.d.ts', 'README.md', 'LICENSE']);
      expect(existsSync(resolve(PACKAGE_ROOT, 'LICENSE'))).toBe(true);
      expect(existsSync(resolve(PACKAGE_ROOT, 'dist/npm-shim.d.ts'))).toBe(true);
    });

    it('--help exits 0 and prints the binary name + description', async () => {
      const { exitCode, stdout } = await run(['--help']);
      expect(exitCode).toBe(0);
      const combined = stdout;
      expect(combined).toContain('inflow');
      expect(combined).toContain('agentic discovery, onboarding, and payments');
      expect(combined).toContain('Agent Enrollment Protocol service commands');
      expect(combined).toContain('Offering Discovery Protocol commands.');
      expect(combined).toContain('Inspect a URL for agent discovery, enrollment, and payment capabilities');
      expect(combined).toContain('Machine Payments Protocol payment commands');
      expect(combined).toContain('x402 Protocol payment commands');
      expect(combined).not.toContain('--daemon');
      expect(combined).not.toMatch(/^\s+user\b/m);
    });

    it.each([
      [['odp', 'directory', '--help'], 'Search the service directory.'],
      [['odp', 'collections', '--help'], 'Browse collections from a service.'],
      [['odp', 'offerings', '--help'], 'Find and inspect offerings.'],
      [['odp', 'actions', '--help'], 'Inspect executable requests advertised by offerings.'],
    ] as const)('%s prints the ODP subgroup description', async (args, description) => {
      const { exitCode, stdout } = await run([...args]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(description);
    });

    it('odp collections shows subgroup help without initializing the vault', async () => {
      const { exitCode, stdout, stderr } = await run(['odp', 'collections']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: inflow odp collections <command>');
      expect(stdout).toContain('Browse collections from a service.');
      expect(stderr).not.toContain('vault');
    });

    it('does not dispatch the internal user command', async () => {
      const { exitCode, stdout, stderr } = await run(['user', 'get', '--format', 'json'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).not.toBe(0);
      expect(`${stdout}${stderr}`).not.toContain('"userId"');
    });

    it('rejects invalid hidden daemon modes before command registration', async () => {
      const { exitCode, stderr } = await run(['--daemon', 'nope'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(2);
      expect(stderr).toContain('Unknown daemon mode: nope');
    });

    it('--version prints the package.json version', async () => {
      const { exitCode, stdout } = await run(['--version']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(PKG_VERSION);
    });

    it('rejects an invalid --environment with exit code 2 and a stderr note', async () => {
      const { exitCode, stderr } = await run(['--environment', 'staging', '--help'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(2);
      expect(stderr).toContain(
        "Invalid INFLOW_ENVIRONMENT / --environment value: staging. Expected 'production' or 'sandbox'.",
      );
    });

    it('rejects an invalid INFLOW_ENVIRONMENT env value with exit code 2', async () => {
      const { exitCode, stderr } = await run(['--help'], {
        env: {
          ...process.env,
          INFLOW_ENVIRONMENT: 'foo',
          NO_UPDATE_NOTIFIER: '1',
        },
      });
      expect(exitCode).toBe(2);
      expect(stderr).toContain(
        "Invalid INFLOW_ENVIRONMENT / --environment value: foo. Expected 'production' or 'sandbox'.",
      );
    });

    it('strips --auth + path before incur sees them', async () => {
      const { exitCode } = await run(['--auth', '/tmp/inflow-test-auth.json', '--help'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
    });

    it('strips --sandbox before incur sees it', async () => {
      const { exitCode } = await run(['--sandbox', '--help'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
    });

    it('strips --api-key + value before incur sees them', async () => {
      const { exitCode } = await run(['--api-key', 'inflow_test_key', '--help'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
    });

    it('auth status reports API-key authentication without echoing the key', async () => {
      const secret = 'inflow_task90_secret';
      const { exitCode, stdout, stderr } = await run(
        [
          '--auth',
          `/tmp/inflow-test-api-key-status-${String(process.pid)}.json`,
          '--api-key',
          secret,
          'auth',
          'status',
          '--format',
          'json',
        ],
        {
          env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
        },
      );
      expect(exitCode).toBe(0);
      expect(`${stdout}\n${stderr}`).not.toContain(secret);
      const frames = JSON.parse(stdout) as { auth_method?: string }[];
      expect(frames[0]?.auth_method).toBe('api_key');
    });

    it('auth status uses platform-local vault storage on cold start', async () => {
      const root = mkdtempSync('/tmp/inflow-home-');
      try {
        const { exitCode, stdout } = await run(['auth', 'status', '--format', 'json'], {
          env: { ...process.env, HOME: root, NO_UPDATE_NOTIFIER: '1' },
        });
        expect(exitCode).toBe(0);
        const frames = JSON.parse(stdout) as { authenticated?: boolean }[];
        expect(frames[0]?.authenticated).toBe(false);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    });

    it('strips --verbose before incur sees it in prefix and suffix position', async () => {
      const cases = [
        ['--verbose', '--auth', `/tmp/inflow-test-verbose-prefix-${String(process.pid)}.json`, 'auth', 'status'],
        ['auth', 'status', '--verbose', '--auth', `/tmp/inflow-test-verbose-suffix-${String(process.pid)}.json`],
        ['--verbose=true', '--auth', `/tmp/inflow-test-verbose-equals-${String(process.pid)}.json`, 'auth', 'status'],
      ];
      for (const args of cases) {
        const { exitCode, stdout } = await run([...args, '--format', 'json'], {
          env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
        });
        expect(exitCode).toBe(0);
        const frames = JSON.parse(stdout) as { credentials_path?: string }[];
        expect(frames[0]?.credentials_path).toBeDefined();
      }
    });

    it('--verbose=false strips the flag without enabling verbose output', async () => {
      const { exitCode, stdout } = await run(
        [
          '--verbose=false',
          '--auth',
          `/tmp/inflow-test-verbose-false-${String(process.pid)}.json`,
          'auth',
          'status',
          '--format',
          'json',
        ],
        {
          env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
        },
      );
      expect(exitCode).toBe(0);
      const frames = JSON.parse(stdout) as { credentials_path?: string }[];
      expect(frames[0]?.credentials_path).toBeUndefined();
    });

    it('rejects invalid boolean global flag assignments before command dispatch', async () => {
      const { exitCode, stderr } = await run(['--verbose=maybe', '--help'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(2);
      expect(stderr).toContain("Invalid --verbose value: maybe. Expected 'true' or 'false'.");
    });

    it('reports a missing --format value before command dispatch', async () => {
      const { exitCode, stdout } = await run(['auth', 'status', '--format'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain('Missing value for flag: --format');
    });

    it('auth status --format md renders nested connection data instead of [object Object]', async () => {
      const { exitCode, stdout } = await run(
        ['--auth', `/tmp/inflow-test-md-${String(process.pid)}.json`, 'auth', 'status', '--format', 'md'],
        {
          env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
        },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain('apiBaseUrl');
      expect(stdout).not.toContain('[object Object]');
    });

    it('produces a built binary with the env shebang on line 1', () => {
      const head = readFileSync(DIST_CLI, 'utf-8').split('\n')[0];
      expect(head).toBe('#!/usr/bin/env node');
    });

    it('uses GitHub Releases for update checks', () => {
      const src = readFileSync(DIST_CLI, 'utf-8');
      expect(src).toContain('https://api.github.com/repos/inflowpayai/inflow-cli/releases/latest');
    });

    it('--skill prints the bundled SKILL.md body without YAML frontmatter', async () => {
      const { exitCode, stdout, stderr } = await run(['--skill'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout.startsWith('# Agentic Payments')).toBe(true);
      expect(stdout).not.toMatch(/^---/);
      expect(stdout).not.toMatch(/^name:\s*agentic-payments/m);
      expect(stdout).not.toMatch(/^allowed-tools:/m);
      expect(stdout.endsWith('\n')).toBe(true);
    });

    it('--skill <name> and --skill=<name> match the default --skill output', async () => {
      const env = { ...process.env, NO_UPDATE_NOTIFIER: '1' };
      const bare = await run(['--skill'], { env });
      const named = await run(['--skill', 'agentic-payments'], { env });
      const assigned = await run(['--skill=agentic-payments'], { env });
      expect(named.exitCode).toBe(0);
      expect(assigned.exitCode).toBe(0);
      expect(named.stdout).toBe(bare.stdout);
      expect(assigned.stdout).toBe(bare.stdout);
    });

    it('--skill agentic-enrollment prints the enrollment playbook without frontmatter', async () => {
      const { exitCode, stdout, stderr } = await run(['--skill', 'agentic-enrollment'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout.startsWith('# Agentic Enrollment')).toBe(true);
      expect(stdout).toContain('inflow aep fetch');
      expect(stdout).not.toMatch(/^---/);
    });

    it('--skill agentic-discovery prints the discovery playbook without frontmatter', async () => {
      const { exitCode, stdout, stderr } = await run(['--skill', 'agentic-discovery'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout.startsWith('# Agentic Discovery')).toBe(true);
      expect(stdout).toContain('inflow odp directory search');
      expect(stdout).not.toMatch(/^---/);
    });

    it('--skill with an unknown name exits 1 and lists the available skills on stderr', async () => {
      const { exitCode, stdout, stderr } = await run(['--skill', 'no-such-skill'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain("Unknown skill 'no-such-skill'");
      expect(stderr).toContain('agentic-discovery');
      expect(stderr).toContain('agentic-enrollment');
      expect(stderr).toContain('agentic-payments');
    });

    it('--bootstrap prints the agent setup guide and exits 0', async () => {
      const { exitCode, stdout, stderr } = await run(['--bootstrap'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout.startsWith('# InFlow - Agent Setup')).toBe(true);
      expect(stdout).not.toMatch(/^---/);
      expect(stdout.endsWith('\n')).toBe(true);
    });

    it.each(['--llms', '--llms-full'] as const)('%s omits the user command', async (flag) => {
      const { exitCode, stdout } = await run([flag, '--format', 'json'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
      const manifest = JSON.parse(stdout) as { commands: { name: string }[] };
      const names = manifest.commands.map((c) => c.name);
      expect(names).not.toContain('user get');
    });

    it('--llms manifest lists the balances list command', async () => {
      const { exitCode, stdout } = await run(['--llms', '--format', 'json'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
      const manifest = JSON.parse(stdout) as {
        commands: { name: string; description?: string }[];
      };
      const balancesList = manifest.commands.find((c) => c.name === 'balances list');
      expect(balancesList).toBeDefined();
      expect(balancesList?.description).toBe("List the authenticated user's balances");
    });

    it('--llms manifest lists the deposit-addresses list command', async () => {
      const { exitCode, stdout } = await run(['--llms', '--format', 'json'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
      const manifest = JSON.parse(stdout) as {
        commands: { name: string; description?: string }[];
      };
      const depositAddressesList = manifest.commands.find((c) => c.name === 'deposit-addresses list');
      expect(depositAddressesList).toBeDefined();
      expect(depositAddressesList?.description).toBe("List the authenticated user's configured deposit addresses");
    });

    it('--llms manifest contains the ODP command descriptions', async () => {
      const { exitCode, stdout } = await run(['--llms', '--format', 'json'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
      const manifest = JSON.parse(stdout) as {
        commands: { name: string; description?: string }[];
      };
      const descriptions = new Map(manifest.commands.map((command) => [command.name, command.description]));
      const expected = [
        ['odp actions resolve', "Resolve an offering's action into an executable request without invoking it."],
        ['odp collections get', 'Get full collection details.'],
        ['odp collections list', 'List collections from a service.'],
        ['odp collections search', 'Search collections from a service.'],
        ['odp directory search', 'Search the directory for services.'],
        ['odp directory suggest', 'Suggest directory keywords.'],
        ['odp inspect', "Inspect a service's capabilities."],
        ['odp offerings discover', 'Find offerings across services selected from the directory.'],
        ['odp offerings get', 'Get full offering details.'],
        ['odp offerings list', 'List offerings from a service.'],
        ['odp offerings search', 'Search offerings from a service.'],
      ] as const;
      for (const [name, description] of expected) expect(descriptions.get(name)).toBe(description);
    });

    it.each(['--llms', '--llms-full'] as const)('%s lists every AEP command', async (flag) => {
      const { exitCode, stdout } = await run([flag, '--format', 'json'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
      const manifest = JSON.parse(stdout) as { commands: { name: string }[] };
      const names = manifest.commands.map((command) => command.name);
      expect(names).toEqual(expect.arrayContaining([...AEP_COMMANDS]));
    });

    it.each(['--llms', '--llms-full'] as const)('%s lists every vault command', async (flag) => {
      const { exitCode, stdout } = await run([flag, '--format', 'json'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
      const manifest = JSON.parse(stdout) as { commands: { name: string }[] };
      const names = manifest.commands.map((command) => command.name);
      expect(names).toEqual(expect.arrayContaining([...VAULT_COMMANDS]));
    });

    it('balances list --schema returns an empty-properties JSON Schema', async () => {
      const { exitCode, stdout } = await run(['balances', 'list', '--schema', '--format', 'json'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as {
        options?: { type?: string; properties?: Record<string, unknown> };
      };
      expect(parsed.options?.type).toBe('object');
      expect(parsed.options?.properties ?? {}).toEqual({});
    });

    it('deposit-addresses list --schema returns an empty-properties JSON Schema', async () => {
      const { exitCode, stdout } = await run(['deposit-addresses', 'list', '--schema', '--format', 'json'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as {
        options?: { type?: string; properties?: Record<string, unknown> };
      };
      expect(parsed.options?.type).toBe('object');
      expect(parsed.options?.properties ?? {}).toEqual({});
    });

    it.each(CLI_SCHEMA_COMMANDS)('%s exposes a JSON Schema without starting runtime work', async (command) => {
      const { exitCode, stdout, stderr } = await run([...command.split(' '), '--schema', '--format', 'json'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as {
        args?: { type?: string; properties?: Record<string, unknown> };
        options?: { type?: string; properties?: Record<string, unknown> };
      };
      const schema = parsed.options ?? parsed.args;
      if (schema === undefined) {
        expect(parsed).toEqual({});
      } else {
        expect(schema.type).toBe('object');
        expect(schema.properties ?? {}).toBeTypeOf('object');
      }
    });

    it('--mcp tools/list exposes the expected public tools and omits user_get', async () => {
      const request =
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }) + '\n';
      const { exitCode, stdout } = await run(['--mcp'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
        stdin: request,
      });
      expect(exitCode).toBe(0);
      const line = stdout.split('\n').find((l) => l.trim().length > 0);
      expect(line).toBeDefined();
      const response = JSON.parse(line ?? '{}') as {
        result?: {
          tools?: {
            name: string;
            title?: string;
            annotations?: {
              destructiveHint?: boolean;
              idempotentHint?: boolean;
              openWorldHint?: boolean;
              readOnlyHint?: boolean;
              title?: string;
            };
            inputSchema?: { type?: string; properties?: Record<string, unknown> };
          }[];
        };
      };
      const tools = response.result?.tools ?? [];
      expect(tools.map((entry) => entry.name).sort()).toEqual(MCP_TOOL_EXPECTATIONS.map(([name]) => name).sort());
      for (const [name, title, readOnlyHint, destructiveHint] of MCP_TOOL_EXPECTATIONS) {
        expect(
          tools.find((entry) => entry.name === name),
          name,
        ).toMatchObject({
          title,
          annotations: { destructiveHint, readOnlyHint, title },
          inputSchema: { type: 'object' },
        });
      }
      expect(tools.map((entry) => entry.name)).not.toContain('user_get');
      expect(tools.find((entry) => entry.name === 'auth_status')).toMatchObject({
        title: 'InFlow Account: Check Login',
        annotations: { readOnlyHint: true, title: 'InFlow Account: Check Login' },
      });
      expect(tools.find((entry) => entry.name === 'mpp_pay')).toMatchObject({
        title: 'MPP: Pay Resource',
        annotations: { destructiveHint: true, readOnlyHint: false, title: 'MPP: Pay Resource' },
      });
      expect(tools.find((entry) => entry.name === 'vault_unlock')).toMatchObject({
        title: 'Vault: Unlock Vault',
        annotations: { openWorldHint: false, readOnlyHint: false, title: 'Vault: Unlock Vault' },
      });
      const titles = tools.map((entry) => entry.title ?? entry.name);
      expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
      expect(titles.filter((title) => /^\d+:/.test(title))).toEqual([]);
      expect(tools.map((entry) => entry.name)).toEqual(expect.arrayContaining(AEP_MCP_TOOLS));
      for (const name of AEP_MCP_TOOLS) {
        expect(tools.find((entry) => entry.name === name)?.inputSchema?.type, name).toBe('object');
      }
      expect(tools.map((entry) => entry.name)).toEqual(expect.arrayContaining(VAULT_MCP_TOOLS));
      for (const name of VAULT_MCP_TOOLS) {
        expect(tools.find((entry) => entry.name === name)?.inputSchema?.type, name).toBe('object');
      }
      expect(tools.map((entry) => entry.name)).toEqual(expect.arrayContaining(PAYMENT_FETCH_MCP_TOOLS));
      for (const name of PAYMENT_FETCH_MCP_TOOLS) {
        const fetchTool = tools.find((entry) => entry.name === name);
        const properties = fetchTool?.inputSchema?.properties ?? {};
        const expectedTypes: Record<string, string> = {
          transactionId: 'string',
          resourceUrl: 'string',
          method: 'string',
          header: 'array',
          data: 'string',
          interval: 'number',
          maxAttempts: 'number',
          timeout: 'number',
          showBody: 'boolean',
          outputFile: 'string',
        };
        for (const [property, type] of Object.entries(expectedTypes)) {
          expect((properties[property] as { type?: string } | undefined)?.type, `${name}.${property}`).toBe(type);
        }
      }
      const rawSecretFields = tools.flatMap((entry) =>
        collectSchemaPropertyNames(entry.inputSchema)
          .filter((property) => RAW_SECRET_SCHEMA_FIELDS.has(property))
          .map((property) => `${entry.name}.${property}`),
      );
      expect(rawSecretFields).toEqual([]);
    });

    it('--mcp vault tools hide daemon details and do not prompt for unlock input', async () => {
      const root = mkdtempSync('/tmp/inflow-mcp-home-');
      const request = [
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vault_status', arguments: {} } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'vault_unlock', arguments: {} } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n');
      try {
        const { exitCode, stdout } = await run(['--mcp'], {
          env: { ...process.env, HOME: root, NO_UPDATE_NOTIFIER: '1' },
          stdin: `${request}\n`,
        });
        expect(exitCode).toBe(0);
        const responses = stdout
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map(
            (line) =>
              JSON.parse(line) as { id?: number; result?: { content?: { text?: string }[]; isError?: boolean } },
          );
        const status = responses.find((entry) => entry.id === 1);
        const unlock = responses.find((entry) => entry.id === 2);
        const statusText = status?.result?.content?.[0]?.text ?? '';
        expect(JSON.parse(statusText)).toEqual({ lock_state: 'not_initialized' });
        expect(statusText).not.toContain('daemon');
        expect(unlock?.result?.isError).toBe(true);
        expect(unlock?.result?.content?.[0]?.text).toContain('A human must run `inflow vault unlock`');
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    });
  },
);

const REPO_ROOT = resolve(PACKAGE_ROOT, '../../');
const SKILL_NAMES = readdirSync(resolve(REPO_ROOT, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(resolve(REPO_ROOT, 'skills', entry.name, 'SKILL.md')))
  .map((entry) => entry.name)
  .sort();

function readRepoFile(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf-8');
}

function parseJsonRepoFile<T = unknown>(rel: string): T {
  return JSON.parse(readRepoFile(rel)) as T;
}

describe('plugin and skill distribution (spec 050)', () => {
  it('.claude-plugin/marketplace.json parses and names the inflow plugin', () => {
    const parsed = parseJsonRepoFile<{
      name?: string;
      plugins?: { name?: string; source?: string }[];
    }>('.claude-plugin/marketplace.json');
    expect(parsed.name).toBe('inflow');
    expect(parsed.plugins?.[0]?.name).toBe('inflow');
    expect(parsed.plugins?.[0]?.source).toBe('./plugins/inflow');
  });

  it('plugins/inflow/.claude-plugin/plugin.json parses and points at ./skills/ + ./.mcp.json', () => {
    const parsed = parseJsonRepoFile<{
      name?: string;
      version?: string;
      skills?: string;
      mcpServers?: string;
    }>('plugins/inflow/.claude-plugin/plugin.json');
    expect(parsed.name).toBe('inflow');
    expect(parsed.skills).toBe('./skills/');
    expect(parsed.mcpServers).toBe('./.mcp.json');
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('.codex-plugin/plugin.json parses with the locked InFlow display identity', () => {
    const parsed = parseJsonRepoFile<{
      name?: string;
      version?: string;
      interface?: {
        displayName?: string;
        shortDescription?: string;
        composerIcon?: string;
        logo?: string;
      };
    }>('.codex-plugin/plugin.json');
    expect(parsed.name).toBe('inflow');
    expect(parsed.interface?.displayName).toBe('InFlow');
    expect(parsed.interface?.shortDescription).toContain('agentic MPP / x402 payments');
    expect(parsed.interface?.composerIcon).toBe('./assets/inflow.svg');
    expect(parsed.interface?.logo).toBe('./assets/inflow.svg');
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('plugins/inflow/.codex-plugin/plugin.json mirrors the root codex manifest shape', () => {
    const parsed = parseJsonRepoFile<{
      name?: string;
      interface?: { displayName?: string };
    }>('plugins/inflow/.codex-plugin/plugin.json');
    expect(parsed.name).toBe('inflow');
    expect(parsed.interface?.displayName).toBe('InFlow');
  });

  it('.mcp.json parses and uses the signed binary invocation', () => {
    const parsed = parseJsonRepoFile<{
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    }>('.mcp.json');
    const entry = parsed.mcpServers?.['inflow'];
    expect(entry?.command).toBe('inflow');
    expect(entry?.args).toEqual(['--mcp']);
  });

  for (const name of SKILL_NAMES) {
    it(`skills/${name}/SKILL.md has version and distribution metadata`, () => {
      const skill = readRepoFile(`skills/${name}/SKILL.md`);
      const versionMatch = skill.match(/^version:\s*(\d+\.\d+\.\d+[^\s]*)$/m);
      expect(versionMatch).not.toBeNull();
      const metadataMatch = skill.match(/^metadata:\s*(\{.*\})$/m);
      expect(metadataMatch).not.toBeNull();
      const metadata = JSON.parse(metadataMatch?.[1] ?? '{}') as {
        author?: string;
        openclaw?: {
          install?: { cask?: string; kind?: string; tap?: string; url?: string }[];
        };
      };
      expect(metadata.author).toBe('Jarwin, Inc.');
      expect(metadata.openclaw?.install).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cask: 'inflow',
            kind: 'homebrew',
            tap: 'inflowpayai/tap',
          }),
          expect.objectContaining({
            kind: 'shell',
            url: 'https://inflowcli.ai/install.sh',
          }),
        ]),
      );
    });
  }

  it('skill version, plugin manifests, and packages/cli/package.json all agree', () => {
    const cliVersion = PKG_VERSION;
    for (const name of SKILL_NAMES) {
      const skill = readRepoFile(`skills/${name}/SKILL.md`);
      const skillVersion = skill.match(/^version:\s*(.+)$/m)?.[1]?.trim();
      expect(skillVersion, name).toBe(cliVersion);
    }

    for (const rel of [
      'plugins/inflow/.claude-plugin/plugin.json',
      '.codex-plugin/plugin.json',
      'plugins/inflow/.codex-plugin/plugin.json',
    ]) {
      const parsed = parseJsonRepoFile<{ version?: string }>(rel);
      expect(parsed.version, `${rel} version`).toBe(cliVersion);
    }
  });
});
