/**
 * Smoke tests against the built binary, including completed MPP and x402 payments with local HTTP fixtures. Run after
 * `pnpm build`.
 *
 * If you want a live-sandbox smoke run, set `INFLOW_API_KEY` and `INFLOW_SMOKE_SANDBOX=1` — the gated `live sandbox`
 * block below hits `balances list` against `sandbox.inflowpay.ai`.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath, dirname, join } from 'node:path';
import { encode, renderChallengeHeader } from '@inflowpayai/mpp';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 15_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = resolvePath(here, '../../dist/cli.js');
const packagedExecutable = process.env['INFLOW_SMOKE_EXECUTABLE'];

let authDir = '';
let authFile = '';
beforeAll(() => {
  const temporaryRoot = process.platform === 'darwin' ? '/private/tmp' : tmpdir();
  authDir = realpathSync(mkdtempSync(join(temporaryRoot, 'inflow-smoke-')));
  authFile = join(authDir, 'auth.json');
});
afterAll(async () => {
  if (authDir.length > 0) {
    // The installed Linux vault belongs to the operating-system user, not the temporary home directory.
    if (process.platform !== 'linux' || packagedExecutable === undefined) {
      await run(['vault', 'reset', '--force', '--format', 'json']);
    }
    rmSync(authDir, { recursive: true, force: true });
  }
});

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type TestServerHandler = (req: IncomingMessage, res: ServerResponse) => void;

function run(args: string[], env: NodeJS.ProcessEnv = {}, timeout?: number): Promise<RunResult> {
  return new Promise((resolveResult, reject) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      INFLOW_AUTH_FILE: authFile,
      INFLOW_API_KEY: '',
      INFLOW_BASE_URL: 'http://127.0.0.1:1',
      INFLOW_ENVIRONMENT: 'sandbox',
      HOME: authDir,
      NO_UPDATE_NOTIFIER: '1',
      XDG_DATA_HOME: join(authDir, '.local', 'share'),
      ...env,
    };
    const child = spawn(
      packagedExecutable ?? process.execPath,
      packagedExecutable === undefined ? [cliBin, ...args] : args,
      {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(timeout === undefined ? {} : { timeout }),
      },
    );
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

function callMcp(
  name: string,
  arguments_: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  afterInitialize?: () => Promise<unknown>,
): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliBin, '--mcp'], {
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    let response: string | undefined;
    let initialized = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n').slice(0, -1)) {
        const message = JSON.parse(line) as { id?: number };
        if (message.id === 1 && !initialized) {
          initialized = true;
          void Promise.resolve()
            .then(afterInitialize)
            .then(
              () => {
                child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
                child.stdin.write(
                  `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: arguments_ } })}\n`,
                );
              },
              (error: unknown) => {
                child.kill('SIGTERM');
                reject(error instanceof Error ? error : new Error(String(error)));
              },
            );
        }
        if (message.id === 2) {
          response = line;
          child.kill('SIGTERM');
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      if (response === undefined) reject(new Error(`MCP did not respond: ${errors}`));
      else resolveResult(response);
    });
    for (const message of [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vault-test', version: '1' } },
      },
    ])
      child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

async function withSeller(handler: TestServerHandler, test: (url: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolveListening) => {
    server.listen(0, '127.0.0.1', resolveListening);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    await closeServer(server);
    throw new Error('test server did not expose a port');
  }
  try {
    await test(`http://127.0.0.1:${address.port}/paywalled`);
  } finally {
    await closeServer(server);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClosed, reject) => {
    server.close((err) => {
      if (err !== undefined) reject(err);
      else resolveClosed();
    });
  });
}

describe('cli smoke', () => {
  it('AEP fetch sends JSON data without an explicit content-type header', async () => {
    const body = '{ "query": "OpenAI official documentation", "num_results": 1 }\n';
    const received: Array<{ body: string; contentType: string | undefined }> = [];
    await withSeller(
      (request, response) => {
        if (request.url !== '/paywalled') {
          response.writeHead(404);
          response.end();
          return;
        }
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          received.push({ body: Buffer.concat(chunks).toString('utf8'), contentType: request.headers['content-type'] });
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{"ok":true}');
        });
      },
      async (url) => {
        const result = await run([
          'aep',
          'fetch',
          url,
          '--method',
          'POST',
          '--data',
          body,
          '--format',
          'json',
          '--api-key',
          'local-fixture-key',
        ]);
        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain('not-required');
        expect(received).toEqual([{ body, contentType: 'application/json' }]);
      },
    );
  });

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

  it.each(['auth', 'aep', 'balances', 'deposit-addresses', 'mpp', 'subscriptions', 'vault', 'x402'])(
    '%s group help does not require the vault daemon',
    async (group) => {
      const result = await run([group]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage:');
      expect(result.stderr).not.toContain('vault daemon');
    },
  );

  it('leaf help does not require the vault daemon', async () => {
    for (const args of [
      ['aep', 'status', '--help'],
      ['mpp', 'pay', '--help'],
      ['balances', 'list', '--help'],
      ['subscriptions', 'list', '--help'],
    ]) {
      const result = await run(args);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage:');
      expect(result.stderr).not.toContain('vault daemon');
    }
  });

  it.skipIf(process.platform !== 'darwin')(
    'starts and resets the development vault daemon from the built CLI',
    async () => {
      const vaultRoot = mkdtempSync(join('/tmp', 'inflow-development-vault-'));
      const env = {
        HOME: vaultRoot,
        XDG_DATA_HOME: join(vaultRoot, 'data'),
      };
      try {
        const policy = await run(['vault', 'policy', '--format', 'json'], env);
        expect(policy.exitCode, `${policy.stdout}\n${policy.stderr}`).toBe(0);
        expect(parseAgentJson(policy.stdout)).toEqual(expect.any(Object));

        const reset = await run(['vault', 'reset', '--force', '--format', 'json'], env);
        expect(reset.exitCode, `${reset.stdout}\n${reset.stderr}`).toBe(0);
        expect(parseAgentJson(reset.stdout)).toEqual({ reset: true });
      } finally {
        await run(['vault', 'reset', '--force', '--format', 'json'], env);
        rmSync(vaultRoot, { recursive: true, force: true });
      }
    },
  );

  it('auth status --format json yields an unauthenticated frame on a cold start', async () => {
    const result = await run(['auth', 'status', '--format', 'json']);
    expect(result.exitCode).toBe(0);
    const parsed = parseAgentJson(result.stdout);
    const frames = Array.isArray(parsed) ? parsed : [parsed];
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const first = frames[0] as { authenticated: boolean };
    expect(first.authenticated).toBe(false);
  });

  it.skipIf(packagedExecutable !== undefined || process.platform === 'win32')(
    'anonymous inspection does not start a vault on a fresh installation',
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'inflow-anonymous-inspect-')));
      const env = { HOME: root, XDG_DATA_HOME: join(root, 'data'), INFLOW_AUTH_FILE: join(root, 'auth.json') };
      const vaultRoot =
        process.platform === 'darwin'
          ? join(root, 'Library', 'Application Support', 'InFlow')
          : join(root, 'data', 'inflow');
      try {
        await withSeller(
          (_req, res) => {
            res.end('public resource');
          },
          async (url) => {
            const result = await run(['x402', 'inspect', url, '--format', 'json'], env);
            expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
            expect(existsSync(join(vaultRoot, 'run', 'vault.sock'))).toBe(false);
            expect(existsSync(join(vaultRoot, 'inflow.vault'))).toBe(false);
          },
        );
      } finally {
        const reset = await run(['vault', 'reset', '--force', '--format', 'json'], env);
        expect(reset.exitCode, `${reset.stdout}\n${reset.stderr}`).toBe(0);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

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

  it('mpp decode --format json returns every alternative in a combined header', async () => {
    const header = ['USDC', 'USDT']
      .map((currency) =>
        renderChallengeHeader({
          id: currency,
          realm: 'mpp.test',
          method: 'inflow',
          intent: 'charge',
          request: encode({ amount: '0.0098', currency, methodDetails: { rail: 'balance' } }),
        }),
      )
      .join(', ');
    const result = await run(['mpp', 'decode', header, '--format', 'json']);
    expect(result.exitCode).toBe(0);
    expect(parseAgentJson(result.stdout)).toMatchObject({
      kind: 'challenges',
      challenges: [
        { id: 'USDC', amount: '0.0098', currency: 'USDC', rail: 'balance' },
        { id: 'USDT', amount: '0.0098', currency: 'USDT', rail: 'balance' },
      ],
    });
  });

  it.skipIf(process.platform !== 'darwin' || packagedExecutable !== undefined)(
    'credential-using commands restart a stopped vault and report locked credentials without prompting an agent',
    async () => {
      const root = realpathSync(mkdtempSync(join('/private/tmp', 'inflow-inspect-vault-')));
      const env = {
        HOME: root,
        XDG_DATA_HOME: join(root, 'data'),
        INFLOW_AUTH_FILE: join(root, 'auth.json'),
        INFLOW_API_KEY: undefined,
      };
      const coreUrl = new URL('../../../core/dist/index.js', import.meta.url).href;
      const execute = promisify(execFile);
      const vaultScript = (body: string) =>
        execute(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
        import { LocalVaultClient, Storage, SyncVaultSecretStore } from ${JSON.stringify(coreUrl)};
        const client = new LocalVaultClient();
        ${body}
      `,
          ],
          { env: { ...process.env, ...env }, timeout: 10_000 },
        );
      try {
        expect((await run(['vault', 'policy', '--format', 'json'], env)).exitCode).toBe(0);
        await vaultScript(`
          await client.unlock(Buffer.from('test-inspection-only-passphrase'));
          new Storage({ configPath: process.env.INFLOW_AUTH_FILE }).setAuth({
            access_token: 'test-access', refresh_token: 'test-refresh', token_type: 'Bearer',
            expires_in: 3600, expires_at: Date.now() + 3600000,
          });
        `);
        for (const command of [
          ['mpp', 'inspect', 'http://127.0.0.1:1/resource'],
          ['x402', 'inspect', 'http://127.0.0.1:1/resource'],
          ['aep', 'inspect', 'https://service.test'],
          ['balances', 'list'],
          ['deposit-addresses', 'list'],
          ['subscriptions', 'list'],
          ['subscriptions', 'get', 'test-subscription'],
          ['mpp', 'pay', 'https://service.test', '--api-key', 'test-key'],
          ['x402', 'pay', 'https://service.test', '--api-key', 'test-key'],
          ['x402', 'fetch', 'test-transaction', 'https://service.test', '--api-key', 'test-key'],
          ['odp', 'inspect', 'https://service.test'],
          ['inspect', 'https://service.test/resource'],
        ]) {
          await vaultScript('await client.shutdown();');
          const result = await run([...command, '--format', 'json'], env);
          expect(result.exitCode).not.toBe(0);
          expect(`${result.stdout}${result.stderr}`).toContain('VAULT_LOCKED');
          expect(`${result.stdout}${result.stderr}`).toContain('inflow vault unlock');
          expect(`${result.stdout}${result.stderr}`).not.toContain('daemon is unavailable');
          await vaultScript("if (!(await client.status()).daemonRunning) throw new Error('daemon did not restart');");
        }
        for (const [name, arguments_] of [
          ['aep_inspect', { serviceReference: 'https://service.test' }],
          ['odp_inspect', { service: 'https://service.test' }],
          ['mpp_cancel', { approvalId: 'test-approval' }],
          ['x402_cancel', { approvalId: 'test-approval' }],
          ['inspect', { url: 'https://service.test/resource' }],
        ] as const) {
          await vaultScript('await client.shutdown();');
          const response = await callMcp(name, arguments_, env);
          expect(response).toContain('inflow vault unlock');
          expect(response).not.toContain('daemon is unavailable');
        }
        const received: { key: string | undefined; bearer: string | undefined }[] = [];
        let requests = 0;
        await withSeller(
          (req, res) => {
            requests += 1;
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/v1/balances') {
              const key = req.headers['x-api-key'];
              received.push({ key: typeof key === 'string' ? key : undefined, bearer: req.headers.authorization });
              res.end(JSON.stringify({ balances: [] }));
            } else {
              res.statusCode = 404;
              res.end('{}');
            }
          },
          async (url) => {
            const environment = { ...env, INFLOW_BASE_URL: new URL(url).origin };
            const unlock = () => vaultScript("await client.unlock(Buffer.from('test-inspection-only-passphrase'));");
            const device = await callMcp('balances_list', {}, environment, unlock);
            expect(device).not.toContain('isError');
            expect(received).toEqual([{ key: undefined, bearer: 'Bearer test-access' }]);
            await vaultScript(`
            new Storage({ configPath: process.env.INFLOW_AUTH_FILE }).setApiKey('stored-test-key');
            await client.lock();
          `);
            const blocked = await callMcp('balances_list', {}, environment, unlock);
            expect(blocked).toContain('reconnect the InFlow MCP server');
            expect(received).toHaveLength(1);
            const reconnected = await callMcp('balances_list', {}, environment);
            expect(reconnected).not.toContain('isError');
            expect(received.at(-1)).toEqual({ key: 'stored-test-key', bearer: undefined });
            await vaultScript('await client.lock();');
            const explicit = await callMcp(
              'balances_list',
              {},
              { ...environment, INFLOW_API_KEY: 'explicit-test-key' },
            );
            expect(explicit).not.toContain('isError');
            expect(received.at(-1)).toEqual({ key: 'explicit-test-key', bearer: undefined });
            const document = await callMcp('inspect', { url: `${new URL(url).origin}/openapi.json` }, environment);
            expect(document).toContain('Unable to read a valid public ODP or JSON OpenAPI');
            expect(document).not.toContain('reconnect');
            const decoded = await callMcp(
              'mpp_decode',
              {
                value: renderChallengeHeader({
                  id: 'public-decode',
                  realm: 'service.test',
                  method: 'inflow',
                  intent: 'charge',
                  request: encode({ amount: '10', currency: 'USDC', methodDetails: { rail: 'balance' } }),
                  expires: '2999-01-01T00:00:00Z',
                }),
              },
              environment,
            );
            expect(decoded).not.toContain('isError');
            expect(decoded).toContain('public-decode');
            const resource = await callMcp('inspect', { url: `${new URL(url).origin}/resource` }, environment);
            expect(resource).toContain('reconnect the InFlow MCP server');
            await vaultScript('await client.shutdown();');
            const stopped = await callMcp('balances_list', {}, environment);
            expect(stopped).toContain('reconnect the InFlow MCP server');
            expect(received).toHaveLength(3);
            expect((await run(['vault', 'status', '--format', 'json'], env)).exitCode).toBe(0);
            await unlock();
            await vaultScript(`
              const secrets = new SyncVaultSecretStore();
              let reference;
              new Storage({
                configPath: process.env.INFLOW_AUTH_FILE,
                secretStore: {
                  create(key, value) { reference = key; secrets.create(key, value); },
                  read(key) { return secrets.read(key); },
                  delete(key) { secrets.delete(key); },
                },
              }).setApiKey('missing-test-key');
              secrets.delete(reference);
            `);
            const requestsBeforeFailure = requests;
            for (const args of [
              ['balances', 'list'],
              ['inspect', `${new URL(url).origin}/resource`],
            ]) {
              const failure = await run([...args, '--format', 'json'], environment);
              expect(failure.exitCode).not.toBe(0);
              expect(`${failure.stdout}${failure.stderr}`).toContain('A referenced vault secret is missing.');
              expect(requests).toBe(requestsBeforeFailure);
            }
          },
        );
      } finally {
        const reset = await run(['vault', 'reset', '--force', '--format', 'json'], env);
        expect(reset.exitCode).toBe(0);
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it('mpp decode --format json emits a DECODE_FAILED error envelope on garbage input', async () => {
    const result = await run(['mpp', 'decode', '@@@not-decodable@@@', '--format', 'json']);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('DECODE_FAILED');
  });

  it.each(['mpp', 'x402'] as const)(
    '%s pay completes approval polling and paid replay through the built CLI',
    async (protocol) => {
      const transactionId = '30b929bc-6825-49bc-b279-6c859a81fa15';
      const approvalId = 'b5c8541c-635d-4682-887b-c0bed502d9db';
      const apiKey = 'test-platform-api-key';
      const requestBody = JSON.stringify({ query: 'weather forecast' });
      const responseBody = JSON.stringify({ answer: 'Sunny' });
      const challenge = {
        id: 'test-challenge',
        realm: 'seller.test',
        method: 'inflow',
        intent: 'charge',
        request: encode({ amount: '1', currency: 'USD', methodDetails: { rail: 'balance' } }),
      };
      const credential = encode({
        challenge,
        source: 'did:inflow:09f33b80-fd6d-48a9-b983-ce8f9d09ef3e',
        payload: { approvalId, transactionId, type: 'balance' },
      });
      const accept = {
        scheme: 'balance',
        network: 'inflow:1',
        amount: '1',
        asset: 'USD',
        payTo: '1c239d45-3cc2-4d76-95bc-967c47e19c32',
        maxTimeoutSeconds: 60,
        extra: {},
      } satisfies PaymentRequired['accepts'][number];
      const paymentPayload = { x402Version: 2, accepted: accept, payload: { transactionId } };
      const encodedPayload = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
      const paymentHeader = protocol === 'mpp' ? 'authorization' : 'payment-signature';
      const paymentValue = protocol === 'mpp' ? `Payment ${credential}` : encodedPayload;
      const pending =
        protocol === 'mpp'
          ? { state: 'pending', transactionId, approvalId, retryAfterSeconds: 1, methodSpecific: { rail: 'balance' } }
          : { status: 'INITIATED' };
      const ready =
        protocol === 'mpp'
          ? { state: 'ready', transactionId, credential }
          : { status: 'PENDING', encodedPayload, paymentPayload };
      const events: string[] = [];
      const platformRequests: {
        method: string | undefined;
        path: string | undefined;
        headers: IncomingMessage['headers'];
        body: string;
      }[] = [];
      const sellerRequests: { method: string | undefined; headers: IncomingMessage['headers']; body: string }[] = [];
      let polls = 0;

      await withSeller(
        (req, res) => {
          let body = '';
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8');
          });
          req.on('end', () => {
            platformRequests.push({ method: req.method, path: req.url, headers: req.headers, body });
            res.setHeader('Content-Type', 'application/json');
            if (req.headers['x-api-key'] !== apiKey) {
              res.writeHead(401);
              res.end('{}');
            } else if (protocol === 'x402' && req.method === 'GET' && req.url === '/v1/transactions/x402-supported') {
              res.end(JSON.stringify({ kinds: [{ scheme: 'balance', network: 'inflow:1', x402Version: 2 }] }));
            } else if (req.method === 'POST' && req.url === `/v1/transactions/${protocol}`) {
              events.push('create');
              res.end(
                JSON.stringify(protocol === 'mpp' ? pending : { transactionId, approvalId, approvalStatus: 'PENDING' }),
              );
            } else if (req.method === 'GET' && req.url === `/v1/transactions/${transactionId}/${protocol}`) {
              polls += 1;
              events.push(polls === 1 ? 'poll-pending' : 'poll-ready');
              res.end(JSON.stringify(polls === 1 ? pending : ready));
            } else {
              res.writeHead(404);
              res.end('{}');
            }
          });
        },
        async (platformUrl) => {
          await withSeller(
            (req, res) => {
              let body = '';
              req.on('data', (chunk: Buffer) => {
                body += chunk.toString('utf8');
              });
              req.on('end', () => {
                sellerRequests.push({ method: req.method, headers: req.headers, body });
                if (req.url !== '/paywalled' || req.method !== 'POST') {
                  res.writeHead(404);
                  res.end();
                } else if (req.headers[paymentHeader] === undefined) {
                  events.push('probe');
                  res.writeHead(
                    402,
                    protocol === 'mpp'
                      ? { 'WWW-Authenticate': renderChallengeHeader(challenge) }
                      : {
                          'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
                            x402Version: 2,
                            resource: { url: `http://${req.headers.host}/paywalled`, mimeType: 'application/json' },
                            accepts: [accept],
                          }),
                        },
                  );
                  res.end('payment required');
                } else if (req.headers[paymentHeader] !== paymentValue || polls !== 2) {
                  res.writeHead(403);
                  res.end('unexpected payment proof');
                } else {
                  events.push('replay');
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(responseBody);
                }
              });
            },
            async (sellerUrl) => {
              const result = await run(
                [
                  protocol,
                  'pay',
                  sellerUrl,
                  '--method',
                  'POST',
                  '--data',
                  requestBody,
                  '--header',
                  'X-Request-Context: forecast',
                  '--format',
                  'json',
                  '--interval',
                  '0.01',
                  '--max-attempts',
                  '5',
                  '--timeout',
                  '5',
                ],
                { INFLOW_API_KEY: apiKey, INFLOW_BASE_URL: new URL(platformUrl).origin },
                10_000,
              );

              expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
              expect(`${result.stdout}${result.stderr}`).not.toContain(apiKey);
              const frames: unknown = JSON.parse(result.stdout);
              expect(frames).toMatchObject([
                {
                  transaction_id: transactionId,
                  approval_id: approvalId,
                  ...(protocol === 'mpp'
                    ? { state: 'pending', challenge: { id: challenge.id } }
                    : { scheme: 'balance', network: 'inflow:1', resource: sellerUrl }),
                },
                {
                  outcome: 'paid',
                  transaction_id: transactionId,
                  response_status: 200,
                  response_content_type: 'application/json',
                  body: responseBody,
                  body_size_bytes: Buffer.byteLength(responseBody),
                  ...(protocol === 'mpp'
                    ? { challenge_id: challenge.id, intent: 'charge', credential }
                    : {
                        approval_id: approvalId,
                        scheme: 'balance',
                        network: 'inflow:1',
                        encoded_payload: encodedPayload,
                      }),
                },
              ]);
              expect(events).toEqual(['probe', 'create', 'poll-pending', 'poll-ready', 'probe', 'replay']);
              expect(polls).toBe(2);
              expect(sellerRequests).toHaveLength(3);
              for (const request of sellerRequests) {
                expect(request.method).toBe('POST');
                expect(request.body).toBe(requestBody);
                expect(request.headers['content-type']).toBe('application/json');
                expect(request.headers['x-request-context']).toBe('forecast');
                expect(request.headers['x-api-key']).toBeUndefined();
              }
              expect(sellerRequests[0]?.headers[paymentHeader]).toBeUndefined();
              expect(sellerRequests[1]?.headers[paymentHeader]).toBeUndefined();
              expect(sellerRequests[2]?.headers[paymentHeader]).toBe(paymentValue);
              expect(platformRequests).toHaveLength(protocol === 'mpp' ? 3 : 4);
              for (const request of platformRequests) {
                expect(request.headers['x-api-key']).toBe(apiKey);
                expect(request.headers['x-request-context']).toBeUndefined();
                expect(request.headers['authorization']).toBeUndefined();
                expect(request.headers['payment-signature']).toBeUndefined();
              }
              const submissions = platformRequests.filter((request) => request.method === 'POST');
              expect(submissions).toHaveLength(1);
              expect(submissions[0]?.path).toBe(`/v1/transactions/${protocol}`);
              expect(JSON.parse(submissions[0]?.body ?? '')).toEqual(
                protocol === 'mpp'
                  ? { challenge, options: {} }
                  : { accept, x402Version: 2, resource: { url: sellerUrl, mimeType: 'application/json' } },
              );
            },
          );
        },
      );
    },
  );

  it('mpp pay --format json propagates a delegated generator NO_FILTERED_MATCH error', async () => {
    const header = renderChallengeHeader({
      id: 'chal-1',
      realm: 'mpp.test',
      method: 'inflow',
      intent: 'charge',
      request: encode({ amount: '10', currency: 'USDC', methodDetails: { rail: 'balance' } }),
    });
    await withSeller(
      (_req, res) => {
        res.writeHead(402, { 'WWW-Authenticate': header });
        res.end('payment required');
      },
      async (url) => {
        const result = await run(
          ['mpp', 'pay', url, '--rail', 'instrument', '--format', 'json', '--interval', '0', '--no-show-body'],
          { INFLOW_API_KEY: 'test-api-key' },
        );
        expect(result.exitCode).toBe(1);
        expect(`${result.stdout}${result.stderr}`).toContain('NO_FILTERED_MATCH');
        expect(result.stdout.trim()).not.toBe('[]');
      },
    );
  });

  it('x402 pay --format json propagates a delegated generator NO_FILTERED_MATCH error', async () => {
    const header = encodePaymentRequiredHeader({
      x402Version: 2,
      resource: { url: 'https://seller.test/api', mimeType: 'application/json' },
      accepts: [
        {
          scheme: 'balance',
          network: 'inflow:1',
          amount: '500',
          payTo: 'inflow:abc',
          maxTimeoutSeconds: 60,
          asset: 'USDC',
          extra: {},
        },
      ],
    } satisfies PaymentRequired);
    await withSeller(
      (req, res) => {
        if (req.url === '/v1/transactions/x402-supported') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ kinds: [{ scheme: 'balance', network: 'inflow:1', x402Version: 2 }] }));
          return;
        }
        res.writeHead(402, { 'PAYMENT-REQUIRED': header });
        res.end('payment required');
      },
      async (url) => {
        const result = await run(
          ['x402', 'pay', url, '--scheme', 'exact', '--format', 'json', '--interval', '0', '--no-show-body'],
          { INFLOW_API_KEY: 'test-api-key', INFLOW_BASE_URL: new URL(url).origin },
        );
        expect(result.exitCode).toBe(1);
        expect(`${result.stdout}${result.stderr}`).toContain('NO_FILTERED_MATCH');
        expect(result.stdout.trim()).not.toBe('[]');
      },
    );
  });

  describe('x402 Permit2 offer filtering', () => {
    const exact = {
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '500',
      payTo: '0x0000000000000000000000000000000000000001',
      maxTimeoutSeconds: 60,
      asset: '0x0000000000000000000000000000000000000002',
      extra: { assetTransferMethod: 'eip3009' },
    } satisfies PaymentRequired['accepts'][number];
    const permit2 = { ...exact, extra: { assetTransferMethod: 'permit2' } };
    const upto = { ...exact, scheme: 'upto', extra: {} };
    const solana = {
      ...exact,
      network: 'solana:devnet',
      asset: 'mint',
      extra: { assetTransferMethod: 'solana' },
    } satisfies PaymentRequired['accepts'][number];
    const balance = {
      ...exact,
      scheme: 'balance',
      network: 'inflow:1',
      asset: 'USDC',
      extra: {},
    } satisfies PaymentRequired['accepts'][number];

    for (const command of [['x402', 'inspect'], ['inspect']]) {
      // Inspection uses the credential vault; Linux exercises it through the installed system package.
      it.skipIf(process.platform === 'linux' && packagedExecutable === undefined).each([
        {
          name: 'mixed',
          offers: [permit2, upto, exact, solana, balance],
          retained: [exact, solana, balance],
          mpp: false,
        },
        { name: 'Permit2-only', offers: [permit2, upto], retained: [], mpp: false },
        { name: 'Permit2-only with MPP', offers: [permit2, upto], retained: [], mpp: true },
      ])(`filters $name offers with ${command.join(' ')}`, async ({ offers, retained, mpp }) => {
        const header = encodePaymentRequiredHeader({
          x402Version: 2,
          resource: { url: 'https://seller.test/api' },
          accepts: offers,
        });
        await withSeller(
          (req, res) => {
            if (req.url !== '/paywalled') {
              res.writeHead(404);
              res.end();
              return;
            }
            res.writeHead(402, {
              'PAYMENT-REQUIRED': header,
              ...(mpp
                ? {
                    'WWW-Authenticate': renderChallengeHeader({
                      id: 'test-mpp',
                      realm: 'test',
                      method: 'inflow',
                      intent: 'charge',
                      request: encode({ amount: '10', currency: 'USDC', methodDetails: { rail: 'balance' } }),
                    }),
                  }
                : {}),
            });
            res.end('payment required');
          },
          async (url) => {
            const result = await run([...command, url, '--format', 'json']);
            expect(result.exitCode, `${command.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0);
            const parsed = parseAgentJson(result.stdout);
            const frame: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
            const expected = retained.map(({ scheme, network, asset }) => ({ scheme, network, asset }));
            expect(frame).toMatchObject(command.length === 2 ? { accepts: expected } : { x402: expected });
            if (retained.length === 0) {
              const warnings: unknown = expect.arrayContaining([
                expect.objectContaining({
                  ...(command.length === 1 ? { protocol: 'x402' } : {}),
                  code: 'NO_INFLOW_MATCH',
                  message:
                    'This endpoint only offers Permit2 or upto payments, which InFlow treasury payments cannot authorize.',
                }),
              ]);
              expect(frame).toMatchObject({ warnings });
            } else {
              expect(JSON.stringify(frame)).not.toContain('InFlow treasury payments cannot authorize');
            }
            if (command.length === 1) {
              expect(frame).toMatchObject({
                detected: [...(mpp ? ['mpp'] : []), ...(retained.length === 0 ? [] : ['x402'])],
              });
            }
            const decoded = await run(['x402', 'decode', header, '--format', 'json']);
            expect(decoded.exitCode).toBe(0);
            expect(decoded.stdout).toContain('permit2');
            expect(decoded.stdout).toContain('upto');
          },
        );
      });
    }

    it.each([
      { name: 'Permit2-only', offers: [permit2, upto], scheme: undefined, selected: undefined },
      { name: 'explicit Permit2 exact', offers: [permit2], scheme: 'exact', selected: undefined },
      { name: 'explicit upto', offers: [upto, exact], scheme: 'upto', selected: undefined },
      { name: 'mixed exact', offers: [permit2, upto, exact], scheme: 'exact', selected: exact },
      { name: 'mixed Solana', offers: [permit2, upto, solana], scheme: undefined, selected: solana },
      { name: 'mixed balance', offers: [permit2, upto, balance], scheme: undefined, selected: balance },
    ])(
      'handles $name offers with the real buyer selection and transaction request',
      async ({ offers, scheme, selected }) => {
        const submitted: unknown[] = [];
        const header = encodePaymentRequiredHeader({
          x402Version: 2,
          resource: { url: 'https://seller.test/api' },
          accepts: offers,
        });
        await withSeller(
          (req, res) => {
            if (req.url === '/v1/transactions/x402-supported') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  kinds: offers.map(({ scheme: offerScheme, network }) => ({
                    scheme: offerScheme,
                    network,
                    x402Version: 2,
                  })),
                }),
              );
            } else if (req.url === '/v1/transactions/x402' && req.method === 'POST') {
              let body = '';
              req.on('data', (chunk: Buffer) => {
                body += chunk.toString('utf-8');
              });
              req.on('end', () => {
                submitted.push(JSON.parse(body));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    transactionId: 'test-transaction',
                    approvalId: 'test-approval',
                    approvalStatus: 'PENDING',
                  }),
                );
              });
            } else if (req.url === '/paywalled') {
              res.writeHead(402, { 'PAYMENT-REQUIRED': header });
              res.end('payment required');
            } else {
              res.writeHead(404);
              res.end();
            }
          },
          async (url) => {
            const result = await run(
              [
                'x402',
                'pay',
                url,
                ...(scheme === undefined ? [] : ['--scheme', scheme]),
                '--format',
                'json',
                '--interval',
                '0',
              ],
              { INFLOW_API_KEY: 'test-api-key', INFLOW_BASE_URL: new URL(url).origin },
            );
            expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(selected === undefined ? 1 : 0);
            if (selected === undefined) {
              expect(submitted).toEqual([]);
              expect(`${result.stdout}${result.stderr}`).toContain(
                scheme === undefined ? 'NO_INFLOW_MATCH' : 'NO_FILTERED_MATCH',
              );
            } else {
              expect(submitted).toEqual([expect.objectContaining({ accept: selected })]);
              expect(result.stdout).toContain('test-approval');
            }
          },
        );
      },
    );
  });

  it('x402 decode --format json emits a DECODE_FAILED error envelope on garbage input', async () => {
    const result = await run(['x402', 'decode', 'garbage', '--format', 'json']);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('DECODE_FAILED');
  });

  describe.skipIf(process.env['INFLOW_SMOKE_SANDBOX'] !== '1')('live sandbox', () => {
    it('balances list --format json returns an array', async () => {
      const apiKey = process.env['INFLOW_API_KEY'];
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
