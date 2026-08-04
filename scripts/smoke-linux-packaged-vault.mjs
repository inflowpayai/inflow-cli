#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = resolve(process.env.INFLOW_PACKAGED_EXECUTABLE ?? join(repoRoot, 'dist/linux/bin/inflow'));
const testHome = mkdtempSync('/tmp/ifv-');
const vaultRoot = join(testHome, '.local/share/inflow');
const socketPath = join(vaultRoot, 'run/vault.sock');
const passphrase = `package-smoke-${process.pid}`;
const apiKey = `inflow_package_smoke_${process.pid}`;
const environment = {
  ...process.env,
  HOME: testHome,
  NO_UPDATE_NOTIFIER: '1',
};

if (process.platform !== 'linux') throw new Error('The packaged vault smoke requires Linux.');

let server;
let fakeServer;
try {
  assertCliEmbedded();
  await expectTamperedNativeModuleRejected();
  await expectExitedPeerRejected();
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
  assertSecretsAbsentFromDaemonMemory([
    { label: 'unlock factor after store', value: passphrase },
    { label: 'stored credential after store', value: apiKey },
  ]);
  await expectJson([executable, 'auth', 'status', '--format', 'json'], {
    auth_method: 'api_key',
    authenticated: true,
  });
  assertSecretAbsentFromVaultFiles(apiKey);
  assertSecretsAbsentFromDaemonMemory([
    { label: 'unlock factor after read', value: passphrase },
    { label: 'stored credential after read', value: apiKey },
  ]);
  await expectCrossUserSocketRejected();
  await expectNodeClientRejected();

  await expectJson([executable, 'vault', 'lock', '--format', 'json'], { locked: true });
  await expectJson([executable, 'auth', 'status', '--format', 'json'], {
    authenticated: false,
    vault_locked: true,
  });
  await runPty([executable, 'vault', 'unlock'], `${passphrase}\n`, 'Vault unlocked.');
  await expectJson([executable, 'auth', 'logout', '--format', 'json'], { authenticated: false });
  await waitFor(() => !pathExists(socketPath), 'The packaged vault daemon did not shut down after logout.');

  process.stdout.write('Packaged Linux vault smoke passed.\n');
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

async function expectTamperedNativeModuleRejected() {
  const nativeModule = vaultPeerNativeModule();
  const original = readFileSync(nativeModule);
  const modified = Buffer.from(original);
  modified[0] = (modified[0] ?? 0) ^ 0xff;
  try {
    writeFileSync(nativeModule, modified);
    const result = await run([executable, '--daemon', 'vault']);
    if (result.code === 0 || !result.stderr.includes('InFlow runtime integrity verification failed:')) {
      throw commandFailure([executable, '--daemon', 'vault'], result);
    }
  } finally {
    writeFileSync(nativeModule, original);
  }
}

async function expectExitedPeerRejected() {
  const peerSocketPath = join(testHome, 'peer-exit.sock');
  const native = createRequire(import.meta.url)(vaultPeerNativeModule());
  const peerServer = createNetServer({ allowHalfOpen: true });
  let acceptedSocket;
  const accepted = new Promise((resolveAccepted, reject) => {
    peerServer.once('error', reject);
    peerServer.once('connection', (socket) => {
      acceptedSocket = socket;
      resolveAccepted();
    });
  });
  await new Promise((resolveListen, reject) => {
    peerServer.once('error', reject);
    peerServer.listen(peerSocketPath, resolveListen);
  });
  const child = spawn(
    process.execPath,
    [
      '-e',
      "const net=require('node:net');net.createConnection(process.argv[1]);setInterval(()=>{},1000)",
      peerSocketPath,
    ],
    { stdio: 'ignore' },
  );
  try {
    await accepted;
    const childClosed = new Promise((resolveClose, reject) => {
      child.once('error', reject);
      child.once('close', resolveClose);
    });
    child.kill('SIGKILL');
    await childClosed;
    const fd = acceptedSocket?._handle?.fd;
    if (!Number.isSafeInteger(fd) || fd < 0) throw new Error('The accepted peer socket descriptor is unavailable.');
    let rejected = false;
    try {
      native.peerInfo(fd);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error('The native verifier accepted an exited peer process.');
  } finally {
    child.kill('SIGKILL');
    acceptedSocket?.destroy();
    await new Promise((resolveClose) => peerServer.close(resolveClose));
    rmSync(peerSocketPath, { force: true });
  }
}

function assertCliEmbedded() {
  const cliPath = join(dirname(realpathSync(executable)), '../lib/inflow/cli.standalone.mjs');
  if (existsSync(cliPath)) throw new Error('The packaged Linux CLI remains outside the executable.');
}

function vaultPeerNativeModule() {
  return join(dirname(realpathSync(executable)), '../lib/inflow/native/vault_peer_linux.node');
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
  const commandText = command.map(shellQuote).join(' ');
  const result = await run(
    ['/bin/sh', '-c', `printf '%s\\n' "$INFLOW_SMOKE_PASSPHRASE" | script -qec ${shellQuote(commandText)} /dev/null`],
    { environment: { ...environment, INFLOW_SMOKE_PASSPHRASE: input.trimEnd() } },
  );
  if (result.code !== 0 || !`${result.stdout}\n${result.stderr}`.includes(expectedOutput)) {
    throw commandFailure(command, result);
  }
}

async function expectNodeClientRejected() {
  const source = [
    "import { LocalVaultClient } from './packages/core/dist/index.js';",
    'await new LocalVaultClient().status();',
  ].join('');
  const result = await run([process.execPath, '--input-type=module', '-e', source]);
  if (result.code === 0) throw new Error('The packaged vault accepted a Node client with a different executable.');
}

async function expectCrossUserSocketRejected() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    throw new Error('The cross-user vault smoke requires root.');
  }
  const source = [
    "const net = require('node:net');",
    'const socket = net.createConnection(process.argv[1]);',
    "socket.once('connect', () => process.exit(0));",
    "socket.once('error', (cause) => {",
    "process.stderr.write(`${cause.code ?? 'UNKNOWN'}\\n`);",
    'process.exit(2);',
    '});',
  ].join('');
  const result = await run([process.execPath, '-e', source, socketPath], { gid: 65534, uid: 65534 });
  if (result.code !== 2 || !result.stderr.includes('EACCES')) {
    throw new Error(`A different user reached the packaged vault socket.\n${result.stderr}`);
  }
}

