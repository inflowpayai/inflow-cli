#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = resolve(process.env.INFLOW_PACKAGED_EXECUTABLE ?? join(repoRoot, 'dist/macos/bin/inflow'));
const testHome = mkdtempSync('/private/tmp/ifv-');
const vaultRoot = join(testHome, 'Library/Application Support/InFlow');
const socketPath = join(vaultRoot, 'run/vault.sock');
const passphrase = `package-smoke-${process.pid}`;
const apiKey = `inflow_package_smoke_${process.pid}`;
const environment = {
  ...process.env,
  HOME: testHome,
  NO_UPDATE_NOTIFIER: '1',
};

if (process.platform !== 'darwin') throw new Error('The packaged vault smoke requires macOS.');

let server;
let fakeServer;
try {
  await requireDeveloperIdSignature();
  await expectTamperedNativeModuleRejected();
  await expectFakeDaemonRejected();
  const endpoint = await startUserServer();

  await expectJson([executable, 'auth', 'status', '--format', 'json'], { authenticated: false });
  await expectJson([executable, 'vault', 'status', '--format', 'json'], { lock_state: 'not_initialized' });
  await runPty([executable, 'vault', 'unlock'], `${passphrase}\n`, 'Vault initialized and unlocked.');
  await expectJson([executable, 'vault', 'status', '--format', 'json'], { lock_state: 'unlocked' });

  await expectJson([executable, '--api-key', apiKey, '--base-url', endpoint, 'auth', 'login', '--format', 'json'], {
    authenticated: true,
    method: 'api_key',
  });
  await expectJson([executable, 'auth', 'status', '--format', 'json'], {
    auth_method: 'api_key',
    authenticated: true,
  });
  assertSecretsAbsentFromVaultFiles();
  const daemonPid = await expectTaskMemoryReadRejected();
  await expectUnsignedClientRejected();

  await expectJson([executable, 'vault', 'lock', '--format', 'json'], { locked: true });
  await expectJson([executable, 'auth', 'status', '--format', 'json'], {
    authenticated: false,
    vault_locked: true,
  });
  await runPty([executable, 'vault', 'unlock'], `${passphrase}\n`, 'Vault unlocked.');
  await expectJson([executable, 'auth', 'logout', '--format', 'json'], { authenticated: false });
  await waitFor(() => !pathExists(socketPath), 'The packaged vault daemon did not shut down after logout.');
  await waitFor(() => !processExists(daemonPid), 'The packaged vault daemon process did not exit after logout.');

  process.stdout.write('Packaged macOS vault smoke passed.\n');
} finally {
  fakeServer?.close();
  server?.close();
  await runIgnoringFailure([executable, 'vault', 'reset', '--force', '--format', 'json']);
  rmSync(testHome, { force: true, recursive: true });
}

async function expectFakeDaemonRejected() {
  mkdirSync(dirname(socketPath), { mode: 0o700, recursive: true });
  rmSync(socketPath, { force: true });
  fakeServer = createNetServer();
  await new Promise((resolveListen, reject) => {
    fakeServer.once('error', reject);
    fakeServer.listen(socketPath, resolveListen);
  });
  const command = [executable, 'vault', 'lock', '--format', 'json'];
  const result = await run(command);
  await new Promise((resolveClose) => fakeServer.close(resolveClose));
  fakeServer = undefined;
  rmSync(socketPath, { force: true });
  if (result.code === 0 || !`${result.stdout}\n${result.stderr}`.includes('Vault peer verification failed.')) {
    throw commandFailure(command, result);
  }
}

async function requireDeveloperIdSignature() {
  const signature = await run(['/usr/bin/codesign', '-dvv', executable]);
  const entitlements = await run(['/usr/bin/codesign', '-d', '--entitlements', '-', executable]);
  if (
    !signature.stderr.includes('TeamIdentifier=B96U57DTR2') ||
    !signature.stderr.includes('flags=0x10000(runtime)') ||
    entitlements.stdout.includes('com.apple.security.get-task-allow') ||
    entitlements.stderr.includes('com.apple.security.get-task-allow')
  ) {
    throw new Error('The packaged vault smoke requires a hardened InFlow Developer-ID-signed executable.');
  }
}

async function expectTamperedNativeModuleRejected() {
  const nativeModule = join(dirname(realpathSync(executable)), '../Resources/app/native/vault_peer_darwin.node');
  const original = readFileSync(nativeModule);
  const modified = Buffer.from(original);
  modified[0] = (modified[0] ?? 0) ^ 0xff;
  try {
    writeFileSync(nativeModule, modified);
    const result = await run([executable, '--daemon', 'vault']);
    if (result.code === 0 || !result.stderr.includes('Vault native module verification failed.')) {
      throw commandFailure([executable, '--daemon', 'vault'], result);
    }
  } finally {
    writeFileSync(nativeModule, original);
  }
}

