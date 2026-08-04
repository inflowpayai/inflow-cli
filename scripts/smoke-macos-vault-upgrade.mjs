#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const previousApp = requiredPath('INFLOW_PREVIOUS_PACKAGED_APP');
const currentApp = requiredPath('INFLOW_CURRENT_PACKAGED_APP');
const testHome = mkdtempSync('/private/tmp/ifv-transition-');
const installedApp = join(testHome, 'Applications/InFlow.app');
const executable = join(installedApp, 'Contents/MacOS/inflow');
const vaultRoot = join(testHome, 'Library/Application Support/InFlow');
const socketPath = join(vaultRoot, 'run/vault.sock');
const passphrase = `transition-passphrase-${process.pid}`;
const apiKey = `inflow_transition_key_${process.pid}`;
const environment = {
  ...process.env,
  HOME: testHome,
  NO_UPDATE_NOTIFIER: '1',
};

let server;
try {
  requireDistinctSignedApps();
  installApp(previousApp);
  const endpoint = await startUserServer();

  await runPty([executable, 'vault', 'unlock'], passphrase, 'Vault initialized and unlocked.');
  await expectJson([executable, '--api-key', apiKey, '--base-url', endpoint, 'auth', 'login', '--format', 'json'], {
    authenticated: true,
    method: 'api_key',
  });
  await expectAuthenticated();
  const previousPid = packagedDaemonPid();

  installApp(currentApp);
  await expectJson([executable, 'auth', 'status', '--format', 'json'], {
    authenticated: false,
    vault_locked: true,
  });
  await waitFor(() => !processExists(previousPid), 'The previous daemon remained alive after upgrade.');
  const currentPid = packagedDaemonPid();
  await runPty([executable, 'vault', 'unlock'], passphrase, 'Vault unlocked.');
  await expectAuthenticated();
  await expectLockUnlock();
  assertSecretsAbsentFromVaultFiles();

  installApp(previousApp);
  await expectJson([executable, 'vault', 'lock', '--format', 'json'], { locked: true });
  await waitFor(() => !processExists(currentPid), 'The current daemon remained alive after downgrade.');
  const downgradedPid = packagedDaemonPid();
  await runPty([executable, 'vault', 'unlock'], passphrase, 'Vault unlocked.');
  await expectAuthenticated();
  await expectLockUnlock();

  installApp(currentApp);
  await expectJson([executable, 'auth', 'status', '--format', 'json'], {
    authenticated: false,
    vault_locked: true,
  });
  await waitFor(() => !processExists(downgradedPid), 'The downgraded daemon remained alive after re-upgrade.');
  const finalPid = packagedDaemonPid();
  await runPty([executable, 'vault', 'unlock'], passphrase, 'Vault unlocked.');
  await expectAuthenticated();
  await expectJson([executable, 'auth', 'logout', '--format', 'json'], { authenticated: false });
  await waitFor(() => !processExists(finalPid), 'The final daemon remained alive after logout.');
  await waitFor(() => !pathExists(socketPath), 'The final daemon socket remained after logout.');

  process.stdout.write('Packaged macOS vault upgrade and downgrade smoke passed.\n');
} finally {
  server?.close();
  await runIgnoringFailure([executable, 'vault', 'reset', '--force', '--format', 'json']);
  rmSync(testHome, { force: true, recursive: true });
}

function requiredPath(name) {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is required.`);
  return realpathSync(resolve(value));
}

function requireDistinctSignedApps() {
  const executables = [previousApp, currentApp].map((app) => join(app, 'Contents/MacOS/inflow'));
  const digests = executables.map((path) => createHash('sha256').update(readFileSync(path)).digest('hex'));
  if (digests[0] === digests[1]) throw new Error('Transition executables must have different build identities.');
  for (const path of executables) {
    const result = spawnSync('/usr/bin/codesign', ['-dvv', path], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stderr.includes('TeamIdentifier=B96U57DTR2')) {
      throw new Error(`The transition executable is not signed by the expected team: ${path}`);
    }
  }
}

function installApp(source) {
  rmSync(installedApp, { force: true, recursive: true });
  const result = spawnSync('/usr/bin/ditto', [source, installedApp], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not install ${source}: ${result.stderr}`);
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
      response.end('{"id":"transition-user","email":"transition@inflow.test"}');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine the transition server address.'));
        return;
      }
      resolveEndpoint(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function expectAuthenticated() {
  await expectJson([executable, 'auth', 'status', '--format', 'json'], {
    auth_method: 'api_key',
    authenticated: true,
  });
}

async function expectLockUnlock() {
  await expectJson([executable, 'vault', 'lock', '--format', 'json'], { locked: true });
  await expectJson([executable, 'auth', 'status', '--format', 'json'], {
    authenticated: false,
    vault_locked: true,
  });
  await runPty([executable, 'vault', 'unlock'], passphrase, 'Vault unlocked.');
  await expectAuthenticated();
}

async function expectJson(command, expected) {
  const result = await run(command);
  if (result.code !== 0) throw commandFailure(command, result);
  const value = JSON.parse(result.stdout);
  const frame = (Array.isArray(value) ? value : [value]).at(-1);
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
    'inflow-macos-transition-smoke',
    input,
    ...command,
  ]);
  if (result.code !== 0 || !`${result.stdout}\n${result.stderr}`.includes(expectedOutput)) {
    throw commandFailure(command, result);
  }
}

function packagedDaemonPid() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not inspect daemon processes for ${executable}.`);
  const daemonCommand = `${realpathSync(executable)} --daemon vault`;
  const candidates = result.stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.+)$/.exec(line))
    .filter((match) => match !== null && match[2] === daemonCommand)
    .map((match) => Number(match[1]))
    .filter((pid) => processHasOpenPath(pid, socketPath));
  if (candidates.length !== 1) throw new Error(`Expected one daemon for ${executable}, found ${candidates.length}.`);
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
  const representations = [passphrase, apiKey].flatMap((value) => {
    const bytes = Buffer.from(value, 'utf8');
    return [
      bytes,
      Buffer.from(bytes.toString('base64'), 'ascii'),
      Buffer.from(bytes.toString('hex'), 'ascii'),
      Buffer.from(bytes.toString('hex').toUpperCase(), 'ascii'),
      Buffer.from(value, 'utf16le'),
    ];
  });
  try {
    for (const file of files(vaultRoot)) {
      const contents = readFileSync(file);
      if (representations.some((representation) => contents.includes(representation))) {
        throw new Error(`A transition secret was found in ${file}.`);
      }
    }
  } finally {
    for (const representation of representations) representation.fill(0);
  }
}

function files(root) {
  if (!pathExists(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.isFile() && statSync(path).isFile() ? [path] : [];
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

function run(command) {
  return new Promise((resolveResult) => {
    const child = spawn(command[0], command.slice(1), {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      resolveResult({ code: code ?? -1, stderr, stdout });
    });
  });
}

async function runIgnoringFailure(command) {
  try {
    await run(command);
  } catch {
    return;
  }
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(message);
}

function commandFailure(command, result) {
  return new Error(
    [`Command failed: ${command.join(' ')}`, `exit: ${result.code}`, result.stdout, result.stderr]
      .filter(Boolean)
      .join('\n'),
  );
}
