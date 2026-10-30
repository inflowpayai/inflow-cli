import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.env.INFLOW_DISPOSABLE_CONTAINER !== '1') {
  throw new Error('Run only as root in a disposable Linux test container with INFLOW_DISPOSABLE_CONTAINER=1.');
}
if (existsSync('/run/systemd/system')) throw new Error('This test requires Linux without a systemd manager.');

const executable = '/opt/inflow/bin/inflow';
const launcher = '/opt/inflow/lib/inflow/vault-launcher';
const lock = '/run/inflow/service.lock';
const socket = '/run/inflow/vault.sock';
const env = { PATH: '/usr/bin:/bin', HOME: '/tmp', NO_UPDATE_NOTIFIER: '1' };

function run(file, args, success = true) {
  const result = spawnSync(file, args, { encoding: 'utf8', env, timeout: 20000 });
  if (success) assert.equal(result.status, 0, `${file} ${args.join(' ')}: ${result.stdout}${result.stderr}`);
  else assert.notEqual(result.status, 0);
  return result;
}

function user(args, success = true) {
  return run(
    '/usr/bin/setpriv',
    [
      '--reuid=1001',
      '--regid=1001',
      '--clear-groups',
      '--bounding-set=-all',
      '--inh-caps=-all',
      '--ambient-caps=-all',
      '--no-new-privs',
      executable,
      ...args,
    ],
    success,
  );
}

function start() {
  return run(executable, ['vault', 'service', 'start', '--format', 'json']);
}
function stop() {
  run(launcher, ['--stop']);
}
function identity() {
  return readFileSync(lock, 'utf8');
}

function concurrentStart() {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['vault', 'service', 'start', '--format', 'json'], { env, timeout: 20000 });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
  });
}

async function stopWithActiveVaultClient() {
  const client = spawn(executable, ['--mcp'], { env });
  const exited = once(client, 'exit');
  const lines = createInterface({ input: client.stdout });
  const responses = lines[Symbol.asyncIterator]();
  let stderr = '';
  client.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => client.kill('SIGTERM'), 20000);
  async function request(id, method, params) {
    client.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (;;) {
      const line = await responses.next();
      assert.equal(line.done, false, `MCP exited before response: ${stderr}`);
      const response = JSON.parse(line.value);
      if (response.id !== id) continue;
      assert.equal(response.error, undefined, JSON.stringify(response));
      return response.result;
    }
  }
  try {
    await request(1, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'vault-lifecycle-test', version: '1' },
    });
    client.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const result = await request(2, 'tools/call', { name: 'vault_status', arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.match(JSON.stringify(result), /lock_state/);
    stop();
  } finally {
    clearTimeout(timeout);
    lines.close();
    client.stdin.end();
    client.kill('SIGTERM');
    await exited;
  }
}

try {
  start();
  const first = identity();
  start();
  assert.equal(identity(), first, 'Repeated start must not replace the broker.');
  assert.match(
    user(['vault', 'service', 'start', '--format', 'json'], false).stdout,
    /sudo inflow vault service start/,
  );
  user(['vault', 'status', '--format', 'json']);
  const pid = first.split(' ')[0];
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  assert.match(status, /CapEff:\s+00000000000800c0/);
  assert.match(status, /CapBnd:\s+00000000000800c0/);
  assert.match(status, /CapAmb:\s+0000000000000000/);
  assert.match(status, /NoNewPrivs:\s+1/);
  assert.match(status, /Seccomp:\s+2/);
  await stopWithActiveVaultClient();
  const began = Date.now();
  const missing = user(['vault', 'status', '--format', 'json'], false);
  assert.match(missing.stderr + missing.stdout, /sudo inflow vault service start/);
  assert.ok(Date.now() - began < 3000, 'Missing service must not incur the systemd startup wait.');
  await Promise.all([concurrentStart(), concurrentStart(), concurrentStart()]);
  user(['vault', 'status', '--format', 'json']);
  stop();
  renameSync(socket, `${socket}.test-backup`);
  try {
    symlinkSync('/tmp/inflow-no-touch', socket);
    run(executable, ['vault', 'service', 'start', '--format', 'json'], false);
    assert.ok(!existsSync('/tmp/inflow-no-touch'));
  } finally {
    unlinkSync(socket);
    renameSync(`${socket}.test-backup`, socket);
  }
  renameSync(lock, `${lock}.test-backup`);
  try {
    symlinkSync('/tmp/inflow-no-touch', lock);
    run(executable, ['vault', 'service', 'start', '--format', 'json'], false);
    assert.ok(!existsSync('/tmp/inflow-no-touch'));
  } finally {
    unlinkSync(lock);
    renameSync(`${lock}.test-backup`, lock);
  }
  start();
  assert.notEqual(identity(), first, 'Explicit restart must replace the stopped process.');
  user(['vault', 'status', '--format', 'json']);
  console.log(
    'Packaged non-systemd startup, ordinary-user access, confinement, concurrency, hostile paths and restart passed.',
  );
} catch (failure) {
  try {
    stop();
  } catch (cleanupFailure) {
    throw new AggregateError([failure, cleanupFailure], 'Vault lifecycle test and cleanup failed.');
  }
  throw failure;
}
stop();
