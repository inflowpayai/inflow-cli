import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 15_000 });

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '../../');
const DIST_CLI = resolve(PACKAGE_ROOT, 'dist/cli.js');
const PKG_VERSION: string = (
  JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8')) as { version: string }
).version;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RunOptions extends SpawnOptionsWithoutStdio {
  stdin?: string;
}

function run(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { stdin, ...spawnOptions } = options;
  const stdio: ['ignore' | 'pipe', 'pipe', 'pipe'] = [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'];
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [DIST_CLI, ...args], {
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

describe.skipIf(!existsSync(DIST_CLI))(
  'inflow binary (requires `pnpm --filter @inflowpayai/inflow build` first)',
  () => {
    it('--help exits 0 and prints the binary name + description', async () => {
      const { exitCode, stdout } = await run(['--help']);
      expect(exitCode).toBe(0);
      const combined = stdout;
      expect(combined).toContain('inflow');
      expect(combined).toMatch(/agentic MPP/);
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

    it('does not bundle update-notifier (external in tsup config)', () => {
      const src = readFileSync(DIST_CLI, 'utf-8');
      expect(src).not.toContain('update-notifier/package.json');
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

    it('--llms manifest lists the user get command', async () => {
      const { exitCode, stdout } = await run(['--llms', '--format', 'json'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
      const manifest = JSON.parse(stdout) as {
        commands: { name: string; description?: string }[];
      };
      const names = manifest.commands.map((c) => c.name);
      expect(names).toContain('user get');
      const userGet = manifest.commands.find((c) => c.name === 'user get');
      expect(userGet?.description).toBe('Retrieve the current authenticated user');
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

    it('user get --schema returns an empty-properties JSON Schema', async () => {
      const { exitCode, stdout } = await run(['user', 'get', '--schema', '--format', 'json'], {
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as {
        options?: { type?: string; properties?: Record<string, unknown> };
      };
      expect(parsed.options?.type).toBe('object');
      expect(parsed.options?.properties ?? {}).toEqual({});
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

    it('--mcp tools/list exposes user_get with an empty input schema', async () => {
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
            inputSchema?: { type?: string; properties?: Record<string, unknown> };
          }[];
        };
      };
      const tools = response.result?.tools ?? [];
      const tool = tools.find((t) => t.name === 'user_get');
      expect(tool).toBeDefined();
      expect(tool?.inputSchema?.type).toBe('object');
      expect(tool?.inputSchema?.properties ?? {}).toEqual({});
    });

    it('user get --format json without auth emits NOT_AUTHENTICATED and exits 1', async () => {
      const cleanEnv: Record<string, string | undefined> = {
        ...process.env,
        NO_UPDATE_NOTIFIER: '1',
        INFLOW_API_KEY: undefined,
        INFLOW_AUTH_FILE: undefined,
      };
      for (const key of Object.keys(cleanEnv)) {
        if (cleanEnv[key] === undefined) delete cleanEnv[key];
      }
      const { exitCode, stdout } = await run(
        ['--auth', '/tmp/inflow-test-no-auth.json', 'user', 'get', '--format', 'json'],
        { env: cleanEnv as NodeJS.ProcessEnv },
      );
      expect(exitCode).toBe(1);
      const payload = JSON.parse(stdout) as {
        code?: string;
        message?: string;
      };
      expect(payload.code).toBe('NOT_AUTHENTICATED');
      expect(payload.message).toContain('Not authenticated.');
    });
  },
);

const REPO_ROOT = resolve(PACKAGE_ROOT, '../../');

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

  it('.mcp.json parses and uses the documented npx -y invocation', () => {
    const parsed = parseJsonRepoFile<{
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    }>('.mcp.json');
    const entry = parsed.mcpServers?.['inflow'];
    expect(entry?.command).toBe('npx');
    expect(entry?.args).toEqual(['-y', '@inflowpayai/inflow', '--mcp']);
  });

  it('skills/agentic-payments/SKILL.md exists, has a semver version: line, and a parseable inline metadata JSON', () => {
    const skill = readRepoFile('skills/agentic-payments/SKILL.md');
    const versionMatch = skill.match(/^version:\s*(\d+\.\d+\.\d+[^\s]*)$/m);
    expect(versionMatch).not.toBeNull();
    const metadataMatch = skill.match(/^metadata:\s*(\{.*\})$/m);
    expect(metadataMatch).not.toBeNull();
    const metadata = JSON.parse(metadataMatch?.[1] ?? '{}') as {
      author?: string;
      openclaw?: { emoji?: string; install?: { package?: string }[] };
    };
    expect(metadata.author).toBe('Jarwin, Inc.');
    expect(metadata.openclaw?.install?.[0]?.package).toBe('@inflowpayai/inflow');
  });

  it('skill version, plugin manifests, and packages/cli/package.json all agree', () => {
    const cliVersion = PKG_VERSION;
    const skill = readRepoFile('skills/agentic-payments/SKILL.md');
    const skillVersion = skill.match(/^version:\s*(.+)$/m)?.[1]?.trim();
    expect(skillVersion).toBe(cliVersion);

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