function startUserServer() {
  return new Promise((resolveEndpoint, reject) => {
    server = createServer((request, response) => {
      if (request.url !== '/v1/users/self' || request.headers['x-api-key'] !== apiKey) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end('{"code":"unauthorized"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"id":"packaged-smoke-user","email":"packaged-smoke@inflow.test"}');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine the packaged vault smoke server address.'));
        return;
      }
      resolveEndpoint(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function expectJson(command, expected) {
  const result = await run(command);
  if (result.code !== 0) throw commandFailure(command, result);
  const value = JSON.parse(result.stdout);
  const frames = Array.isArray(value) ? value : [value];
  const frame = frames.at(-1);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (frame?.[key] !== expectedValue) {
      throw new Error(`Expected ${key}=${JSON.stringify(expectedValue)} from ${command.join(' ')}.`);
    }
  }
}

async function expectFailure(command, message) {
  const result = await run(command);
  if (result.code === 0 || !`${result.stdout}\n${result.stderr}`.includes(message)) {
    throw commandFailure(command, result);
  }
}

async function runPty(command, input, expectedOutput) {
  const result = await run([
    '/bin/sh',
    '-c',
    'passphrase=$1; shift; printf "%s\\n" "$passphrase" | /usr/bin/script -q /dev/null "$@"',
    'inflow-packaged-vault-smoke',
    input.trimEnd(),
    ...command,
  ]);
  if (result.code !== 0 || !`${result.stdout}\n${result.stderr}`.includes(expectedOutput)) {
    throw commandFailure(command, result);
  }
}

async function expectUnsignedClientRejected() {
  const source = [
    "import { LocalVaultClient } from './packages/core/dist/index.js';",
    'await new LocalVaultClient().status();',
  ].join('');
  const result = await run([process.execPath, '--input-type=module', '-e', source]);
  if (result.code === 0) throw new Error('The packaged vault accepted an unsigned Node client.');
}

async function expectTaskMemoryReadRejected() {
  const probe = join(testHome, 'macos-task-memory-probe');
  const compile = await run([
    '/usr/bin/clang',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-o',
    probe,
    join(repoRoot, 'scripts/macos-task-memory-probe.c'),
  ]);
  if (compile.code !== 0) throw commandFailure(['/usr/bin/clang'], compile);
  const daemonPid = await packagedDaemonPid();
  const result = await run([probe, `${daemonPid}`]);
  if (result.code !== 0) {
    throw new Error(`A same-user process obtained access to packaged daemon memory (probe exit ${result.code}).`);
  }
  return daemonPid;
}

async function packagedDaemonPid() {
  const result = await run(['/bin/ps', '-axo', 'pid=,command=']);
  if (result.code !== 0) throw commandFailure(['/bin/ps'], result);
  const daemonCommand = `${realpathSync(executable)} --daemon vault`;
  const candidates = result.stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.+)$/.exec(line))
    .filter((match) => match !== null && match[2] === daemonCommand)
    .map((match) => Number(match[1]))
    .filter((pid) => processHasOpenPath(pid, socketPath));
  if (candidates.length !== 1) {
    throw new Error(`Expected one packaged vault daemon, found ${candidates.length}.`);
  }
  return candidates[0];
}

function processHasOpenPath(pid, filePath) {
  const result = spawnSync('/usr/sbin/lsof', ['-a', '-p', `${pid}`, '-Fn', filePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 && result.stdout.split('\n').includes(`n${filePath}`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause?.code === 'ESRCH') return false;
    throw cause;
  }
}

function assertSecretsAbsentFromVaultFiles() {
  const secrets = [
    ...sensitiveRepresentations(passphrase, 'unlock factor'),
    ...sensitiveRepresentations(apiKey, 'stored credential'),
  ];
  try {
    for (const file of files(vaultRoot)) {
      const contents = readFileSync(file);
      for (const { bytes, label } of secrets) {
        if (contents.includes(bytes)) throw new Error(`The ${label} was found in ${file}.`);
      }
    }
  } finally {
    for (const { bytes } of secrets) bytes.fill(0);
  }
}

function sensitiveRepresentations(value, label) {
  const bytes = Buffer.from(value, 'utf8');
  return [
    { bytes, label },
    { bytes: Buffer.from(bytes.toString('base64'), 'ascii'), label: `Base64-encoded ${label}` },
    { bytes: Buffer.from(bytes.toString('hex'), 'ascii'), label: `hexadecimal ${label}` },
    { bytes: Buffer.from(value, 'utf16le'), label: `UTF-16 ${label}` },
  ];
}

function files(root) {
  if (!pathExists(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.isFile() ? [path] : [];
  });
}

function pathExists(path) {
  try {
    statSync(path);
    return true;
  } catch (cause) {
    if (cause?.code === 'ENOENT') return false;
    throw cause;
  }
}

async function waitFor(predicate, timeoutMessage) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(timeoutMessage);
}

function run(command, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: repoRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolveRun({
        code: code ?? 1,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
    child.stdin.end(options.input);
  });
}

async function runIgnoringFailure(command) {
  try {
    await run(command);
  } catch {
    return;
  }
}

function commandFailure(command, result) {
  return new Error(
    [
      `Command failed: ${command.join(' ')}`,
      `exit: ${result.code}`,
      `stdout: ${result.stdout.trim()}`,
      `stderr: ${result.stderr.trim()}`,
    ].join('\n'),
  );
}