function assertSecretAbsentFromVaultFiles(secret) {
  const secretBytes = Buffer.from(secret);
  for (const file of files(vaultRoot)) {
    if (readFileSync(file).includes(secretBytes)) {
      throw new Error(`A plaintext credential was found in ${file}.`);
    }
  }
}

function assertSecretsAbsentFromDaemonMemory(secrets) {
  const pid = packagedDaemonPid();
  const memoryPath = `/proc/${pid}/mem`;
  const descriptor = openSync(memoryPath, 'r');
  const sensitiveValues = secrets.map(({ label, value }) => ({ bytes: Buffer.from(value), label }));
  const longestSecret = Math.max(...sensitiveValues.map(({ bytes }) => bytes.length));
  const chunk = Buffer.alloc(1024 * 1024 + longestSecret - 1);
  try {
    for (const [start, end, mapping] of readableMemoryRanges(pid)) {
      let position = start;
      let overlap = 0;
      while (position < end) {
        const requested = Math.min(1024 * 1024, end - position);
        let bytesRead;
        try {
          bytesRead = readSync(descriptor, chunk, overlap, requested, position);
        } catch (cause) {
          if (cause?.code === 'EIO' || cause?.code === 'EFAULT') break;
          throw cause;
        }
        if (bytesRead === 0) break;
        const populated = overlap + bytesRead;
        for (const { bytes, label } of sensitiveValues) {
          const secretOffset = chunk.subarray(0, populated).indexOf(bytes);
          if (secretOffset >= 0) {
            const prefixOffset = secretOffset - 4;
            const framed = prefixOffset >= 0 && chunk.readUInt32BE(prefixOffset) === bytes.byteLength;
            const address = position - overlap + secretOffset;
            throw new Error(
              `The ${label} remained in daemon memory at process ${pid} address ${address.toString(16)} mapping ${mapping}; attachment frame: ${framed}.`,
            );
          }
        }
        overlap = Math.min(longestSecret - 1, populated);
        chunk.copyWithin(0, populated - overlap, populated);
        chunk.fill(0, overlap, populated);
        position += bytesRead;
      }
      chunk.fill(0);
    }
  } finally {
    chunk.fill(0);
    for (const { bytes } of sensitiveValues) bytes.fill(0);
    closeSync(descriptor);
  }
}

function packagedDaemonPid() {
  const expectedExecutable = realpathSync(executable);
  const candidates = readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => {
      try {
        if (readlinkSync(`/proc/${pid}/exe`) !== expectedExecutable) return false;
        const command = readFileSync(`/proc/${pid}/cmdline`);
        return command.includes(Buffer.from('--daemon\0vault\0'));
      } catch {
        return false;
      }
    });
  if (candidates.length !== 1) {
    throw new Error(`Expected one packaged vault daemon, found ${candidates.length}.`);
  }
  return candidates[0];
}

function readableMemoryRanges(pid) {
  return readFileSync(`/proc/${pid}/maps`, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const match = /^([0-9a-f]+)-([0-9a-f]+)\s+(r...)\s/.exec(line);
      if (match === null) return [];
      const start = Number.parseInt(match[1], 16);
      const end = Number.parseInt(match[2], 16);
      return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start ? [[start, end, line]] : [];
    });
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
      env: options.environment ?? environment,
      ...(options.gid === undefined ? {} : { gid: options.gid }),
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.uid === undefined ? {} : { uid: options.uid }),
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
  });
}

async function runIgnoringFailure(command) {
  try {
    await run(command);
  } catch {
    return;
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
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
