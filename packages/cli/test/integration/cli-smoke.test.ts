/**
 * End-to-end smoke test against the built binary. Exercises the no-network paths that don't require a real sandbox
 * account: `--version`, `--skill`, the agent-mode error envelope for `x402 decode`, the unauthenticated `auth status`
 * frame, and the happy decode path. Run after `pnpm build` (AGENTS.md says the CLI's integration tests run against
 * `dist/cli.js`).
 *
 * If you want a live-sandbox smoke run, set `INFLOW_API_KEY` and `INFLOW_SMOKE_SANDBOX=1` — the gated `live sandbox`
 * block below hits `user get` and `balances list` against `sandbox.inflowpay.ai`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath, dirname, join } from 'node:path';
import { encode, renderChallengeHeader } from '@inflowpayai/mpp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 15_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolvePath(here, '../../dist/cli.js');

let authDir = '';
let authFile = '';
beforeAll(() => {
  authDir = mkdtempSync(join(tmpdir(), 'inflow-smoke-'));
  authFile = join(authDir, 'auth.json');
});
afterAll(() => {
  if (authDir.length > 0) {
    rmSync(authDir, { recursive: true, force: true });
  }
});

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return new Promise((resolveResult, reject) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      INFLOW_AUTH_FILE: authFile,
      INFLOW_API_KEY: '',
      INFLOW_BASE_URL: 'http://127.0.0.1:1',
      INFLOW_ENVIRONMENT: 'sandbox',
      NO_UPDATE_NOTIFIER: '1',
      ...env,
    };
    const child = spawn(process.execPath, [cliBin, ...args], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolveResult({ stdout, stderr, exitCode: exitCode ?? -1 });
    });
  });
}

function parseAgentJson(out: string): unknown {
  const trimmed = out.trim();
  if (trimmed.length === 0) throw new Error('empty stdout');
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split('\n').filter((l) => l.length > 0);
    const last = lines[lines.length - 1];
    if (last === undefined) throw new Error('no JSON lines in stdout');
    return JSON.parse(last);
  }
}

describe('cli smoke', () => {
  it('the build produces an executable dist/cli.js', () => {
    expect(existsSync(cliBin)).toBe(true);
  });

  it('--version prints a semver-shaped string and exits 0', async () => {
    const result = await run(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/);
  });

  it('--skill prints the bundled skill body to stdout and exits 0', async () => {
    const result = await run(['--skill']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(100);
    expect(result.stdout.trimStart().startsWith('---')).toBe(false);
  });

  it('auth status --format json yields an unauthenticated frame on a cold start', async () => {
    const result = await run(['auth', 'status', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const parsed = parseAgentJson(result.stdout);
    const frames = Array.isArray(parsed) ? parsed : [parsed];
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const first = frames[0] as { authenticated: boolean };
    expect(first.authenticated).toBe(false);
  });

  it('mpp decode --format json decodes a WWW-Authenticate: Payment header to a challenge', async () => {
    const header = renderChallengeHeader({
      id: 'chal-1',
      realm: 'mpp.test',
      method: 'inflow',
      intent: 'charge',
      request: encode({ amount: '10', currency: 'USDC', methodDetails: { rail: 'balance' } }),
    });
    const result = await run(['mpp', 'decode', header, '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const parsed = parseAgentJson(result.stdout) as { kind: string };
    expect(parsed.kind).toBe('challenge');
  });

  it('mpp decode --format json emits a DECODE_FAILED error envelope on garbage input', async () => {
    const result = await run(['mpp', 'decode', '@@@not-decodable@@@', '--format', 'json']);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('DECODE_FAILED');
  });

  it('x402 decode --format json emits a DECODE_FAILED error envelope on garbage input', async () => {
    const result = await run(['x402', 'decode', 'garbage', '--format', 'json']);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('DECODE_FAILED');
  });

  describe.skipIf(process.env.INFLOW_SMOKE_SANDBOX !== '1')('live sandbox', () => {
    it('user get --format json returns a userId when INFLOW_API_KEY is valid', async () => {
      const apiKey = process.env.INFLOW_API_KEY;
      if (apiKey === undefined || apiKey.length === 0) {
        throw new Error('INFLOW_SMOKE_SANDBOX=1 requires INFLOW_API_KEY to be set');
      }
      const result = await run(['--sandbox', 'user', 'get', '--format', 'json'], {
        INFLOW_API_KEY: apiKey,
        INFLOW_BASE_URL: 'https://sandbox.inflowpay.ai',
      });
      expect(result.exitCode).toBe(0);
      const user = parseAgentJson(result.stdout) as { userId: string };
      expect(typeof user.userId).toBe('string');
      expect(user.userId.length).toBeGreaterThan(0);
    });

    it('balances list --format json returns an array', async () => {
      const apiKey = process.env.INFLOW_API_KEY;
      if (apiKey === undefined || apiKey.length === 0) {
        throw new Error('INFLOW_SMOKE_SANDBOX=1 requires INFLOW_API_KEY to be set');
      }
      const result = await run(['--sandbox', 'balances', 'list', '--format', 'json'], {
        INFLOW_API_KEY: apiKey,
        INFLOW_BASE_URL: 'https://sandbox.inflowpay.ai',
      });
      expect(result.exitCode).toBe(0);
      const balances = parseAgentJson(result.stdout);
      expect(Array.isArray(balances)).toBe(true);
    });
  });
});
